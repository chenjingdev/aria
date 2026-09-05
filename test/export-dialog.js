// GUI folder selection contract; native dialogs are replaced with an async chooser.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createTestSoundfonts } from "./soundfont-fixture.js";

const soundfonts = createTestSoundfonts("aria-export-dialog");
const isolatedHome = path.join(soundfonts.root, "home");
const selectedDirectory = path.join(soundfonts.root, "선택한 폴더 ' \" $ `");
const untrustedDirectory = path.join(soundfonts.root, "untrusted");
fs.mkdirSync(isolatedHome);
fs.mkdirSync(selectedDirectory);

// Isolate even accidental fallback writes without changing the user's HOME env.
const originalHomedir = os.homedir;
os.homedir = () => isolatedHome;
process.env.ARIA_DATA_DIR = soundfonts.dataDir;
process.env.ARIA_RUNTIME_FILE = path.join(soundfonts.dataDir, "runtime.json");
process.env.ARIA_SF2 = soundfonts.defaultPath;
process.env.ARIA_PACKS_DIR = path.join(soundfonts.root, "packs");
process.env.ARIA_SFIZZ_ENGINE_HOME = path.join(soundfonts.root, "sfizz");
process.env.ARIA_SCAN = "0";
process.env.ARIA_AUTOSTART = "0";

let web;
let passed = 0;
let chooserCalls = 0;
let choose = async () => selectedDirectory;

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server?.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function unusedPort() {
  for (;;) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await close(server);
    if (port !== 7788 && port <= 65515) return port;
  }
}

function filesIn(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(filename) : [filename];
  }).sort();
}

async function rpc(args, { headers, signal = AbortSignal.timeout(30_000) } = {}) {
  const response = await fetch(`${web.url}/api/rpc`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({ tool: "export", args })
  });
  return { status: response.status, ...(await response.json()) };
}

async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("aria GUI export folder tests");

try {
  process.env.ARIA_PORT = String(await unusedPort());
  const { state } = await import("../src/core.js");
  const { createSong, validateSong } = await import("../src/song.js");
  const { readRuntime } = await import("../src/runtime.js");
  const { startWeb } = await import("../src/web.js");
  web = await startWeb({
    chooseExportDirectory: options => { chooserCalls++; return choose(options); }
  });
  const song = createSong({ title: "폴더 테스트", bpm: 240 });
  song.tracks.push({
    name: "Piano", preset: "sf-piano-gm", volume: 0.8, pan: 0,
    notes: [{ bar: 1, beat: 0, pitch: "C4", dur: 0.25, vel: 90 }]
  });
  state.song = validateSong(song);
  const filenameBase = "폴더-테스트";

  await check("MIDI uses the selected folder and rejects client-supplied paths", async () => {
    const result = await rpc({
      format: "midi", choose_folder: true,
      path: path.join(untrustedDirectory, "client-file"), directory: untrustedDirectory
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.readFileSync(path.join(selectedDirectory, `${filenameBase}.mid`)).toString("ascii", 0, 4), "MThd");
    assert.equal(fs.existsSync(untrustedDirectory), false);
    assert.deepEqual(filesIn(isolatedHome), []);
  });

  await check("WAV range naming and stems stay inside the selected folder", async () => {
    const wav = await rpc({ format: "wav", choose_folder: true, from_bar: 1, to_bar: 1 });
    assert.equal(wav.ok, true, wav.error);
    const audio = fs.readFileSync(path.join(selectedDirectory, `${filenameBase}-1-1마디.wav`));
    assert.equal(audio.toString("ascii", 0, 4), "RIFF");
    assert.equal(audio.toString("ascii", 8, 12), "WAVE");
    assert.ok(audio.length > 44);
    const stems = await rpc({ stems: true, choose_folder: true, from_bar: 1, to_bar: 1 });
    assert.equal(stems.ok, true, stems.error);
    const stem = path.join(selectedDirectory, `${filenameBase}-스템`, "01-Piano.wav");
    assert.equal(fs.readFileSync(stem).toString("ascii", 8, 12), "WAVE");
  });

  await check("MP3 exports only a compressed audio file in the chosen folder", async () => {
    const before = filesIn(soundfonts.root);
    const result = await rpc({ format: "mp3", choose_folder: true, from_bar: 1, to_bar: 1 });
    assert.equal(result.ok, true, result.error);
    const filename = path.join(selectedDirectory, `${filenameBase}-1-1마디.mp3`);
    assert.deepEqual(filesIn(soundfonts.root).filter(file => !before.includes(file)), [filename]);
    assert.ok(fs.statSync(filename).size > 1000);
    assert.match(result.result, /\.mp3 .*320kbps/);
    assert.doesNotMatch(result.result, /\.mid\b|\.wav\b/);
  });

  await check("cancelling a folder picker creates no export and does not log success", async () => {
    choose = async () => null;
    const before = filesIn(soundfonts.root);
    const logLength = state.log.length;
    for (const format of ["midi", "mp3"]) {
      const result = await rpc({ format, choose_folder: true });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.cancelled, true);
    }
    assert.deepEqual(filesIn(soundfonts.root), before);
    assert.equal(state.log.length, logLength);
  });

  await check("picker failure does not fall back to default output", async () => {
    choose = async () => { throw new Error("picker failed for test"); };
    const before = filesIn(soundfonts.root);
    const result = await rpc({ format: "midi", choose_folder: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /picker failed for test/);
    assert.deepEqual(filesIn(soundfonts.root), before);
  });

  await check("invalid exports and cross-origin requests never open a picker", async () => {
    choose = async () => selectedDirectory;
    const before = chooserCalls;
    const invalid = await rpc({ format: "invalid", choose_folder: true });
    assert.equal(invalid.ok, false);
    const crossOrigin = await rpc({ format: "midi", choose_folder: true }, {
      headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://example.invalid" }
    });
    assert.equal(crossOrigin.status, 403);
    const currentSong = state.song;
    state.song = null;
    const noSong = await rpc({ format: "midi", choose_folder: true });
    assert.equal(noSong.ok, false);
    state.song = createSong({ title: "empty" });
    const empty = await rpc({ format: "midi", choose_folder: true });
    assert.equal(empty.ok, false);
    state.song = currentSong;
    assert.equal(chooserCalls, before);
  });

  await check("only one picker opens while other HTTP requests remain responsive", async () => {
    const opened = deferred(), selection = deferred();
    choose = () => { opened.resolve(); return selection.promise; };
    const pending = rpc({ format: "midi", choose_folder: true });
    await opened.promise;
    const calls = chooserCalls;
    const second = await rpc({ format: "midi", choose_folder: true });
    assert.equal(second.ok, false);
    assert.equal(chooserCalls, calls);
    const health = await fetch(`${web.url}/api/health`, { signal: AbortSignal.timeout(2000) });
    assert.equal(health.status, 200);
    selection.resolve(selectedDirectory);
    assert.equal((await pending).ok, true);
  });

  await check("a song edited during selection is not silently exported", async () => {
    const opened = deferred(), selection = deferred();
    choose = () => { opened.resolve(); return selection.promise; };
    const before = filesIn(soundfonts.root);
    const pending = rpc({ format: "midi", choose_folder: true });
    await opened.promise;
    const previousTitle = state.song.title;
    state.song.title = "changed while choosing";
    selection.resolve(selectedDirectory);
    const result = await pending;
    state.song.title = previousTitle;
    assert.equal(result.ok, false);
    assert.deepEqual(filesIn(soundfonts.root), before);
  });

  await check("disconnect aborts the pending picker and allows another export", async () => {
    const opened = deferred(), aborted = deferred();
    choose = ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted.resolve();
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
      opened.resolve();
    });
    const controller = new AbortController();
    const pending = rpc({ format: "midi", choose_folder: true }, { signal: controller.signal })
      .then(() => assert.fail("disconnected request unexpectedly completed"), error => {
        assert.equal(error.name, "AbortError");
      });
    await opened.promise;
    controller.abort();
    await pending;
    await Promise.race([
      aborted.promise,
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("picker was not aborted on disconnect")), 3000);
        timer.unref();
        aborted.promise.then(() => clearTimeout(timer));
      })
    ]);
    choose = async () => selectedDirectory;
    const next = await rpc({ format: "midi", choose_folder: true });
    assert.equal(next.ok, true, next.error);
  });

  await check("authenticated MCP exports retain explicit paths without showing a picker", async () => {
    const calls = chooserCalls;
    const output = path.join(soundfonts.root, "mcp", "chosen-name");
    const result = await rpc({ format: "midi", path: output }, {
      headers: { Authorization: `Bearer ${readRuntime().bridgeToken}` }
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.readFileSync(`${output}.mid`).toString("ascii", 0, 4), "MThd");
    assert.equal(chooserCalls, calls);
  });

  await check("legacy GUI requests still cannot supply an arbitrary output directory", async () => {
    const calls = chooserCalls;
    const result = await rpc({
      format: "midi", directory: untrustedDirectory, path: path.join(untrustedDirectory, "file")
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.existsSync(untrustedDirectory), false);
    assert.equal(fs.existsSync(path.join(isolatedHome, "Music", "aria", `${filenameBase}.mid`)), true);
    assert.equal(chooserCalls, calls);
  });

  console.log(`\n${passed} GUI export folder checks passed`);
} finally {
  await close(web?.server);
  os.homedir = originalHomedir;
  soundfonts.cleanup();
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTestSoundfonts } from "./soundfont-fixture.js";

const fixture = createTestSoundfonts("aria-sound-setup");
process.env.ARIA_SF2 = path.join(fixture.root, "installed", "default.sf2");
process.env.ARIA_DATA_DIR = fixture.dataDir;
process.env.ARIA_RUNTIME_FILE = path.join(fixture.dataDir, "runtime.json");
process.env.ARIA_PACKS_DIR = path.join(fixture.root, "packs");
process.env.ARIA_PACK_HOME = process.env.ARIA_PACKS_DIR;
process.env.ARIA_SFIZZ_ENGINE_HOME = path.join(fixture.root, "engine");
process.env.ARIA_SCAN = "0";
process.env.ARIA_PORT = "18878";

const { startWeb } = await import("../src/web.js");
const { soundSetupStatus, importBasicSoundfont } = await import("../src/sound-setup.js");
const { state } = await import("../src/core.js");
let picked = null, selections = 0, pendingPicker = null;
const app = await startWeb({ chooseSoundFile: async ({ signal }) => {
  selections++;
  if (pendingPicker) return new Promise((resolve, reject) => {
    pendingPicker.resolve = resolve;
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });
  return picked;
} });
const post = (route, options = {}) => fetch(app.url + route, { method: "POST", ...options });
try {
  assert.equal(soundSetupStatus().basic.available, 0);
  assert.equal(soundSetupStatus().sfizz.ready, false);
  assert.ok(soundSetupStatus().basic.total > 0);
  let response = await post("/api/sound-setup/import");
  assert.equal((await response.json()).cancelled, true);
  assert.equal(fs.existsSync(process.env.ARIA_SF2), false);

  const before = selections;
  response = await post("/api/sound-setup/import", { headers: { Origin: "https://example.com" } });
  assert.equal(response.status, 403);
  response = await post("/api/packs/import?id=../../bad");
  assert.ok(response.status >= 400);
  assert.equal(selections, before);

  const bad = path.join(fixture.root, "broken.sf2");
  fs.writeFileSync(bad, "not a soundfont");
  assert.throws(() => importBasicSoundfont(bad), /기본 악기를 모두/);
  assert.equal(fs.existsSync(process.env.ARIA_SF2), false);
  assert.deepEqual(fs.readdirSync(path.dirname(process.env.ARIA_SF2)), []);
  assert.throws(() => importBasicSoundfont(path.join(fixture.root, "download.zip")), /압축을 풀고/);

  pendingPicker = {};
  const first = post("/api/sound-setup/import");
  while (!pendingPicker.resolve) await new Promise(resolve => setTimeout(resolve, 5));
  response = await post("/api/sound-setup/import");
  assert.ok(response.status >= 400);
  pendingPicker.resolve(null);
  assert.equal((await (await first).json()).cancelled, true);
  pendingPicker = null;

  picked = fixture.defaultPath;
  response = await post("/api/sound-setup/import", {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: bad })
  });
  const installed = await response.json();
  assert.equal(installed.setup.basic.ready, true, JSON.stringify(installed));
  const contents = fs.readFileSync(process.env.ARIA_SF2);
  assert.deepEqual(contents, fs.readFileSync(picked));
  assert.throws(() => importBasicSoundfont(bad), /덮어쓰지/);
  assert.deepEqual(fs.readFileSync(process.env.ARIA_SF2), contents);

  const songBefore = JSON.stringify(state.song);
  response = await post("/api/sound-setup/preview");
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("content-type"), "audio/wav");
  const wav = Buffer.from(await response.arrayBuffer());
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.ok(wav.length > 44);
  assert.equal(JSON.stringify(state.song), songBefore);
  // The selected archive must reach the existing pinned-checksum installer. A
  // wrong local file must fail, without downloading a replacement or publishing.
  response = await post("/api/packs/import?id=vsco2-ce");
  assert.equal((await response.json()).pack.id, "vsco2-ce");
  let pack;
  const deadline = Date.now() + 10000;
  do {
    const result = await (await fetch(app.url + "/api/packs")).json();
    pack = result.packs.find(p => p.id === "vsco2-ce");
    if (!pack.installing) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(pack.state, "error", JSON.stringify(pack));
  assert.equal(pack.installed, false);
  assert.match(JSON.stringify(pack.status), /checksum|SHA256/i);
  console.log("Sound setup passed: empty install, cancellation, origin checks, picker serialization, corrupt/ZIP rejection, native path only, atomic no-overwrite, real WAV preview without song edits, selected archive checksum rejection.");
} finally {
  await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections?.(); });
  fixture.cleanup();
}

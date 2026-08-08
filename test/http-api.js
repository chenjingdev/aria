import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `aria-http-api-${process.pid}-`));
const isolatedHome = path.join(temporary, "home");
const dataDir = path.join(temporary, "data");
const packHome = path.join(isolatedHome, ".aria", "packs");
const runtimeFile = path.join(dataDir, "runtime.json");

fs.mkdirSync(packHome, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

// All Aria paths are fixed at module evaluation time, so isolate them before the
// first application import. This test must never inspect or modify the user's Aria data.
process.env.HOME = isolatedHome;
process.env.ARIA_DATA_DIR = dataDir;
process.env.ARIA_RUNTIME_FILE = runtimeFile;
process.env.ARIA_PACKS_DIR = packHome;
process.env.ARIA_PACK_HOME = packHome;
process.env.ARIA_SF2 = path.join(isolatedHome, ".aria", "soundfonts", "missing.sf2");
process.env.ARIA_SFIZZ_ENGINE_HOME = path.join(isolatedHome, ".aria", "engines", "sfizz");
process.env.ARIA_SCAN = "0";
process.env.ARIA_AUTOSTART = "0";

let web;
let passed = 0;

function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server?.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function unusedLoopbackPort() {
  for (;;) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await closeServer(server);
    // runtime.js reserves at most 21 consecutive ports and validates this upper bound.
    if (port !== 7788 && port <= 65515) return port;
  }
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000)
  });
  assert.equal(response.status, 200, `${pathname} returned HTTP ${response.status}`);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i,
    `${pathname} did not return JSON`);
  return response.json();
}

function publishManagedSalamanderFixture() {
  const manifestFile = path.join(projectRoot, "packs", "salamander-drumkit-sfz.json");
  const manifestRaw = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  const target = path.join(packHome, manifest.installDir);
  const staging = `${target}.stage-${process.pid}-${crypto.randomUUID()}`;
  fs.mkdirSync(staging, { recursive: true });

  let totalBytes = 0;
  const entries = manifest.content.entryFiles.map((relative, index) => {
    const file = path.resolve(staging, relative);
    const inside = path.relative(staging, file);
    assert.ok(inside && !inside.startsWith("..") && !path.isAbsolute(inside),
      `unsafe fixture entry path: ${relative}`);
    const contents = Buffer.from([
      `// isolated HTTP contract fixture ${index + 1}`,
      "<region> key=60 sample=*silence",
      ""
    ].join("\n"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    totalBytes += contents.length;
    return { path: relative, size: contents.length, sha256: sha256(contents) };
  });

  const metadata = {
    schemaVersion: 1,
    packId: manifest.id,
    name: manifest.name,
    format: manifest.format,
    installDir: manifest.installDir,
    manifestSha256: sha256(manifestRaw),
    source: {
      type: manifest.source.type,
      repositoryUrl: manifest.source.repositoryUrl,
      branch: manifest.source.branch,
      commit: manifest.source.commit,
      tree: manifest.source.tree
    },
    license: {
      spdx: manifest.license.spdx,
      file: manifest.license.file,
      sha256: manifest.license.sha256
    },
    entries,
    verification: { totalBytes, audioFiles: 0 }
  };
  fs.writeFileSync(path.join(staging, ".aria-pack.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600
  });

  // Model the installer's final publication step. The running web process must see
  // this new managed pack on its next request without being restarted.
  fs.renameSync(staging, target);
  return { manifest, target };
}

console.log("aria HTTP API contract tests");

try {
  process.env.ARIA_PORT = String(await unusedLoopbackPort());
  const { startWeb } = await import("../src/web.js");
  web = await startWeb();

  const healthBefore = await getJson(web.url, "/api/health");
  const metaBefore = await getJson(web.url, "/api/meta");
  const packsBefore = await getJson(web.url, "/api/packs");

  check("runtime, HOME, pack storage, and port are isolated", () => {
    assert.notEqual(web.port, 7788);
    assert.equal(web.port, Number(new URL(web.url).port));
    assert.equal(healthBefore.instanceId, web.instanceId);
    assert.equal(healthBefore.baseUrl, web.url);
    assert.ok(fs.existsSync(runtimeFile), "isolated runtime descriptor was not published");
    assert.ok(!fs.existsSync(path.join(dataDir, "song.json")), "HTTP metadata reads wrote a song autosave");
  });

  const presetEntries = Object.entries(metaBefore.presets ?? {});
  const drumEntries = Object.entries(metaBefore.drumKits ?? {});
  const allEntries = [...presetEntries, ...drumEntries];

  check("/api/meta exposes normalized public kind and lossless assetKind", () => {
    assert.ok(presetEntries.length > 0, "presets is empty");
    assert.ok(drumEntries.length > 0, "drumKits is empty");
    const publicKinds = new Set();
    const assetKinds = new Set();
    for (const [id, item] of allEntries) {
      assert.ok(isRecord(item), `${id} is not an object`);
      assert.ok(["instrument", "percussion", "clip"].includes(item.kind),
        `${id} has non-public kind ${item.kind}`);
      assert.equal(typeof item.assetKind, "string", `${id}.assetKind is not a string`);
      assert.ok(item.assetKind.length > 0, `${id}.assetKind is empty`);
      publicKinds.add(item.kind);
      assetKinds.add(item.assetKind);
    }
    assert.deepEqual([...publicKinds].sort(), ["clip", "instrument", "percussion"]);
    for (const expected of ["instrument", "pitched-instrument", "drum-kit", "drum-module", "one-shot", "clip"])
      assert.ok(assetKinds.has(expected), `assetKind ${expected} is not represented`);
  });

  check("/api/meta exposes articulation maps and their defaults", () => {
    for (const [id, item] of allEntries) {
      assert.ok(Object.hasOwn(item, "articulations"), `${id}.articulations is omitted`);
      assert.ok(Object.hasOwn(item, "defaultArticulation"), `${id}.defaultArticulation is omitted`);
      assert.ok(item.articulations === null || isRecord(item.articulations),
        `${id}.articulations must be an object or null`);
      assert.ok(item.defaultArticulation === null ||
        (typeof item.defaultArticulation === "string" && item.defaultArticulation.length > 0),
      `${id}.defaultArticulation must be a non-empty string or null`);
    }

    const articulated = allEntries.filter(([, item]) => item.articulations !== null);
    assert.ok(articulated.length > 0, "no articulated preset exercises the public contract");
    for (const [id, item] of articulated) {
      assert.ok(Object.keys(item.articulations).length > 0, `${id}.articulations is empty`);
      assert.equal(typeof item.defaultArticulation, "string", `${id} has no default articulation`);
      assert.ok(Object.hasOwn(item.articulations, item.defaultArticulation),
        `${id}.defaultArticulation does not select an articulation`);
      for (const [articulationId, definition] of Object.entries(item.articulations)) {
        assert.ok(isRecord(definition), `${id}.${articulationId} is not an object`);
        assert.equal(typeof definition.label, "string", `${id}.${articulationId}.label is missing`);
      }
    }
  });

  check("/api/meta keeps pieces and clip durations machine-readable", () => {
    for (const [id, item] of presetEntries)
      assert.equal(item.pieces, null, `${id} instrument unexpectedly exposes percussion pieces`);

    for (const [id, item] of drumEntries) {
      assert.ok(Array.isArray(item.pieces) && item.pieces.length > 0, `${id}.pieces is not a non-empty array`);
      assert.equal(new Set(item.pieces).size, item.pieces.length, `${id}.pieces contains duplicates`);
      for (const piece of item.pieces)
        assert.ok(typeof piece === "string" && piece.length > 0, `${id} has an invalid piece ID`);
      assert.ok(item.durationSec === null || (Number.isFinite(item.durationSec) && item.durationSec > 0),
        `${id}.durationSec must be a positive number or null`);
    }

    const clips = drumEntries.filter(([, item]) => item.kind === "clip");
    assert.ok(clips.length > 0, "no clip exercises the public contract");
    for (const [id, item] of clips) {
      assert.equal(item.assetKind, "clip", `${id} lost its raw clip kind`);
      assert.deepEqual(item.pieces, ["play"], `${id} does not expose a single play trigger`);
      assert.ok(Number.isFinite(item.durationSec) && item.durationSec > 0,
        `${id}.durationSec is not a positive JSON number`);
    }
  });

  check("/api/packs exposes all registered packs with an isolated status shape", () => {
    assert.ok(Array.isArray(packsBefore.packs), "packs is not an array");
    assert.deepEqual(packsBefore.packs.map(pack => pack.id).sort(), [
      "philharmonia-all-sfz", "salamander-drumkit-sfz", "vsco2-ce"
    ]);
    for (const pack of packsBefore.packs) {
      assert.equal(typeof pack.name, "string");
      assert.equal(pack.format, "sfz");
      assert.equal(pack.state, "missing", `${pack.id} leaked a non-isolated install state`);
      assert.equal(pack.installed, false);
      assert.equal(pack.installing, false);
      assert.equal(path.dirname(pack.target), packHome, `${pack.id} target escaped isolated pack HOME`);
      assert.ok(Number.isInteger(pack.entries) && pack.entries > 0, `${pack.id}.entries is invalid`);
      assert.ok(Number.isInteger(pack.audioFiles) && pack.audioFiles > 0, `${pack.id}.audioFiles is invalid`);
      assert.ok(isRecord(pack.license) && typeof pack.license.spdx === "string",
        `${pack.id}.license is invalid`);
      assert.ok(pack.sourceUrl === null || typeof pack.sourceUrl === "string");
    }
  });

  check("isolated pack starts unavailable before publication", () => {
    const pack = packsBefore.packs.find(item => item.id === "salamander-drumkit-sfz");
    assert.equal(pack?.state, "missing");
    assert.equal(metaBefore.drumKits?.["salamander-all-full"]?.available, false);
    assert.equal(metaBefore.drumKits?.["salamander-kick-raw-take"]?.available, false);
  });

  const fixture = publishManagedSalamanderFixture();
  const packsAfter = await getJson(web.url, "/api/packs");
  const metaAfter = await getJson(web.url, "/api/meta");
  const healthAfter = await getJson(web.url, "/api/health");

  check("the same server observes atomic pack publication on the next request", () => {
    assert.equal(healthAfter.instanceId, healthBefore.instanceId, "server restarted during state refresh");
    assert.equal(web.server.listening, true);

    const pack = packsAfter.packs.find(item => item.id === fixture.manifest.id);
    assert.equal(pack?.state, "ready");
    assert.equal(pack?.installed, true);
    assert.equal(pack?.installing, false);
    assert.equal(pack?.target, fixture.target);
    assert.ok(Number.isInteger(pack?.installedBytes) && pack.installedBytes > 0);

    const kit = metaAfter.drumKits?.["salamander-all-full"];
    const clip = metaAfter.drumKits?.["salamander-kick-raw-take"];
    assert.equal(kit?.available, true, "newly published kit remains unavailable in /api/meta");
    assert.equal(clip?.available, true, "newly published clip remains unavailable in /api/meta");
    assert.equal(kit?.issue, null);
    assert.equal(clip?.issue, null);
    assert.ok(Array.isArray(kit?.pieces) && kit.pieces.includes("kick-1"));
    assert.deepEqual(clip?.pieces, ["play"]);
    assert.ok(Number.isFinite(clip?.durationSec) && clip.durationSec > 40);
  });
} finally {
  await closeServer(web?.server);
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`passed ${passed} checks — HTTP API contract is stable`);

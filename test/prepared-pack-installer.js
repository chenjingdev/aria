import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicPublishPrepared, loadPreparedManifest } from "../tools/install-prepared-pack.mjs";
import { installerForPackManifest } from "../src/packs.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(projectRoot, "tools", "install-prepared-pack.mjs");
const preparer = path.join(projectRoot, "test", "fixtures", "prepare-archive-pack.mjs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `aria-prepared-pack-${process.pid}-`));
const officialArchive = path.join(temporary, "official-fixture.bin");
const cachedArchive = path.join(temporary, "downloads", "official-fixture.bin");
const manifestFile = path.join(temporary, "prepared-fixture.json");
let passed = 0;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function prepare(output, archive = officialArchive) {
  const result = spawnSync(process.execPath, [preparer, "--archive", archive, "--output", output], {
    cwd: projectRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return output;
}

function writeManifest(prepared, overrides = {}) {
  const archiveSha256 = sha256(fs.readFileSync(officialArchive));
  const tree = sha256(fs.readFileSync(path.join(prepared, "catalog", "checksums.json")));
  const licenseSha256 = sha256(fs.readFileSync(path.join(prepared, "LICENSE")));
  const base = {
    schemaVersion: 1,
    id: "prepared-fixture",
    name: "Prepared Fixture Pack",
    format: "sfz",
    installDir: "prepared-fixture-sfz",
    source: {
      type: "prepared-archive",
      repositoryUrl: "https://example.invalid/prepared-fixture",
      projectUrl: "https://example.invalid/prepared-fixture",
      releaseUrl: "https://example.invalid/prepared-fixture/archive-v1",
      branch: null,
      commit: archiveSha256,
      tree,
      archiveSha256,
      prepareScript: "test/fixtures/prepare-archive-pack.mjs",
      defaultArchive: cachedArchive
    },
    license: {
      spdx: "LicenseRef-Fixture-Terms",
      name: "Fixture redistribution terms",
      file: "LICENSE",
      url: "https://example.invalid/prepared-fixture/terms",
      sha256: licenseSha256
    },
    content: {
      checksumsFile: "catalog/checksums.json",
      entryFiles: ["sfz/Instrument.sfz"],
      audioExtensions: [".wav"],
      expectedPayloadFiles: 3,
      expectedAudioFiles: 1
    },
    catalog: [{
      id: "prepared-fixture-instrument",
      path: "sfz/Instrument.sfz",
      name: "Fixture Instrument",
      family: "Fixture",
      articulation: "sustain",
      label: "Sustain (서스테인) — 음을 길게 유지",
      source: "Prepared Fixture",
      kind: "pitched-instrument",
      gm: { bank: 0, program: 0 },
      drum: false,
      release: 0.8
    }]
  };
  const manifest = {
    ...base,
    ...overrides,
    source: { ...base.source, ...(overrides.source ?? {}) },
    license: { ...base.license, ...(overrides.license ?? {}) },
    content: { ...base.content, ...(overrides.content ?? {}) }
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function invoke(home, ...args) {
  return spawnSync(process.execPath, [installer, manifestFile, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ARIA_PACKS_DIR: home,
      ARIA_PACK_HOME: path.join(temporary, "ignored-pack-home")
    }
  });
}

function invokeAsync(home, ...args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [installer, manifestFile, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ARIA_PACKS_DIR: home,
        ARIA_PACK_HOME: path.join(temporary, "ignored-pack-home")
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => resolve({ status: null, stdout, stderr: `${stderr}${error.stack ?? error}` }));
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function startArchiveServer(file) {
  const server = http.createServer((request, response) => {
    if (request.url !== "/official.bin") {
      response.writeHead(404).end();
      return;
    }
    const data = fs.readFileSync(file);
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
    response.end(data);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/official.bin`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

try {
  console.log("prepared archive pack installer tests");
  fs.writeFileSync(officialArchive, Buffer.from("RIFF deterministic official archive fixture\n"));
  fs.mkdirSync(path.dirname(cachedArchive), { recursive: true });
  fs.copyFileSync(officialArchive, cachedArchive);
  const baseline = prepare(path.join(temporary, "prepared-baseline"));
  const manifest = writeManifest(baseline);

  check("selects separate Git and prepared-archive installers", () => {
    assert.equal(path.basename(installerForPackManifest({ source: { type: "git" } })), "install-pack.mjs");
    assert.equal(path.basename(installerForPackManifest({ source: { type: "prepared-archive" } })),
      "install-prepared-pack.mjs");
    assert.throws(() => installerForPackManifest({ source: { type: "unknown" } }), /지원하지 않는/);
  });

  await checkAsync("adopts a generated pack without mutating it and writes strict runtime metadata", async () => {
    const home = path.join(temporary, "packs-adopt");
    const sourcePackBefore = fs.readFileSync(path.join(baseline, "pack.json"));
    const result = invoke(home, "--adopt", baseline);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(fs.readFileSync(path.join(baseline, "pack.json")), sourcePackBefore);
    const target = path.join(home, manifest.installDir);
    const metadata = readJson(path.join(target, ".aria-pack.json"));
    assert.equal(metadata.packId, manifest.id);
    assert.equal(metadata.name, manifest.name);
    assert.equal(metadata.format, manifest.format);
    assert.equal(metadata.installDir, manifest.installDir);
    assert.equal(metadata.source.type, "prepared-archive");
    assert.equal(metadata.source.repositoryUrl, manifest.source.repositoryUrl);
    assert.equal(metadata.source.branch, null);
    assert.equal(metadata.source.commit, manifest.source.commit);
    assert.equal(metadata.source.tree, manifest.source.tree);
    assert.equal(metadata.license.spdx, manifest.license.spdx);
    assert.equal(metadata.license.file, manifest.license.file);
    assert.equal(metadata.license.sha256, manifest.license.sha256);
    assert.deepEqual(Object.keys(metadata.entries[0]), ["path", "size", "sha256"]);
    assert.equal(metadata.entries[0].path, "sfz/Instrument.sfz");
    assert.equal(metadata.installMode, "adopt");
    assert.equal(fs.existsSync(path.join(target, ".git")), false);
  });

  await checkAsync("prepares from a cached official archive and validates cache checksums on reuse", async () => {
    const home = path.join(temporary, "packs-cached-archive");
    const first = invoke(home);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const target = path.join(home, manifest.installDir);
    assert.deepEqual(fs.readFileSync(path.join(target, "samples", "tone.wav")), fs.readFileSync(officialArchive));
    const second = invoke(home);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(readJson(path.join(home, ".status", `${manifest.id}.json`)).fromCache, true);
  });

  await checkAsync("downloads a missing official archive and verifies SHA-256 before preparation", async () => {
    const serverFile = path.join(temporary, "served-official.bin");
    fs.copyFileSync(officialArchive, serverFile);
    const server = await startArchiveServer(serverFile);
    try {
      const downloadTarget = path.join(temporary, "download-test", "official.bin");
      writeManifest(baseline, { source: { defaultArchive: downloadTarget, downloadUrl: server.url } });
      const home = path.join(temporary, "packs-download");
      const result = await invokeAsync(home);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(fs.readFileSync(downloadTarget), fs.readFileSync(officialArchive));
      assert.equal(readJson(path.join(home, manifest.installDir, ".aria-pack.json")).installMode, "prepare");
    } finally {
      await server.close();
    }
  });

  await checkAsync("rejects tampered, extra, and symlinked prepared payloads", async () => {
    writeManifest(baseline);
    const cases = [
      ["tampered", output => fs.writeFileSync(path.join(output, "samples", "tone.wav"), "changed")],
      ["extra", output => fs.writeFileSync(path.join(output, "unlisted.bin"), "extra")],
      ["symlink", output => {
        fs.rmSync(path.join(output, "samples", "tone.wav"));
        fs.symlinkSync(officialArchive, path.join(output, "samples", "tone.wav"));
      }]
    ];
    for (const [name, mutate] of cases) {
      const output = prepare(path.join(temporary, `prepared-${name}`));
      mutate(output);
      const home = path.join(temporary, `packs-reject-${name}`);
      const result = invoke(home, "--adopt", output);
      assert.notEqual(result.status, 0, `${name} should fail`);
      assert.equal(fs.existsSync(path.join(home, manifest.installDir)), false);
      assert.equal(readJson(path.join(home, ".status", `${manifest.id}.json`)).state, "error");
    }
  });

  await checkAsync("keeps the previous target when a replacement archive fails checksum verification", async () => {
    const serverFile = path.join(temporary, "served-changing.bin");
    fs.copyFileSync(officialArchive, serverFile);
    const server = await startArchiveServer(serverFile);
    try {
      const downloadTarget = path.join(temporary, "rollback-download", "official.bin");
      writeManifest(baseline, { source: { defaultArchive: downloadTarget, downloadUrl: server.url } });
      const home = path.join(temporary, "packs-preserve-old");
      const first = await invokeAsync(home);
      assert.equal(first.status, 0, first.stderr || first.stdout);
      const target = path.join(home, manifest.installDir);
      const metadataBefore = fs.readFileSync(path.join(target, ".aria-pack.json"));
      fs.writeFileSync(path.join(target, "samples", "tone.wav"), "old target intentionally invalid but preserved");
      const oldPayload = fs.readFileSync(path.join(target, "samples", "tone.wav"));
      fs.rmSync(downloadTarget);
      fs.writeFileSync(serverFile, "wrong archive bytes");
      const second = await invokeAsync(home);
      assert.notEqual(second.status, 0);
      assert.deepEqual(fs.readFileSync(path.join(target, ".aria-pack.json")), metadataBefore);
      assert.deepEqual(fs.readFileSync(path.join(target, "samples", "tone.wav")), oldPayload);
      assert.equal(readJson(path.join(home, ".status", `${manifest.id}.json`)).error.code,
        "ARCHIVE_CHECKSUM_MISMATCH");
    } finally {
      await server.close();
    }
  });

  await checkAsync("rolls back an already-renamed target if post-publish validation fails", async () => {
    const root = path.join(temporary, "atomic-publish");
    const target = path.join(root, "target");
    const stage = path.join(root, "stage");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(target, "marker"), "old");
    fs.writeFileSync(path.join(stage, "marker"), "new");
    await assert.rejects(() => atomicPublishPrepared(stage, target, async () => {
      throw new Error("post-publish validation failed");
    }), /post-publish validation failed/);
    assert.equal(fs.readFileSync(path.join(target, "marker"), "utf8"), "old");
    assert.equal(fs.readFileSync(path.join(stage, "marker"), "utf8"), "new");
  });

  check("ARIA_PACKS_DIR remains preferred over ARIA_PACK_HOME", () => {
    assert.equal(fs.existsSync(path.join(temporary, "ignored-pack-home")), false);
  });

  check("rejects timing-incomplete catalog fixtures before pack adoption", () => {
    const drumEntry = kind => ({
      id: "prepared-fixture-drum",
      path: "sfz/Instrument.sfz",
      name: "Fixture Drum",
      family: "Fixture",
      articulation: "one-shot",
      label: "One Shot (원샷) — 원음을 끝까지 재생",
      source: "Prepared Fixture",
      kind,
      gm: { bank: 128, program: 0 },
      drum: true,
      durationSec: 1.25,
      maxSampleDurationSec: 1.25,
      tailHintSec: 0.5,
      release: 0.3,
      pieces: [{
        id: "hit",
        key: 60,
        name: "Hit",
        label: "Hit (타격)",
        sampleStem: "tone",
        durationSec: 1.25
      }]
    });
    const pitchedEntry = () => structuredClone(manifest.catalog[0]);
    const cases = [
      ["drum without pieces", () => {
        const entry = drumEntry("drum-kit");
        delete entry.pieces;
        return entry;
      }, /pieces/],
      ["drum piece without a measured duration", () => {
        const entry = drumEntry("drum-kit");
        delete entry.pieces[0].durationSec;
        return entry;
      }, /pieces\[0\]\.durationSec/],
      ["clip without a recorded duration", () => {
        const entry = drumEntry("clip");
        delete entry.durationSec;
        return entry;
      }, /catalog\[0\]\.durationSec/],
      ["clip without a tail guard", () => {
        const entry = drumEntry("clip");
        delete entry.tailHintSec;
        return entry;
      }, /tailHintSec/],
      ["clip with an invalid release", () => ({ ...drumEntry("clip"), release: -0.1 }), /release/],
      ["clip whose play piece disagrees with its recorded duration", () => {
        const entry = drumEntry("clip");
        entry.pieces[0].durationSec = 1;
        return entry;
      }, /clip piece durationSec/],
      ["pitched instrument with a one-shot duration", () => ({ ...pitchedEntry(), durationSec: 1.25 }),
        /durationSec is only valid/],
      ["pitched instrument without an explicit release", () => {
        const entry = pitchedEntry();
        delete entry.release;
        return entry;
      }, /release/]
    ];
    for (const [name, makeEntry, message] of cases) {
      writeManifest(baseline, { catalog: [makeEntry()] });
      assert.throws(() => loadPreparedManifest(manifestFile), error => {
        assert.equal(error?.code, "MANIFEST_INVALID", name);
        assert.match(error.message, message, name);
        return true;
      }, name);
    }
  });

  console.log(`\n${passed}/${passed} prepared archive pack installer tests passed`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

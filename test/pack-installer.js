import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(projectRoot, "tools", "install-pack.mjs");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `aria-pack-installer-${process.pid}-`));
const source = path.join(temporaryRoot, "source");
const remote = path.join(temporaryRoot, "fixture.git");
const manifestFile = path.join(temporaryRoot, "fixture-pack.json");
const packHome = path.join(temporaryRoot, "packs-download");
const installDir = "fixture-sfz";
const sampleContents = Buffer.from("RIFF fixture sample contents");
let passed = 0;

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

function run(program, args, cwd = projectRoot) {
  return execFileSync(program, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function invoke(home, ...args) {
  return spawnSync(process.execPath, [installer, manifestFile, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ARIA_PACKS_DIR: home, ARIA_PACK_HOME: path.join(temporaryRoot, "ignored-pack-home") }
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeManifest(overrides = {}) {
  const commit = run("git", ["rev-parse", "HEAD"], source);
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], source);
  const license = fs.readFileSync(path.join(source, "LICENSE"));
  const manifest = {
    schemaVersion: 1,
    id: "fixture-pack",
    name: "Fixture SFZ Pack",
    format: "sfz",
    installDir,
    source: {
      type: "git",
      repositoryUrl: remote,
      projectUrl: "https://example.invalid/fixture-pack",
      releaseUrl: "https://example.invalid/fixture-pack/releases/1",
      branch: "Fixture",
      commit,
      tree
    },
    license: {
      spdx: "CC0-1.0",
      name: "CC0 fixture",
      file: "LICENSE",
      url: "https://example.invalid/fixture-pack/LICENSE",
      sha256: sha256(license)
    },
    content: {
      expectedTrackedFiles: 4,
      expectedAudioFiles: 2,
      expectedSampleReferences: 1,
      audioExtensions: [".wav"],
      entryFiles: ["Instrument.sfz"]
    },
    ...overrides
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

try {
  console.log("sample-pack installer tests");
  fs.mkdirSync(path.join(source, "Samples"), { recursive: true });
  fs.writeFileSync(path.join(source, "LICENSE"), "CC0 fixture license\n");
  fs.writeFileSync(path.join(source, "Instrument.sfz"), [
    "<control>",
    "default_path=Samples\\",
    "<region>",
    "sample=tone.wav",
    "key=60",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(source, "Samples", "tone.wav"), sampleContents);
  fs.writeFileSync(path.join(source, "Samples", "unused.wav"), Buffer.from("RIFF official but unreferenced"));
  run("git", ["init", "--quiet", "--initial-branch=Fixture", source]);
  run("git", ["config", "user.name", "Aria pack test"], source);
  run("git", ["config", "user.email", "aria-pack-test@example.invalid"], source);
  run("git", ["add", "."], source);
  run("git", ["commit", "--quiet", "-m", "fixture"], source);
  run("git", ["clone", "--quiet", "--bare", source, remote], temporaryRoot);
  const manifest = writeManifest();

  check("VSCO prepared manifest pins the complete catalog and percussion key map", () => {
    const vsco = readJson(path.join(projectRoot, "packs", "vsco2-ce.json"));
    assert.equal(vsco.source.type, "prepared-archive");
    assert.equal(vsco.source.officialCommit, "6dd651d55dde97fd4028699be9d4481f26917891");
    assert.equal(vsco.source.officialTree, "553ef3b90c87fe43ef19a3a8f8965a4a2945d570");
    assert.equal(vsco.license.spdx, "CC0-1.0");
    assert.equal(vsco.catalogMetadata.officialEntryFiles, 75);
    assert.equal(vsco.catalogMetadata.supplementalGeneratedEntries,
      vsco.catalogMetadata.supplementalEntries + vsco.catalogMetadata.duplicateAliasEntries);
    assert.equal(vsco.content.entryFiles.length, vsco.catalog.length);
    assert.deepEqual(new Set(vsco.catalog.map(item => item.path)), new Set(vsco.content.entryFiles));
    const drums = vsco.catalog.find(item => item.path === "GM-StylePerc.sfz");
    assert.ok(drums?.drum);
    assert.equal(drums.pieces.length, 52);
    assert.equal(new Set(drums.pieces.map(piece => piece.key)).size, 52);
    assert.ok(drums.pieces.every(piece => Number.isFinite(piece.durationSec) && piece.durationSec > 0));
    assert.equal(drums.pieces.find(piece => piece.id === "kick")?.key, 36);
    assert.equal(drums.pieces.find(piece => piece.id === "snare")?.key, 38);
  });

  await checkAsync("downloads one exact shallow commit and publishes without .git", async () => {
    const result = invoke(packHome);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const target = path.join(packHome, installDir);
    assert.equal(fs.existsSync(path.join(target, ".git")), false);
    assert.deepEqual(fs.readFileSync(path.join(target, "Samples", "tone.wav")), sampleContents);
    const metadata = readJson(path.join(target, ".aria-pack.json"));
    assert.equal(metadata.packId, manifest.id);
    assert.equal(metadata.source.commit, manifest.source.commit);
    assert.equal(metadata.source.tree, manifest.source.tree);
    assert.equal(metadata.installMode, "download");
    assert.equal(metadata.entries.length, 1);
    assert.deepEqual(Object.keys(metadata.entries[0]), ["path", "size", "sha256"]);
    assert.equal(metadata.entries[0].path, "Instrument.sfz");
    assert.equal(metadata.files.length, 4);
    assert.equal(metadata.verification.audioFiles, 2);
    assert.equal(metadata.verification.sampleReferences, 1);
  });

  await checkAsync("validates every cached checksum before reuse", async () => {
    const result = invoke(packHome);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const status = readJson(path.join(packHome, ".status", `${manifest.id}.json`));
    assert.equal(status.state, "ready");
    assert.equal(status.fromCache, true);
  });

  await checkAsync("repairs a corrupted cache from the same pinned source", async () => {
    const targetSample = path.join(packHome, installDir, "Samples", "tone.wav");
    fs.writeFileSync(targetSample, "corrupt");
    const result = invoke(packHome);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(fs.readFileSync(targetSample), sampleContents);
    const status = readJson(path.join(packHome, ".status", `${manifest.id}.json`));
    assert.equal(status.fromCache, false);
  });

  await checkAsync("leaves the previous target intact when replacement cannot be fetched", async () => {
    const target = path.join(packHome, installDir);
    const metadataBefore = fs.readFileSync(path.join(target, ".aria-pack.json"));
    const sampleBefore = fs.readFileSync(path.join(target, "Samples", "tone.wav"));
    writeManifest({
      source: { ...manifest.source, commit: "0000000000000000000000000000000000000000" }
    });
    const result = invoke(packHome);
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readFileSync(path.join(target, ".aria-pack.json")), metadataBefore);
    assert.deepEqual(fs.readFileSync(path.join(target, "Samples", "tone.wav")), sampleBefore);
    const status = readJson(path.join(packHome, ".status", `${manifest.id}.json`));
    assert.equal(status.state, "error");
    writeManifest();
  });

  await checkAsync("verify-source is read-only and publishes no target", async () => {
    const verifyHome = path.join(temporaryRoot, "packs-verify");
    const result = invoke(verifyHome, "--verify-source", source);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(verifyHome, installDir)), false);
    assert.equal(fs.existsSync(path.join(source, ".git")), true);
    assert.equal(readJson(path.join(verifyHome, ".status", `${manifest.id}.json`)).state, "verified");
  });

  await checkAsync("adopts the exact in-place clone without contacting its remote", async () => {
    const adoptHome = path.join(temporaryRoot, "packs-adopt");
    const adoptTarget = path.join(adoptHome, installDir);
    fs.mkdirSync(adoptHome, { recursive: true });
    run("git", ["clone", "--quiet", "--branch", "Fixture", remote, adoptTarget], temporaryRoot);
    const before = fs.readFileSync(path.join(adoptTarget, "Samples", "tone.wav"));
    fs.rmSync(remote, { recursive: true, force: true });
    const result = invoke(adoptHome, "--adopt", adoptTarget);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(adoptTarget, ".git")), false);
    assert.deepEqual(fs.readFileSync(path.join(adoptTarget, "Samples", "tone.wav")), before);
    assert.equal(readJson(path.join(adoptTarget, ".aria-pack.json")).installMode, "adopt");
    assert.equal(readJson(path.join(adoptHome, ".status", `${manifest.id}.json`)).state, "ready");
  });

  check("ARIA_PACKS_DIR takes precedence over ARIA_PACK_HOME", () => {
    assert.equal(fs.existsSync(path.join(packHome, installDir)), true);
    assert.equal(fs.existsSync(path.join(temporaryRoot, "ignored-pack-home", installDir)), false);
  });

  console.log(`\n${passed}/${passed} pack installer tests passed`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

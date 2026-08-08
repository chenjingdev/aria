#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSfizzSession } from "../src/sfizz-engine.js";
import {
  inspectSfzReferences, readWavInfo, verifyPreparedVsco, VSCO_IDENTITY
} from "../tools/prepare-vsco2-ce-sfz.mjs";
import { buildVscoManifest } from "../tools/build-vsco-complete-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = process.env.ARIA_VSCO_SOURCE_ROOT ?? path.join(os.homedir(), ".aria", "packs", "vsco2-ce-sfz");
const PREPARED_CANDIDATE = path.join(os.homedir(), ".aria", "prepared", "vsco2-ce-complete-v9");
const INSTALLED_COMPLETE = fs.existsSync(path.join(SOURCE, "pack.json")) ? SOURCE : null;
const PREPARED = process.env.ARIA_VSCO_PREPARED_ROOT ??
  (fs.existsSync(PREPARED_CANDIDATE) ? PREPARED_CANDIDATE : INSTALLED_COMPLETE ?? PREPARED_CANDIDATE);
const REBUILT = process.env.ARIA_VSCO_REBUILT_ROOT ?? path.join(os.homedir(), ".aria", "prepared", "vsco2-ce-complete-v10");
let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}`); throw error; }
};

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walkNoLinks(root) {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, `symlink: ${file}`);
      assert.ok(stat.isDirectory() || stat.isFile(), `special file: ${file}`);
      if (stat.isDirectory()) visit(file);
      else files.push(path.relative(root, file).split(path.sep).join("/"));
    }
  };
  visit(root);
  return files.sort();
}

function peak(channel) {
  let value = 0;
  for (const sample of channel) value = Math.max(value, Math.abs(sample));
  return value;
}

function lastAudibleFloat(channel, threshold = 1 / 65536) {
  for (let index = channel.length - 1; index >= 0; index--)
    if (Math.abs(channel[index]) > threshold) return index;
  return -1;
}

function sourceLastAudibleFrame(file) {
  const buffer = fs.readFileSync(file);
  let format = null, data = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4), bytes = buffer.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + bytes;
    if (id === "fmt " && bytes >= 16) format = {
      encoding: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2),
      blockAlign: buffer.readUInt16LE(start + 12), bits: buffer.readUInt16LE(start + 14)
    };
    if (id === "data") data = { start, end };
    offset = end + (bytes & 1);
  }
  assert.ok(format && data);
  const bytes = format.bits / 8;
  const value = offset => {
    if (format.encoding === 3 && format.bits === 32) return buffer.readFloatLE(offset);
    if (format.encoding === 1 && format.bits === 16) return buffer.readInt16LE(offset) / 32768;
    if (format.encoding === 1 && format.bits === 24) return buffer.readIntLE(offset, 3) / 8388608;
    if (format.encoding === 1 && format.bits === 32) return buffer.readInt32LE(offset) / 2147483648;
    throw new Error(`unsupported source WAV ${format.encoding}/${format.bits}`);
  };
  const frames = Math.floor((data.end - data.start) / format.blockAlign);
  for (let frame = frames - 1; frame >= 0; frame--) {
    const base = data.start + frame * format.blockAlign;
    if (base + format.blockAlign > data.end) continue;
    for (let channel = 0; channel < format.channels; channel++)
      if (Math.abs(value(base + channel * bytes)) > 1 / 65536) return frame;
  }
  return -1;
}

console.log("VSCO 2 CE complete preparation");

await check("matches sfizz sequential default_path behavior and rejects root escape", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "aria-vsco-parser-"));
  try {
    fs.mkdirSync(path.join(temporary, "audio"));
    fs.writeFileSync(path.join(temporary, "audio", "one.wav"), Buffer.from("x"));
    fs.writeFileSync(path.join(temporary, "entry.sfz"),
      "<control> default_path=audio/\n<region> sample=one.wav key=60 pitch_keycenter=60\n");
    const result = inspectSfzReferences(temporary, ["entry.sfz"]);
    assert.deepEqual(result.references, ["audio/one.wav"]);
    assert.equal(result.regions[0].pitchKeycenter, 60);
    fs.writeFileSync(path.join(temporary, "escape.sfz"), "<region> sample=../../outside.wav key=60\n");
    assert.throws(() => inspectSfzReferences(temporary, ["escape.sfz"]), error => error.code === "PATH_ESCAPE");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

if (!fs.existsSync(PREPARED)) {
  console.log(`  - full prepared pack not found; exhaustive checks skipped: ${PREPARED}`);
  console.log(`\n${passed} VSCO preparation tests passed (fixture-only)`);
  process.exit(0);
}

const baseManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "packs", "vsco2-ce.json"), "utf8"));
const officialEntries = baseManifest.content.entryFiles.filter(file => !file.startsWith("sfz-extra/"));
const runtime = JSON.parse(fs.readFileSync(path.join(PREPARED, "catalog", "runtime.json"), "utf8"));

await check("independently proves 3163 lines = 2034 unique and 1134 upstream-unmapped WAVs", () => {
  const official = inspectSfzReferences(SOURCE, officialEntries);
  const wav = walkNoLinks(SOURCE).filter(file => file.toLowerCase().endsWith(".wav"));
  assert.equal(official.references.length, VSCO_IDENTITY.officialSampleReferenceLines);
  assert.equal(official.uniqueReferences.size, VSCO_IDENTITY.officialUniqueReferencedSamples);
  assert.equal(wav.length, VSCO_IDENTITY.wavFiles);
  assert.equal(wav.filter(file => !official.uniqueReferences.has(file)).length, VSCO_IDENTITY.officialUnreferencedSamples);
});

await check("preserves all 75 official definitions byte-for-byte", () => {
  assert.equal(officialEntries.length, 75);
  for (const entry of officialEntries)
    assert.equal(sha256(path.join(PREPARED, entry)), sha256(path.join(SOURCE, entry)), entry);
});

await check("has no links/special files and checksum inventory covers every payload exactly", () => {
  const files = walkNoLinks(PREPARED);
  const checksums = JSON.parse(fs.readFileSync(path.join(PREPARED, "catalog", "checksums.json"), "utf8"));
  const reserved = new Set(["pack.json", "catalog/checksums.json"]);
  assert.deepEqual(files.filter(file => !reserved.has(file)), checksums.map(record => record.file));
  assert.equal(new Set(checksums.map(record => record.file)).size, checksums.length);
});

if (fs.existsSync(REBUILT)) {
  await check("rebuilds deterministically from archive and verified managed source", () => {
    assert.deepEqual(
      fs.readFileSync(path.join(PREPARED, "catalog", "checksums.json")),
      fs.readFileSync(path.join(REBUILT, "catalog", "checksums.json"))
    );
    assert.equal(
      sha256(path.join(PREPARED, "catalog", "checksums.json")),
      sha256(path.join(REBUILT, "catalog", "checksums.json"))
    );
  });
}

await check("maps all 3168 WAVs with zero missing/unmapped and complete key/velocity partitions", () => {
  const verified = verifyPreparedVsco(PREPARED, officialEntries);
  assert.equal(verified.audioFiles, 3168);
  assert.equal(verified.uniqueReferencedAudio, 3168);
  assert.equal(verified.missingReferences, 0);
  assert.equal(verified.unmappedAudio, 0);
  assert.equal(verified.velocityHoles, 0);
  assert.equal(verified.invalidKeyRanges, 0);
});

await check("retains stable official IDs and gives every generated runtime entry complete metadata", () => {
  const manifest = buildVscoManifest(PREPARED, baseManifest);
  assert.equal(manifest.catalogMetadata.supplementalGeneratedEntries, runtime.length);
  assert.equal(manifest.catalog.length + manifest.catalogMetadata.duplicateAliasEntries,
    officialEntries.length + runtime.length,
    "byte-identical clip aliases must remain accounted for after control-level deduplication");
  const oldIds = new Map((baseManifest.catalog ?? []).filter(entry => officialEntries.includes(entry.path)).map(entry => [entry.path, entry.id]));
  for (const entry of manifest.catalog.slice(0, 75)) assert.equal(entry.id, oldIds.get(entry.path));
  for (const entry of manifest.catalog) {
    assert.ok(entry.kind && entry.source === "VSCO 2 CE" && entry.family && entry.articulation && entry.gm);
    assert.ok(entry.maxSampleDurationSec > 0 && entry.tailHintSec >= 0);
    if (entry.kind === "pitched-instrument") assert.equal(entry.tailHintSec, entry.release);
    else {
      assert.equal(entry.tailHintSec, 0.5, "clip tail is only the post-sample guard");
      assert.equal(entry.release, 0.3, "one-shot note-off release is not the sample duration");
    }
    if (entry.drum) assert.ok(entry.pieces?.length);
  }
  const tubular = manifest.catalog.find(entry => entry.id === "vsco-tubular-bells-natural");
  assert.equal(tubular.release, 15, "pitched release must use the SFZ envelope, not the 42-second sample length");
  assert.equal(manifest.catalog.some(entry => entry.kind === "pitched-instrument" && /buzz/i.test(`${entry.path} ${entry.articulation}`)), false,
    "recorded buzz takes must remain key-60 clips, not chromatic instruments");
  assert.equal(manifest.catalogMetadata.totalUniquePlayableSamples, 3168);
});

await check("sfizz renders a generated pitched extra with audible stereo PCM", () => {
  const extra = runtime.find(entry => entry.kind === "pitched-instrument");
  assert.ok(extra);
  const inspected = inspectSfzReferences(PREPARED, [extra.path]);
  const region = inspected.regions.find(item => Number.isInteger(item.pitchKeycenter));
  const sfz = path.join(PREPARED, ...extra.path.split("/"));
  const session = openSfizzSession(sfz, 44100);
  try {
    const rendered = session.renderTrack({
      preset: { engine: "sfizz", sfz }, track: {}, length: 88200,
      notes: [{ startSample: 0, endSample: 44100, key: region.pitchKeycenter, velocity: 127 }]
    });
    assert.equal(rendered.left.length, 88200);
    assert.equal(rendered.right.length, 88200);
    assert.ok(rendered.diagnostics.nonzeroSamples > 0);
    assert.ok(peak(rendered.left) > 1 / 32768 || peak(rendered.right) > 1 / 32768);
  } finally { session.close(); }
});

await check("sfizz one-shot reaches the audible end of the longest generated clip", () => {
  const clips = runtime.filter(entry => entry.kind === "clip");
  const longest = [...clips].sort((a, b) => b.maxSampleDurationSec - a.maxSampleDurationSec)[0];
  assert.ok(longest && longest.sourceSampleCount === 1, "longest clip must have one unambiguous source take");
  const inspected = inspectSfzReferences(PREPARED, [longest.path]);
  assert.equal(inspected.uniqueReferences.size, 1);
  const sourceRelative = [...inspected.uniqueReferences][0];
  const source = path.join(PREPARED, ...sourceRelative.split("/"));
  const sourceInfo = readWavInfo(source);
  const sourceLast = sourceLastAudibleFrame(source);
  assert.ok(sourceLast > sourceInfo.frames * 0.8, "source itself should remain audible near its recorded end");
  const sfz = path.join(PREPARED, ...longest.path.split("/"));
  const sampleRate = 44100, length = Math.ceil((sourceInfo.durationSec + 0.75) * sampleRate);
  const session = openSfizzSession(sfz, sampleRate);
  try {
    const rendered = session.renderTrack({
      preset: { engine: "sfizz", sfz, drum: true }, track: {}, length,
      notes: [{ startSample: 0, endSample: 2205, key: 60, velocity: 100 }]
    });
    const outputLast = Math.max(lastAudibleFloat(rendered.left), lastAudibleFloat(rendered.right));
    const expected = sourceLast * sampleRate / sourceInfo.sampleRate;
    assert.ok(outputLast >= expected - sampleRate * 0.05,
      `render ended at ${outputLast / sampleRate}s before source ${expected / sampleRate}s`);
  } finally { session.close(); }
});

console.log(`\n${passed} VSCO preparation tests passed`);

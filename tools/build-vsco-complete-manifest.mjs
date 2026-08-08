#!/usr/bin/env node
// Derive the repository manifest from a fully prepared VSCO 2 CE tree. Existing
// 74 melodic + 1 drum IDs remain stable; supplemental entries are appended.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSfzReferences, VSCO_IDENTITY } from "./prepare-vsco2-ce-sfz.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_FILE = path.join(ROOT, "packs", "vsco2-ce.json");
const DEFAULT_PREPARED = path.join(os.homedir(), ".aria", "prepared", "vsco2-ce-complete");
const DEFAULT_ARCHIVE = "~/.aria/downloads/vsco2-ce-6dd651d55dde97fd4028699be9d4481f26917891.tar.gz";
const DOWNLOAD_URL = "https://codeload.github.com/sgossner/VSCO-2-CE/tar.gz/6dd651d55dde97fd4028699be9d4481f26917891";

function fail(message) { throw new Error(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function rounded(value) { return Number(value.toFixed(6)); }
const ONE_SHOT_RELEASE_SEC = 0.3;
const ONE_SHOT_TAIL_AFTER_SAMPLE_SEC = 0.5;

function keyswitchDisplay(rawLabel, key) {
  const term = String(rawLabel).replace(/^\s*[A-Ga-g](?:#|b)?-?\d+\s+/, "").trim() || String(rawLabel).trim();
  const lower = term.toLowerCase();
  let explanation = "원본에 실제로 녹음된 이 연주법으로 전환";
  if (/expression.*vibrato|expressive.*vibrato/.test(lower)) explanation = "세기를 변화시키며 음높이를 떨고 길게 연주";
  else if (/sustain.*non.?vibrato|non.?vibrato.*sustain/.test(lower)) explanation = "음높이를 떨지 않고 길게 이어 연주";
  else if (/sustain.*vibrato|vibrato.*sustain/.test(lower)) explanation = "길게 이어 연주하며 음높이를 부드럽게 떨기";
  else if (/sustain|long/.test(lower)) explanation = "음을 길게 이어 연주";
  else if (/tremolo/.test(lower)) explanation = "활을 빠르게 반복해 떨리는 질감을 만들기";
  else if (/spiccato/.test(lower)) explanation = "활을 튕겨 짧고 가볍게 끊어 연주";
  else if (/pizzicato/.test(lower)) explanation = "활 대신 손가락으로 현을 뜯어 연주";
  else if (/staccato|\bstac\b/.test(lower)) explanation = "음을 짧고 서로 분리해 연주";
  return {
    label: `${term} (${explanation})`,
    originalTerm: term,
    description: `Keyswitch (키스위치) MIDI ${key} — ${explanation}`,
    keyswitch: { key, velocity: 127 }
  };
}

function validateCatalog(catalog, entryFiles) {
  if (catalog.length !== entryFiles.length) fail("catalog and entryFiles length differ");
  const ids = new Set(), paths = new Set();
  for (const entry of catalog) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id) || ids.has(entry.id)) fail(`duplicate/invalid catalog id: ${entry.id}`);
    if (!entryFiles.includes(entry.path) || paths.has(entry.path)) fail(`duplicate/unregistered catalog path: ${entry.path}`);
    if (!entry.name || !entry.family || !entry.articulation || !entry.label || entry.source !== "VSCO 2 CE" ||
        typeof entry.drum !== "boolean" || !Number.isInteger(entry.gm?.bank) || !Number.isInteger(entry.gm?.program))
      fail(`incomplete catalog metadata: ${entry.id}`);
    if (entry.drum) {
      if (!Array.isArray(entry.pieces) || !entry.pieces.length) fail(`drum/clip entry has no pieces: ${entry.id}`);
      const pieceIds = new Set(), triggers = new Set();
      for (const piece of entry.pieces) {
        const controls = piece.cc ?? [];
        if (!Array.isArray(controls)) fail(`invalid piece controls in ${entry.id}`);
        const controllerIds = new Set();
        for (const control of controls) {
          if (!Number.isInteger(control?.controller) || control.controller < 0 || control.controller > 127 ||
              !Number.isInteger(control?.value) || control.value < 0 || control.value > 127 ||
              controllerIds.has(control.controller)) fail(`invalid piece controls in ${entry.id}`);
          controllerIds.add(control.controller);
        }
        const trigger = `${piece.key}|${controls.slice().sort((a, b) => a.controller - b.controller)
          .map(control => `${control.controller}:${control.value}`).join(",")}`;
        if (!/^[a-z0-9][a-z0-9-]*$/.test(piece.id) || pieceIds.has(piece.id) ||
            !Number.isInteger(piece.key) || piece.key < 0 || piece.key > 127 || triggers.has(trigger) ||
            !piece.name || !piece.label || !piece.sampleStem ||
            !Number.isFinite(piece.durationSec) || piece.durationSec <= 0)
          fail(`invalid piece in ${entry.id}`);
        pieceIds.add(piece.id); triggers.add(trigger);
      }
    }
    ids.add(entry.id); paths.add(entry.path);
  }
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
  return {
    min: rounded(sorted[0]), median: rounded(percentile(0.5)), p95: rounded(percentile(0.95)), max: rounded(sorted.at(-1))
  };
}

export function buildVscoManifest(preparedRoot, baseManifest = readJson(MANIFEST_FILE)) {
  const root = fs.realpathSync(preparedRoot);
  const pack = readJson(path.join(root, "pack.json"));
  const checksumsFile = path.join(root, "catalog", "checksums.json");
  const checksums = readJson(checksumsFile);
  const checksumMap = new Map(checksums.map(record => [record.file, record]));
  if (checksumMap.size !== checksums.length) fail("prepared checksum inventory has duplicate paths");
  if (pack.id !== "vsco2-ce" || pack.source?.officialCommit !== VSCO_IDENTITY.commit ||
      pack.source?.officialTree !== VSCO_IDENTITY.tree || pack.source?.url !== VSCO_IDENTITY.repositoryUrl)
    fail("prepared pack source identity is not pinned VSCO 2 CE");
  if (pack.checksums?.sha256 !== sha256(checksumsFile)) fail("prepared checksum identity does not match pack.json");
  const samples = readJson(path.join(root, "catalog", "samples.json"));
  if (samples.length !== VSCO_IDENTITY.wavFiles) fail(`expected ${VSCO_IDENTITY.wavFiles} WAV catalog rows`);
  const durations = new Map(samples.map(sample => [sample.file, sample.durationSec]));
  if (durations.size !== samples.length || [...durations.values()].some(value => !(value > 0))) fail("invalid WAV durations");
  const runtime = readJson(path.join(root, "catalog", "runtime.json"));
  const officialPaths = baseManifest.content.entryFiles.filter(file => !file.startsWith("sfz-extra/"));
  const officialBase = (baseManifest.catalog ?? []).filter(entry => officialPaths.includes(entry.path));
  if (officialPaths.length !== 75 || officialBase.length !== 75) fail("base manifest must retain 75 official entries/catalog rows");

  const official = officialBase.map(entry => {
    const inspected = inspectSfzReferences(root, [entry.path]);
    const unique = [...inspected.uniqueReferences];
    const maxDuration = Math.max(...unique.map(file => durations.get(file) ?? fail(`${entry.path}: unknown sample ${file}`)));
    const release = entry.drum ? ONE_SHOT_RELEASE_SEC : rounded(inspected.ampegReleaseSec ?? 0.3);
    const pieces = entry.drum ? entry.pieces.map(piece => {
      const pieceSamples = [...new Set(inspected.regions
        .filter(region => piece.key >= region.lokey && piece.key <= region.hikey)
        .map(region => region.sample))];
      if (!pieceSamples.length) fail(`${entry.path}: piece ${piece.id} has no sample region at key ${piece.key}`);
      const durationSec = Math.max(...pieceSamples.map(file =>
        durations.get(file) ?? fail(`${entry.path}: unknown piece sample ${file}`)));
      return { ...piece, durationSec: rounded(durationSec) };
    }) : undefined;
    const articulations = !entry.drum && inspected.switches.length > 1
      ? Object.fromEntries(inspected.switches.map(({ key, label }) => [
          `keyswitch-${key}`,
          keyswitchDisplay(label, key)
        ]))
      : undefined;
    const defaultArticulation = articulations && Number.isInteger(inspected.defaultSwitch)
      ? `keyswitch-${inspected.defaultSwitch}` : undefined;
    if (articulations && !Object.hasOwn(articulations, defaultArticulation))
      fail(`${entry.path}: sw_default does not match a labeled keyswitch`);
    const result = {
      ...entry,
      source: "VSCO 2 CE",
      kind: entry.drum ? "drum-kit" : "pitched-instrument",
      duration: entry.drum ? "one-shot" : "instrument",
      sourceSampleCount: unique.length,
      maxSampleDurationSec: rounded(maxDuration),
      tailHintSec: entry.drum ? ONE_SHOT_TAIL_AFTER_SAMPLE_SEC : release,
      release,
      ...(pieces ? { pieces } : {}),
      ...(articulations ? { articulations, defaultArticulation } : {})
    };
    if (!result.gmApproximation) result.gmApproximation = entry.drum
      ? "GM percussion map approximation (GM 타악기 매핑 근사치) — VSCO 원본 녹음을 사용"
      : `GM program ${entry.gm.program + 1} approximation (GM 프로그램 ${entry.gm.program + 1} 근사치)`;
    return result;
  });

  const supplementalCandidates = runtime.map(entry => {
    const { samplePaths = [], ...catalogEntry } = entry;
    if (catalogEntry.kind !== "clip") return { entry: catalogEntry, samplePaths };
    if (!samplePaths.length || catalogEntry.pieces?.length !== 1)
      fail(`${catalogEntry.path}: recorded clip must declare source samples and one play piece`);
    const durationSec = Math.max(...samplePaths.map(file =>
      durations.get(file) ?? fail(`${catalogEntry.path}: unknown clip sample ${file}`)));
    return { samplePaths, entry: {
      ...catalogEntry,
      durationSec: rounded(durationSec),
      maxSampleDurationSec: rounded(durationSec),
      tailHintSec: ONE_SHOT_TAIL_AFTER_SAMPLE_SEC,
      release: ONE_SHOT_RELEASE_SEC,
      pieces: catalogEntry.pieces.map(piece => ({ ...piece, durationSec: rounded(durationSec) }))
    } };
  });
  // The official tree contains byte-identical copies under different legacy
  // folders. Keep every payload path and provenance alias, but do not make the
  // user choose between multiple controls that render the exact same audio set.
  const supplemental = [];
  const clipByAudio = new Map();
  for (const candidate of supplementalCandidates) {
    const entry = candidate.entry;
    if (entry.kind !== "clip") { supplemental.push(entry); continue; }
    const signature = [...candidate.samplePaths].map(file => {
      const record = checksumMap.get(file);
      if (!record) fail(`${entry.path}: clip sample is absent from checksums: ${file}`);
      return record.sha256;
    }).sort().join(":");
    const incumbent = clipByAudio.get(signature);
    if (!incumbent) {
      entry.aliases = [];
      clipByAudio.set(signature, entry);
      supplemental.push(entry);
      continue;
    }
    incumbent.aliases.push({
      id: entry.id,
      path: entry.path,
      name: entry.name,
      family: entry.family,
      sourcePaths: candidate.samplePaths
    });
  }
  const catalog = [...official, ...supplemental];
  const entryFiles = catalog.map(entry => entry.path);
  for (const entry of entryFiles) {
    if (!checksumMap.has(entry)) fail(`entry is absent from checksum inventory: ${entry}`);
  }
  validateCatalog(catalog, entryFiles);
  const verification = readJson(path.join(root, "catalog", "verification.json"));
  if (verification.totalUniquePlayableSamples !== VSCO_IDENTITY.wavFiles ||
      verification.officialUniqueReferencedSamples !== VSCO_IDENTITY.officialUniqueReferencedSamples ||
      verification.officialUnreferencedSamples !== VSCO_IDENTITY.officialUnreferencedSamples)
    fail("prepared verification totals are inconsistent");
  const clipEntries = supplemental.filter(entry => entry.kind === "clip");
  const longestClip = [...clipEntries].sort((a, b) => b.maxSampleDurationSec - a.maxSampleDurationSec || a.id.localeCompare(b.id))[0];

  return {
    schemaVersion: 1,
    id: "vsco2-ce",
    name: pack.name,
    format: "sfz",
    installDir: "vsco2-ce-sfz",
    source: {
      type: "prepared-archive",
      repositoryUrl: VSCO_IDENTITY.repositoryUrl,
      projectUrl: VSCO_IDENTITY.projectUrl,
      releaseUrl: "https://github.com/sgossner/VSCO-2-CE/releases/tag/1.1.0",
      branch: null,
      commit: pack.source.sha256,
      tree: pack.checksums.sha256,
      archiveSha256: pack.source.sha256,
      officialCommit: VSCO_IDENTITY.commit,
      officialTree: VSCO_IDENTITY.tree,
      prepareScript: "tools/prepare-vsco2-ce-sfz.mjs",
      defaultArchive: DEFAULT_ARCHIVE,
      downloadUrl: DOWNLOAD_URL
    },
    license: {
      spdx: "CC0-1.0",
      name: "CC0 1.0 Universal",
      file: "LICENSE",
      url: `https://github.com/sgossner/VSCO-2-CE/blob/${VSCO_IDENTITY.commit}/LICENSE`,
      sha256: VSCO_IDENTITY.licenseSha256
    },
    content: {
      checksumsFile: "catalog/checksums.json",
      expectedPayloadFiles: checksums.length,
      expectedAudioFiles: VSCO_IDENTITY.wavFiles,
      audioExtensions: [".wav"],
      entryFiles
    },
    catalogMetadata: {
      officialPayloadFiles: VSCO_IDENTITY.trackedFiles,
      officialEntryFiles: VSCO_IDENTITY.officialSfzFiles,
      officialSampleReferenceLines: VSCO_IDENTITY.officialSampleReferenceLines,
      officialUniqueReferencedSamples: VSCO_IDENTITY.officialUniqueReferencedSamples,
      previouslyUnreferencedSamples: VSCO_IDENTITY.officialUnreferencedSamples,
      supplementalEntries: supplemental.length,
      supplementalGeneratedEntries: runtime.length,
      duplicateAliasEntries: runtime.length - supplemental.length,
      supplementalPitchedEntries: supplemental.filter(entry => entry.kind === "pitched-instrument").length,
      supplementalClipEntries: clipEntries.length,
      supplementalUniqueReferencedSamples: verification.supplementalUniqueSamples,
      newlyMappedSamples: VSCO_IDENTITY.officialUnreferencedSamples,
      totalRuntimeEntries: catalog.length,
      totalUniquePlayableSamples: VSCO_IDENTITY.wavFiles,
      missingRuntimeSamples: 0,
      sampleDurationSec: distribution([...durations.values()]),
      longestRecordedClip: longestClip ? {
        id: longestClip.id,
        path: longestClip.path,
        durationSec: longestClip.maxSampleDurationSec,
        tailHintSec: longestClip.tailHintSec
      } : null,
      clipPolicy: "Ambiguous effects, falls, phrases, rolls, and legacy percussion are exact key-60 one-shots, not chromatic instruments.",
      upstreamDefinitionsPreservedByteForByte: true
    },
    catalog
  };
}

function parseArguments(argv) {
  let root = DEFAULT_PREPARED, write = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--root") root = argv[++index];
    else if (argv[index] === "--write") write = true;
    else if (argv[index] === "--help" || argv[index] === "-h") return { help: true };
    else fail(`unknown argument: ${argv[index]}`);
  }
  return { root, write };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node tools/build-vsco-complete-manifest.mjs [--root <prepared>] [--write]");
    } else {
      const manifest = buildVscoManifest(path.resolve(options.root));
      if (options.write) fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(JSON.stringify({
        mode: options.write ? "write" : "check",
        manifest: MANIFEST_FILE,
        catalog: manifest.catalog.length,
        official: manifest.catalogMetadata.officialEntryFiles,
        supplemental: manifest.catalogMetadata.supplementalEntries,
        playableSamples: manifest.catalogMetadata.totalUniquePlayableSamples,
        tree: manifest.source.tree
      }, null, 2));
    }
  } catch (error) {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  }
}

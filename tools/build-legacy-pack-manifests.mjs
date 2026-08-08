#!/usr/bin/env node
// Build the repository manifests for the two complete archive-derived SFZ packs.
//
// The prepared directories are deliberately treated as untrusted inputs. Before a
// manifest is emitted, this script checks the complete checksum inventory, parses
// every runtime SFZ, resolves every sample reference inside the pack, and confirms
// that the human-facing catalog describes the exact keys found in the SFZ files.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PREPARED_ROOT = process.env.ARIA_PREPARED_HOME
  ? path.resolve(process.env.ARIA_PREPARED_HOME)
  : path.join(os.homedir(), ".aria", "prepared");
const DEFAULT_PHILHARMONIA_ROOT = path.join(DEFAULT_PREPARED_ROOT, "philharmonia-all-sfz-v5");
const DEFAULT_SALAMANDER_ROOT = path.join(DEFAULT_PREPARED_ROOT, "salamander-drumkit-sfz-v4");
const PHILHARMONIA_MANIFEST = path.join(REPOSITORY_ROOT, "packs", "philharmonia-all-sfz.json");
const SALAMANDER_MANIFEST = path.join(REPOSITORY_ROOT, "packs", "salamander-drumkit-sfz.json");
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PITCHED_RELEASE_SEC = 0.3;
const ONE_SHOT_RELEASE_SEC = 0.3;
const ONE_SHOT_TAIL_AFTER_SAMPLE_SEC = 0.5;

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file); }
  catch (error) { fail(`Cannot read ${file}: ${error.message}`); }
  try { return { raw, value: JSON.parse(raw.toString("utf8")) }; }
  catch (error) { fail(`Invalid JSON in ${file}: ${error.message}`); }
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function assertSafeRelative(label, value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\") ||
      path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value))
    fail(`${label} is not a safe POSIX relative path: ${JSON.stringify(value)}`);
  const parts = value.split("/");
  if (parts.some(part => part === "" || part === "." || part === ".."))
    fail(`${label} contains an unsafe path component: ${value}`);
  return value;
}

function walkPayload(root) {
  const files = [];
  function walk(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail(`Prepared payload contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
      else fail(`Prepared payload contains a special file: ${relative}`);
    }
  }
  walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function verifyPreparedRoot(root, expectedId) {
  const absoluteRoot = path.resolve(root);
  const packFile = path.join(absoluteRoot, "pack.json");
  const { value: pack } = readJson(packFile);
  if (pack.format !== 1 || pack.id !== expectedId)
    fail(`${expectedId}: prepared pack.json has the wrong format or id`);
  if (!pack.checksums || pack.checksums.file !== "catalog/checksums.json" ||
      !SHA256_PATTERN.test(pack.checksums.sha256))
    fail(`${expectedId}: prepared checksum descriptor is invalid`);

  const checksumFile = path.join(absoluteRoot, ...pack.checksums.file.split("/"));
  const { raw: checksumRaw, value: checksums } = readJson(checksumFile);
  const tree = sha256Buffer(checksumRaw);
  if (tree !== pack.checksums.sha256)
    fail(`${expectedId}: catalog/checksums.json does not match pack.json`);
  if (!Array.isArray(checksums) || checksums.length === 0)
    fail(`${expectedId}: checksum inventory must be a non-empty array`);

  const checksumMap = new Map();
  for (const [index, record] of checksums.entries()) {
    if (!record || typeof record !== "object") fail(`${expectedId}: checksum[${index}] is invalid`);
    assertSafeRelative(`${expectedId}: checksum[${index}].file`, record.file);
    if (record.file === "pack.json" || record.file === pack.checksums.file)
      fail(`${expectedId}: checksum inventory includes reserved metadata: ${record.file}`);
    if (checksumMap.has(record.file)) fail(`${expectedId}: duplicate checksum path: ${record.file}`);
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || !SHA256_PATTERN.test(record.sha256))
      fail(`${expectedId}: invalid checksum record: ${record.file}`);
    checksumMap.set(record.file, record);
  }

  const actualPayload = walkPayload(absoluteRoot)
    .filter(file => file !== "pack.json" && file !== pack.checksums.file);
  const expectedPayload = [...checksumMap.keys()].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualPayload) !== JSON.stringify(expectedPayload))
    fail(`${expectedId}: checksum inventory and prepared payload do not contain the same files`);

  for (const record of checksums) {
    const absolute = path.join(absoluteRoot, ...record.file.split("/"));
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size !== record.bytes)
      fail(`${expectedId}: size mismatch for ${record.file}`);
    const digest = sha256File(absolute);
    if (digest !== record.sha256)
      fail(`${expectedId}: checksum mismatch for ${record.file}`);
  }

  return { root: absoluteRoot, pack, checksums, checksumMap, tree };
}

function stripSfzComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map(line => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function parseOpcodes(source) {
  const opcodes = {};
  const pattern = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|$)/g;
  for (const match of source.matchAll(pattern)) opcodes[match[1].toLowerCase()] = match[2].trim();
  return opcodes;
}

function integerOpcode(opcodes, name, fallback = undefined) {
  if (opcodes[name] === undefined) return fallback;
  if (!/^-?\d+$/.test(opcodes[name])) fail(`SFZ ${name} must be an integer, got ${opcodes[name]}`);
  return Number(opcodes[name]);
}

function resolveSampleReference(packRoot, sfzRelative, sample) {
  if (typeof sample !== "string" || sample.length === 0 || sample.includes("\0"))
    fail(`${sfzRelative}: region has no sample path`);
  const normalizedInput = sample.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalizedInput) || /^[A-Za-z]:[\\/]/.test(sample))
    fail(`${sfzRelative}: absolute sample path is forbidden: ${sample}`);
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(sfzRelative), normalizedInput));
  assertSafeRelative(`${sfzRelative}: resolved sample`, relative);
  const absolute = path.resolve(packRoot, ...relative.split("/"));
  const rootPrefix = `${path.resolve(packRoot)}${path.sep}`;
  if (!absolute.startsWith(rootPrefix)) fail(`${sfzRelative}: sample escapes pack root: ${sample}`);
  return relative;
}

function parseRuntimeSfz(prepared, sfzRelative) {
  assertSafeRelative("SFZ entry", sfzRelative);
  const entryRecord = prepared.checksumMap.get(sfzRelative);
  if (!entryRecord) fail(`${prepared.pack.id}: SFZ entry is not checksummed: ${sfzRelative}`);
  const source = stripSfzComments(fs.readFileSync(path.join(prepared.root, ...sfzRelative.split("/")), "utf8"));
  const tagPattern = /<(global|master|group|region)>\s*([\s\S]*?)(?=<(?:global|master|group|region)>|$)/gi;
  let global = {};
  let master = {};
  let group = {};
  const regions = [];
  for (const match of source.matchAll(tagPattern)) {
    const kind = match[1].toLowerCase();
    const own = parseOpcodes(match[2]);
    if (kind === "global") { global = own; master = {}; group = {}; continue; }
    if (kind === "master") { master = own; group = {}; continue; }
    if (kind === "group") { group = own; continue; }
    const effective = { ...global, ...master, ...group, ...own };
    const key = integerOpcode(effective, "key");
    const low = key ?? integerOpcode(effective, "lokey", integerOpcode(effective, "pitch_keycenter"));
    const high = key ?? integerOpcode(effective, "hikey", low);
    if (!Number.isInteger(low) || !Number.isInteger(high) || low < 0 || high > 127 || low > high)
      fail(`${sfzRelative}: region has an invalid or missing key range`);
    const sample = resolveSampleReference(prepared.root, sfzRelative, effective.sample);
    if (!prepared.checksumMap.has(sample)) fail(`${sfzRelative}: sample is not checksummed: ${sample}`);
    regions.push({ low, high, sample, opcodes: effective });
  }
  if (regions.length === 0) fail(`${sfzRelative}: no playable regions were found`);
  const keys = new Set();
  const samplesByKey = new Map();
  for (const region of regions) {
    for (let key = region.low; key <= region.high; key++) {
      keys.add(key);
      if (!samplesByKey.has(key)) samplesByKey.set(key, new Set());
      samplesByKey.get(key).add(region.sample);
    }
  }
  return { regions, keys, samplesByKey };
}

function roundedSeconds(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function safeTailHint(duration) {
  return Math.ceil((duration + ONE_SHOT_TAIL_AFTER_SAMPLE_SEC) * 1000) / 1000;
}

function probeWithAfinfo(prepared, relativeFiles) {
  const binary = "/usr/bin/afinfo";
  if (!fs.existsSync(binary)) return null;
  const durations = new Map();
  // Small batches stay safely below ARG_MAX even when the source filenames are long.
  for (let offset = 0; offset < relativeFiles.length; offset += 300) {
    const batch = relativeFiles.slice(offset, offset + 300);
    const absoluteFiles = batch.map(file => path.join(prepared.root, ...file.split("/")));
    const child = spawnSync(binary, absoluteFiles, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024
    });
    if (child.error || child.status !== 0)
      fail(`${prepared.pack.id}: afinfo duration probe failed: ${child.error?.message ?? child.stderr}`);
    let current = null;
    for (const line of child.stdout.split(/\r?\n/)) {
      const fileMatch = line.match(/^File:\s+(.+)$/);
      if (fileMatch) {
        const absolute = path.resolve(fileMatch[1]);
        const relative = path.relative(prepared.root, absolute).split(path.sep).join("/");
        current = batch.includes(relative) ? relative : null;
        continue;
      }
      const durationMatch = line.match(/^estimated duration:\s+([0-9]+(?:\.[0-9]+)?) sec$/);
      if (durationMatch && current) {
        const duration = Number(durationMatch[1]);
        if (!Number.isFinite(duration) || duration <= 0) fail(`${current}: afinfo returned an invalid duration`);
        durations.set(current, roundedSeconds(duration));
        current = null;
      }
    }
  }
  return durations;
}

function ffprobeOne(absolute) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFPROBE ?? "ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", absolute
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", status => {
      const duration = Number(stdout.trim());
      if (status !== 0 || !Number.isFinite(duration) || duration <= 0)
        reject(new Error(`ffprobe failed for ${absolute}: ${stderr || stdout}`));
      else resolve(roundedSeconds(duration));
    });
  });
}

async function probeWithFfprobe(prepared, relativeFiles, concurrency = 24) {
  const durations = new Map();
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= relativeFiles.length) return;
      const relative = relativeFiles[index];
      const absolute = path.join(prepared.root, ...relative.split("/"));
      let duration;
      try { duration = await ffprobeOne(absolute); }
      catch (error) { fail(`${prepared.pack.id}: ${error.message}`); }
      durations.set(relative, duration);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, relativeFiles.length) }, () => worker()));
  return durations;
}

async function probeAudioDurations(prepared, relativeFiles, ffprobeVerificationFiles = []) {
  const unique = [...new Set(relativeFiles)].sort((left, right) => left.localeCompare(right));
  if (unique.length !== relativeFiles.length)
    fail(`${prepared.pack.id}: audio duration input contains duplicate paths`);
  for (const file of unique) if (!prepared.checksumMap.has(file)) fail(`${file}: duration input is not checksummed`);
  let durations = probeWithAfinfo(prepared, unique);
  let method = "CoreAudio afinfo";
  if (!durations) {
    durations = await probeWithFfprobe(prepared, unique);
    method = "ffprobe";
  } else if (durations.size !== unique.length) {
    const missing = unique.filter(file => !durations.has(file));
    const fallback = await probeWithFfprobe(prepared, missing);
    for (const [file, duration] of fallback) durations.set(file, duration);
    method = `CoreAudio afinfo + ffprobe fallback (${missing.length})`;
  }

  const verifiedFiles = [...new Set(ffprobeVerificationFiles)].sort((left, right) => left.localeCompare(right));
  const ffprobe = verifiedFiles.length ? await probeWithFfprobe(prepared, verifiedFiles) : new Map();
  let maximumDifferenceSec = 0;
  for (const [file, duration] of ffprobe) {
    const baseline = durations.get(file);
    if (baseline === undefined) fail(`${file}: ffprobe verification is outside the duration catalog`);
    maximumDifferenceSec = Math.max(maximumDifferenceSec, Math.abs(duration - baseline));
    // ffprobe is the declared contract for recorded clips. Keep its exact value.
    durations.set(file, duration);
  }
  return {
    durations,
    method,
    ffprobeVerifiedFiles: ffprobe.size,
    maximumProbeDifferenceSec: roundedSeconds(maximumDifferenceSec)
  };
}

function maxDurationFor(rows, durationProbe) {
  const values = rows.map(row => {
    const duration = durationProbe.durations.get(row.playable ?? row.file);
    if (!Number.isFinite(duration) || duration <= 0) fail(`Missing measured duration for ${row.playable ?? row.file}`);
    return duration;
  });
  return Math.max(...values);
}

function distribution(values) {
  if (!values.length) fail("Cannot summarize an empty duration distribution");
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = ratio => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
  return {
    min: roundedSeconds(sorted[0]),
    p50: roundedSeconds(percentile(0.5)),
    p90: roundedSeconds(percentile(0.9)),
    p95: roundedSeconds(percentile(0.95)),
    p99: roundedSeconds(percentile(0.99)),
    max: roundedSeconds(sorted.at(-1)),
    mean: roundedSeconds(sorted.reduce((sum, value) => sum + value, 0) / sorted.length)
  };
}

async function verifyOneShotRender(prepared, entryPath, durationSec, key = 60) {
  const { openSfizzSession } = await import("../src/sfizz-engine.js");
  const sampleRate = 44_100;
  const requiredRenderWindowFromNoteStartSec = safeTailHint(durationSec);
  const length = Math.ceil((requiredRenderWindowFromNoteStartSec + 1) * sampleRate);
  const sfz = path.join(prepared.root, ...entryPath.split("/"));
  const session = openSfizzSession(fs.realpathSync(sfz), sampleRate);
  try {
    const rendered = session.renderTrack({
      notes: [{ startSample: 0, endSample: 2_205, key, velocity: 100, bend: 0, gain: 1 }],
      length
    });
    let lastNonzero = -1;
    for (let index = 0; index < length; index++)
      if (Math.abs(rendered.left[index]) > 1 / 32768 || Math.abs(rendered.right[index]) > 1 / 32768)
        lastNonzero = index;
    const lastNonzeroSec = roundedSeconds(lastNonzero / sampleRate);
    if (lastNonzero < 0 || lastNonzeroSec < durationSec - 1 ||
        lastNonzeroSec > requiredRenderWindowFromNoteStartSec)
      fail(`${entryPath}: longest one-shot render was silent or truncated (duration=${durationSec}, last=${lastNonzeroSec})`);
    return {
      engine: rendered.diagnostics.engine,
      key,
      requestedWindowSec: roundedSeconds(length / sampleRate),
      lastNonzeroSec,
      peak: rendered.diagnostics.peak,
      nonzeroSamples: rendered.diagnostics.nonzeroSamples,
      trimmedFrames: rendered.diagnostics.trimmedFrames,
      complete: true
    };
  } finally {
    session.close();
  }
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const INSTRUMENTS = {
  "Chinese-cymbal": ["Chinese Cymbal", "차이니즈 심벌", "Percussion"],
  "Chinese-hand-cymbals": ["Chinese Hand Cymbals", "차이니즈 핸드 심벌", "Percussion"],
  "Thai-gong": ["Thai Gong", "타이 공", "Percussion"],
  "agogo-bells": ["Agogo Bells", "아고고 벨", "Percussion"],
  "banana-shaker": ["Banana Shaker", "바나나 셰이커", "Percussion"],
  banjo: ["Banjo", "밴조", "Plucked Strings", 105, "GM Banjo"],
  "bass-clarinet": ["Bass Clarinet", "베이스 클라리넷", "Woodwinds", 71, "GM Clarinet"],
  "bass-drum": ["Bass Drum", "베이스 드럼", "Percussion"],
  bassoon: ["Bassoon", "바순", "Woodwinds", 70, "GM Bassoon"],
  "bell-tree": ["Bell Tree", "벨 트리", "Percussion"],
  cabasa: ["Cabasa", "카바사", "Percussion"],
  castanets: ["Castanets", "캐스터네츠", "Percussion"],
  cello: ["Cello", "첼로", "Strings", 42, "GM Cello"],
  clarinet: ["Clarinet", "클라리넷", "Woodwinds", 71, "GM Clarinet"],
  "clash-cymbals": ["Clash Cymbals", "클래시 심벌", "Percussion"],
  contrabassoon: ["Contrabassoon", "콘트라바순", "Woodwinds", 70, "GM Bassoon"],
  cowbell: ["Cowbell", "카우벨", "Percussion"],
  djembe: ["Djembe", "젬베", "Percussion"],
  djundjun: ["Djundjun", "둔둔", "Percussion"],
  "double-bass": ["Double Bass", "더블 베이스", "Strings", 43, "GM Contrabass"],
  "english-horn": ["English Horn", "잉글리시 호른", "Woodwinds", 69, "GM English Horn"],
  flexatone: ["Flexatone", "플렉사톤", "Percussion"],
  flute: ["Flute", "플루트", "Woodwinds", 73, "GM Flute"],
  "french-horn": ["French Horn", "프렌치 호른", "Brass", 60, "GM French Horn"],
  guiro: ["Guiro", "귀로", "Percussion"],
  guitar: ["Guitar", "기타", "Plucked Strings", 24, "GM Nylon Guitar"],
  "lemon-shaker": ["Lemon Shaker", "레몬 셰이커", "Percussion"],
  mandolin: ["Mandolin", "만돌린", "Plucked Strings", 25, "GM Steel Guitar"],
  "motor-horn": ["Motor Horn", "모터 호른", "Sound Effects"],
  oboe: ["Oboe", "오보에", "Woodwinds", 68, "GM Oboe"],
  ratchet: ["Ratchet", "래칫", "Percussion"],
  saxophone: ["Saxophone", "색소폰", "Woodwinds", 65, "GM Alto Sax"],
  "sheeps-toenails": ["Sheep's Toenails", "양 발굽 셰이커", "Percussion"],
  "sizzle-cymbal": ["Sizzle Cymbal", "시즐 심벌", "Percussion"],
  "sleigh-bells": ["Sleigh Bells", "슬레이 벨", "Percussion"],
  "snare-drum": ["Snare Drum", "스네어 드럼", "Percussion"],
  "spring-coil": ["Spring Coil", "스프링 코일", "Sound Effects"],
  squeaker: ["Squeaker", "스퀴커", "Sound Effects"],
  "strawberry-shaker": ["Strawberry Shaker", "스트로베리 셰이커", "Percussion"],
  surdo: ["Surdo", "수르두", "Percussion"],
  "suspended-cymbal": ["Suspended Cymbal", "서스펜디드 심벌", "Percussion"],
  "swanee-whistle": ["Swanee Whistle", "스와니 휘슬", "Sound Effects"],
  "tam-tam": ["Tam-tam", "탐탐", "Percussion"],
  tambourine: ["Tambourine", "탬버린", "Percussion"],
  "tenor-drum": ["Tenor Drum", "테너 드럼", "Percussion"],
  "tom-toms": ["Tom-toms", "톰톰", "Percussion"],
  "train-whistle": ["Train Whistle", "트레인 휘슬", "Sound Effects"],
  triangle: ["Triangle", "트라이앵글", "Percussion"],
  trombone: ["Trombone", "트롬본", "Brass", 57, "GM Trombone"],
  trumpet: ["Trumpet", "트럼펫", "Brass", 56, "GM Trumpet"],
  tuba: ["Tuba", "튜바", "Brass", 58, "GM Tuba"],
  vibraslap: ["Vibraslap", "비브라슬랩", "Percussion"],
  viola: ["Viola", "비올라", "Strings", 41, "GM Viola"],
  violin: ["Violin", "바이올린", "Strings", 40, "GM Violin"],
  washboard: ["Washboard", "워시보드", "Percussion"],
  whip: ["Whip", "윕", "Percussion"],
  "wind-chimes": ["Wind Chimes", "윈드 차임", "Percussion"],
  woodblock: ["Woodblock", "우드블록", "Percussion"]
};

const ARTICULATIONS = {
  "arco-au-talon": ["Arco au talon", "아르코 오 탈롱", "활의 개구리 쪽으로 연주"],
  "arco-col-legno-battuto": ["Col legno battuto", "콜 레뇨 바투토", "활대 나무로 현을 두드려"],
  "arco-col-legno-tratto": ["Col legno tratto", "콜 레뇨 트라토", "활대 나무를 현에 문질러"],
  "arco-detache": ["Détaché", "데타셰", "각 음마다 활 방향을 나누어 또렷하게"],
  "arco-glissando": ["Arco glissando", "아르코 글리산도", "활로 음높이를 미끄러지듯 이동"],
  "arco-harmonic": ["Arco harmonic", "아르코 하모닉", "활로 배음을 맑게 울려"],
  "arco-legato": ["Arco legato", "아르코 레가토", "활로 음 사이를 부드럽게 연결"],
  "arco-major-trill": ["Arco major trill", "아르코 장2도 트릴", "활을 켠 채 위 음과 장2도로 빠르게 교대"],
  "arco-martele": ["Martelé", "마르텔레", "활로 각 음을 강하게 눌러 또렷하게"],
  "arco-minor-trill": ["Arco minor trill", "아르코 단2도 트릴", "활을 켠 채 위 음과 단2도로 빠르게 교대"],
  "arco-normal": ["Arco normale", "아르코 노르말레", "일반적인 활 연주"],
  "arco-portato": ["Portato", "포르타토", "음은 이어가되 각 음을 살짝 구분"],
  "arco-punta-d'arco": ["Punta d'arco", "푼타 다르코", "활 끝부분으로 가볍고 섬세하게"],
  "arco-spiccato": ["Spiccato", "스피카토", "활을 튕기듯 짧게"],
  "arco-staccato": ["Arco staccato", "아르코 스타카토", "활로 짧고 분리되게"],
  "arco-sul-ponticello": ["Sul ponticello", "술 폰티첼로", "브리지 가까이 켜서 얇고 날카롭게"],
  "arco-sul-tasto": ["Sul tasto", "술 타스토", "지판 가까이 켜서 부드럽고 흐리게"],
  "arco-tenuto": ["Arco tenuto", "아르코 테누토", "활로 음 길이를 충분히 유지"],
  "arco-tremolo": ["Arco tremolo", "아르코 트레몰로", "활을 빠르게 왕복해 떨리는 질감"],
  "artificial-harmonic": ["Artificial harmonic", "인공 하모닉", "손가락으로 만든 배음을 맑게 울려"],
  "bass-drum-mallet": ["Bass-drum mallet", "베이스 드럼 말렛", "큰 말렛으로 타격"],
  body: ["Body", "바디", "악기 몸통을 두드리거나 울려"],
  clean: ["Clean", "클린", "부가 효과 없이 또렷하게"],
  "con-sord": ["Con sordino", "콘 소르디노", "뮤트를 끼워 음색을 부드럽게 억제"],
  damped: ["Damped", "댐프드", "울림을 손이나 댐퍼로 짧게 막아"],
  "double-tonguing": ["Double tonguing", "더블 텅잉", "혀의 두 동작을 번갈아 빠르게 발음"],
  effect: ["Effect", "이펙트", "일반 음정 연주가 아닌 특수 효과"],
  flam: ["Flam", "플램", "두 번의 타격을 거의 붙여 한 번처럼"],
  fluttertonguing: ["Flutter tonguing", "플러터 텅잉", "혀를 굴려 거칠게 떨리는 소리"],
  glissando: ["Glissando", "글리산도", "음높이를 미끄러지듯 연속 이동"],
  hand: ["Hand", "핸드", "손으로 직접 타격하거나 흔들어"],
  harmonic: ["Harmonic", "하모닉", "기본음 위의 배음을 강조"],
  "harmonic-glissando": ["Harmonic glissando", "하모닉 글리산도", "배음 사이를 미끄러지듯 이동"],
  harmonics: ["Harmonics", "하모닉스", "여러 배음의 맑고 얇은 질감"],
  legato: ["Legato", "레가토", "음 사이를 부드럽게 연결"],
  "major-trill": ["Major trill", "장2도 트릴", "위 음과 장2도로 빠르게 교대"],
  "medium-sticks": ["Medium sticks", "미디엄 스틱", "중간 굵기 스틱으로 타격"],
  "minor-trill": ["Minor trill", "단2도 트릴", "위 음과 단2도로 빠르게 교대"],
  "molto-vibrato": ["Molto vibrato", "몰토 비브라토", "음높이를 매우 넓고 뚜렷하게 흔들어"],
  mute: ["Muted", "뮤트", "뮤트로 울림과 밝기를 줄여"],
  "natural-harmonic": ["Natural harmonic", "자연 하모닉", "개방현의 자연 배음을 맑게 울려"],
  "non-vibrato": ["Non-vibrato", "논 비브라토", "음높이를 흔들지 않고 곧게"],
  nonlegato: ["Non-legato", "논 레가토", "음을 완전히 잇지도 끊지도 않게"],
  normal: ["Normal", "노멀", "악기의 기본 주법으로 연주"],
  "pizz-glissando": ["Pizzicato glissando", "피치카토 글리산도", "현을 뜯은 뒤 음높이를 미끄러뜨려"],
  "pizz-normal": ["Pizzicato normale", "피치카토 노르말레", "현을 손가락으로 일반적으로 뜯어"],
  "pizz-quasi-guitar": ["Pizzicato quasi guitar", "기타풍 피치카토", "기타처럼 현을 뜯어"],
  "pizz-tremolo": ["Pizzicato tremolo", "피치카토 트레몰로", "현을 빠르게 반복해 뜯어"],
  rhythm: ["Rhythm", "리듬", "여러 타격이 이어진 리듬 패턴"],
  rimshot: ["Rimshot", "림샷", "헤드와 림을 함께 쳐 날카롭게"],
  roll: ["Roll", "롤", "빠른 반복 타격으로 길게 이어"],
  rute: ["Rute", "루테", "묶음 막대 말렛으로 부드럽고 거칠게"],
  scraped: ["Scraped", "스크레이프드", "표면을 긁어 연속적인 질감"],
  shaken: ["Shaken", "셰이큰", "악기를 흔들어 입자가 이어지게"],
  "slap-tongue": ["Slap tongue", "슬랩 텅", "리드를 혀로 튕겨 타격감 있게"],
  "snap-pizz": ["Snap pizzicato", "스냅 피치카토", "현을 세게 당겨 지판에 부딪히게"],
  squeezed: ["Squeezed", "스퀴즈드", "악기를 눌러 짧은 효과음을 내"],
  staccatissimo: ["Staccatissimo", "스타카티시모", "스타카토보다 더 짧고 날카롭게"],
  staccato: ["Staccato", "스타카토", "음을 짧고 또렷하게 분리"],
  sticks: ["Sticks", "스틱", "스틱으로 타격"],
  "struck-singly": ["Struck singly", "단독 타격", "한 번씩 따로 타격"],
  "struck-together": ["Struck together", "동시 타격", "두 면이나 두 악기를 함께 부딪쳐"],
  subtone: ["Subtone", "서브톤", "숨소리가 섞인 어둡고 부드러운 톤"],
  tenuto: ["Tenuto", "테누토", "음 길이를 충분히 유지"],
  "tongued-slur": ["Tongued slur", "텅드 슬러", "첫 음은 혀로 내고 뒤 음은 이어"],
  tremolo: ["Tremolo", "트레몰로", "빠르게 반복해 떨리는 질감"],
  "triple-tonguing": ["Triple tonguing", "트리플 텅잉", "혀의 세 동작을 묶어 빠르게 발음"],
  undamped: ["Undamped", "언댐프드", "울림을 막지 않고 자연스럽게 감쇠"],
  unspecified: ["Unspecified", "주법 미표기", "원본 파일에 세부 주법이 기록되지 않음"],
  "vibe-mallet-undamped": ["Vibraphone mallet, undamped", "비브라폰 말렛 언댐프드", "부드러운 말렛으로 치고 울림을 막지 않아"],
  vibrato: ["Vibrato", "비브라토", "음높이를 섬세하게 흔들어"],
  "with-snares": ["With snares", "스네어 온", "스네어 와이어를 켜고 타격"],
  "without-snares": ["Without snares", "스네어 오프", "스네어 와이어를 끄고 타격"]
};

const DURATIONS = {
  "025": ["Short 0.25 s", "짧게 약 0.25초", "매우 짧은 원음"],
  "05": ["Short 0.5 s", "짧게 약 0.5초", "짧은 원음"],
  "1": ["Medium 1.0 s", "약 1초", "중간 길이 원음"],
  "15": ["Medium 1.5 s", "약 1.5초", "조금 긴 원음"],
  long: ["Long", "길게", "긴 원음"],
  "very-long": ["Very Long", "매우 길게", "매우 긴 원음 또는 녹음된 강약 변화"],
  phrase: ["Phrase", "프레이즈", "여러 음이나 타격이 이어진 연주 흐름"]
};

function instrumentMetadata(id) {
  const metadata = INSTRUMENTS[id];
  if (!metadata) fail(`No display metadata for Philharmonia instrument: ${id}`);
  return { display: metadata[0], korean: metadata[1], category: metadata[2], program: metadata[3], gmName: metadata[4] };
}

function articulationMetadata(id) {
  const metadata = ARTICULATIONS[id];
  if (!metadata) fail(`No display metadata for Philharmonia articulation: ${id}`);
  return { display: metadata[0], korean: metadata[1], explanation: metadata[2] };
}

function durationMetadata(id) {
  const metadata = DURATIONS[id];
  if (!metadata) fail(`No display metadata for Philharmonia duration: ${id}`);
  return { display: metadata[0], korean: metadata[1], explanation: metadata[2] };
}

function validateUniqueCatalog(catalog, entryFiles, label) {
  if (catalog.length !== entryFiles.length) fail(`${label}: catalog and entryFiles counts differ`);
  const ids = new Set();
  const paths = new Set();
  const entrySet = new Set(entryFiles);
  for (const entry of catalog) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id) || ids.has(entry.id))
      fail(`${label}: duplicate or invalid catalog id: ${entry.id}`);
    assertSafeRelative(`${label}: catalog path`, entry.path);
    if (!entrySet.has(entry.path) || paths.has(entry.path))
      fail(`${label}: duplicate or unlisted catalog path: ${entry.path}`);
    if (!entry.gm || !Number.isInteger(entry.gm.bank) || !Number.isInteger(entry.gm.program))
      fail(`${label}: invalid GM approximation: ${entry.id}`);
    if (entry.drum) {
      if (!Array.isArray(entry.pieces) || entry.pieces.length === 0)
        fail(`${label}: drum/clip entry has no pieces: ${entry.id}`);
      const pieceIds = new Set();
      const pieceTriggers = new Set();
      for (const piece of entry.pieces) {
        const controls = piece.cc ?? [];
        if (!Array.isArray(controls)) fail(`${label}: piece CC controls must be an array in ${entry.id}`);
        const controllers = new Set();
        for (const control of controls) {
          if (!Number.isInteger(control?.controller) || control.controller < 0 || control.controller > 127 ||
              !Number.isInteger(control?.value) || control.value < 0 || control.value > 127 ||
              controllers.has(control.controller))
            fail(`${label}: invalid or duplicate piece CC control in ${entry.id}`);
          controllers.add(control.controller);
        }
        const trigger = `${piece.key}|${controls.slice().sort((a, b) => a.controller - b.controller)
          .map(control => `${control.controller}:${control.value}`).join(",")}`;
        if (!/^[a-z0-9][a-z0-9-]*$/.test(piece.id) || pieceIds.has(piece.id) ||
            !Number.isInteger(piece.key) || piece.key < 0 || piece.key > 127 || pieceTriggers.has(trigger) ||
            typeof piece.name !== "string" || typeof piece.label !== "string" || typeof piece.sampleStem !== "string" ||
            !Number.isFinite(piece.durationSec) || piece.durationSec <= 0)
          fail(`${label}: invalid or duplicate piece in ${entry.id}`);
        pieceIds.add(piece.id);
        pieceTriggers.add(trigger);
      }
    } else if (entry.pieces !== undefined) {
      fail(`${label}: melodic entry unexpectedly has pieces: ${entry.id}`);
    }
    ids.add(entry.id);
    paths.add(entry.path);
  }
}

function baseManifest(prepared, fields) {
  const audioExtensions = [...new Set(prepared.checksums
    .map(record => path.posix.extname(record.file).toLowerCase())
    .filter(extension => fields.audioExtensions.includes(extension)))].sort();
  const audioFiles = prepared.checksums.filter(record => audioExtensions.includes(path.posix.extname(record.file).toLowerCase()));
  if (audioExtensions.length !== fields.audioExtensions.length ||
      audioExtensions.some((extension, index) => extension !== [...fields.audioExtensions].sort()[index]))
    fail(`${prepared.pack.id}: prepared audio extensions do not match expectation`);
  const licenseRecord = prepared.checksumMap.get(fields.license.file);
  if (!licenseRecord) fail(`${prepared.pack.id}: license evidence is not checksummed`);
  const manifest = {
    schemaVersion: 1,
    id: prepared.pack.id,
    name: prepared.pack.name,
    format: "sfz",
    installDir: fields.installDir,
    source: {
      type: "prepared-archive",
      repositoryUrl: prepared.pack.source.url,
      projectUrl: fields.projectUrl,
      branch: null,
      commit: prepared.pack.source.sha256,
      tree: prepared.tree,
      archiveSha256: prepared.pack.source.sha256,
      prepareScript: fields.prepareScript,
      defaultArchive: fields.defaultArchive,
      downloadUrl: fields.downloadUrl
    },
    license: { ...fields.license, sha256: licenseRecord.sha256 },
    content: {
      checksumsFile: prepared.pack.checksums.file,
      entryFiles: [],
      audioExtensions,
      expectedPayloadFiles: prepared.checksums.length,
      expectedAudioFiles: audioFiles.length
    },
    catalogMetadata: {},
    catalog: []
  };
  if (!SHA256_PATTERN.test(manifest.source.commit) || manifest.source.commit !== manifest.source.archiveSha256)
    fail(`${prepared.pack.id}: source archive hash is invalid`);
  return manifest;
}

async function buildPhilharmoniaManifest(root) {
  const prepared = verifyPreparedRoot(root, "philharmonia-all-sfz");
  const sfzCatalog = readJson(path.join(prepared.root, "catalog", "sfz.json")).value;
  const sampleCatalog = readJson(path.join(prepared.root, "catalog", "samples.json")).value;
  if (!Array.isArray(sfzCatalog) || !Array.isArray(sampleCatalog)) fail("Philharmonia generated catalogs are invalid");
  const samples = new Map(sampleCatalog.map(sample => [sample.id, sample]));
  if (samples.size !== sampleCatalog.length || samples.size !== 13683)
    fail(`Philharmonia source sample catalog must contain 13,683 unique rows, got ${samples.size}`);
  const playableSampleCatalog = sampleCatalog.filter(sample => typeof sample.playable === "string");
  const sourceDefects = sampleCatalog.filter(sample => sample.kind === "source-defect");
  if (playableSampleCatalog.length !== 13681 || sourceDefects.length !== 2 ||
      sourceDefects.some(sample => sample.reason !== "empty-source-file" || sample.sourceBytes !== 0))
    fail(`Philharmonia official source-defect contract changed: playable=${playableSampleCatalog.length}, defects=${sourceDefects.length}`);

  const clipSampleFiles = sfzCatalog
    .filter(entry => entry.type === "recorded-clip")
    .map(entry => samples.get(entry.sourceSamples[0])?.playable);
  if (clipSampleFiles.some(file => typeof file !== "string")) fail("Philharmonia clip catalog has an unknown sample");
  const durationProbe = await probeAudioDurations(prepared, playableSampleCatalog.map(sample => sample.playable), clipSampleFiles);

  const typeOrder = { pitched: 0, "unpitched-one-shot": 1, "recorded-clip": 2 };
  const sorted = [...sfzCatalog].sort((left, right) =>
    typeOrder[left.type] - typeOrder[right.type] || left.instrument.localeCompare(right.instrument) ||
    left.articulation.localeCompare(right.articulation) || left.duration.localeCompare(right.duration) ||
    left.file.localeCompare(right.file));
  const consumedSamples = new Set();
  const catalog = [];
  let pitched = 0;
  let unpitched = 0;
  let clips = 0;

  for (const generated of sorted) {
    if (!(generated.type in typeOrder)) fail(`Unknown Philharmonia SFZ type: ${generated.type}`);
    const parsed = parseRuntimeSfz(prepared, generated.file);
    if (parsed.regions.length !== generated.regions)
      fail(`${generated.file}: catalog region count does not match SFZ`);
    if (!Array.isArray(generated.sourceSamples) || generated.sourceSamples.length === 0)
      fail(`${generated.file}: no source sample identities`);
    const sourceRows = generated.sourceSamples.map(id => {
      const row = samples.get(id);
      if (!row) fail(`${generated.file}: unknown source sample id ${id}`);
      if (consumedSamples.has(id)) fail(`${generated.file}: source sample ${id} appears in more than one runtime entry`);
      consumedSamples.add(id);
      return row;
    });
    const expectedSamples = new Set(sourceRows.map(row => row.playable));
    const actualSamples = new Set(parsed.regions.map(region => region.sample));
    if (expectedSamples.size !== actualSamples.size || [...expectedSamples].some(sample => !actualSamples.has(sample)))
      fail(`${generated.file}: generated source identities do not exactly match SFZ references`);

    const instrument = instrumentMetadata(generated.instrument);
    const articulation = articulationMetadata(generated.articulation);
    const duration = durationMetadata(generated.duration);
    const melodic = generated.type === "pitched";
    if (melodic && !Number.isInteger(instrument.program))
      fail(`${generated.file}: pitched instrument has no GM approximation`);
    const stem = generated.file.replace(/^sfz(?:-clips)?\//, "").replace(/\.sfz$/i, "");
    const id = generated.type === "recorded-clip"
      ? `philharmonia-clip-${generated.sourceSamples[0]}`
      : `philharmonia-${slug(stem)}`;
    const articulationLabel = `${articulation.display} (${articulation.korean}) — ${articulation.explanation}`;
    const durationLabel = `${duration.display} (${duration.korean}) — ${duration.explanation}`;
    const entry = {
      id,
      path: generated.file,
      name: instrument.display,
      family: instrument.display,
      articulation: generated.articulation,
      duration: generated.duration,
      label: `${articulationLabel} · ${durationLabel}`,
      source: "Philharmonia Orchestra Sound Samples",
      category: instrument.category,
      instrumentLabel: `${instrument.display} (${instrument.korean})`,
      articulationLabel,
      durationLabel,
      kind: melodic ? "pitched-instrument" : "one-shot",
      gm: melodic ? { bank: 0, program: instrument.program } : { bank: 128, program: 0 },
      gmApproximation: melodic
        ? `${instrument.gmName} (GM 프로그램 ${instrument.program + 1}, 내부 번호 ${instrument.program})`
        : "GM Percussion key 60 approximation (GM 타악기 60번 근사치) — Aria에서는 원본 녹음을 그대로 재생",
      drum: !melodic,
      sourceSampleCount: sourceRows.length,
      maxSampleDurationSec: roundedSeconds(maxDurationFor(sourceRows, durationProbe))
    };
    entry.tailHintSec = melodic ? PITCHED_RELEASE_SEC : ONE_SHOT_TAIL_AFTER_SAMPLE_SEC;
    entry.release = melodic ? PITCHED_RELEASE_SEC : ONE_SHOT_RELEASE_SEC;

    if (generated.type === "pitched") {
      pitched++;
    } else if (generated.type === "unpitched-one-shot") {
      unpitched++;
      entry.durationSec = entry.maxSampleDurationSec;
      if ([...parsed.keys].length !== 1 || !parsed.keys.has(60))
        fail(`${generated.file}: unpitched one-shot must map exactly to key 60`);
      const sampleStems = new Set(sourceRows.map(row => path.posix.basename(row.sourceEntry, ".mp3").split("__")[0]));
      if (sampleStems.size !== 1) fail(`${generated.file}: unpitched layer has inconsistent sample stems`);
      const pieceId = slug(`${generated.instrument}-${generated.articulation}`);
      entry.pieces = [{
        id: pieceId,
        key: 60,
        name: `${instrument.display} ${articulation.display}`,
        label: `${instrument.display} (${instrument.korean}) — ${articulation.display} (${articulation.korean}), key 60에서 원음을 재생`,
        sampleStem: [...sampleStems][0],
        durationSec: entry.durationSec
      }];
    } else {
      clips++;
      if (generated.sourceSamples.length !== 1 || [...parsed.keys].length !== 1 || !parsed.keys.has(60))
        fail(`${generated.file}: recorded clip must contain one source and map exactly to key 60`);
      const source = sourceRows[0];
      entry.kind = "clip";
      entry.label = `Recorded Clip (녹음 클립) — 원래 프레이즈/효과 그대로 한 번 재생 · ${articulationLabel} · ${durationLabel}`;
      entry.clipReason = generated.clipReason;
      entry.clip = {
        sourceSampleId: source.id,
        sourceEntry: source.sourceEntry,
        reason: generated.clipReason
      };
      // 같은 악기·주법의 phrase가 음정과 강약별로 수십 개 존재한다. 원본
      // 파일명이나 opaque id만 보게 하지 말고 사람이 고를 수 있는 identity를
      // catalog 최상위에 보존한다.
      entry.sourceEntry = source.sourceEntry;
      entry.sourceSampleId = source.id;
      entry.recordedNote = source.note ?? null;
      entry.recordedMidi = Number.isInteger(source.midi) ? source.midi : null;
      entry.recordedDynamic = source.dynamic ?? null;
      entry.name = `${instrument.display} · ${[
        source.note,
        source.dynamic
      ].filter(Boolean).join(" · ") || "Original Take"}`;
      entry.durationSec = durationProbe.durations.get(source.playable);
      entry.pieces = [{
        id: "play",
        key: 60,
        name: "Play",
        label: "Play (재생) — 원래 녹음을 한 번 재생",
        sampleStem: path.posix.basename(source.sourceEntry, ".mp3"),
        durationSec: entry.durationSec
      }];
    }
    catalog.push(entry);
  }

  if (pitched !== 184 || unpitched !== 74 || clips !== 1307 || catalog.length !== 1565)
    fail(`Philharmonia entry counts are wrong: pitched=${pitched}, unpitched=${unpitched}, clips=${clips}`);
  if (consumedSamples.size !== playableSampleCatalog.length)
    fail(`Philharmonia runtime entries leave ${playableSampleCatalog.length - consumedSamples.size} playable source samples unavailable`);

  const clipEntries = catalog.filter(entry => entry.kind === "clip");
  const longestClip = clipEntries.reduce((longest, entry) =>
    !longest || entry.durationSec > longest.durationSec ? entry : longest, null);
  const longestClipRender = await verifyOneShotRender(prepared, longestClip.path, longestClip.durationSec);

  const manifest = baseManifest(prepared, {
    installDir: "philharmonia-all-sfz",
    projectUrl: "https://philharmonia.co.uk/resources/sound-samples/",
    prepareScript: "tools/prepare-philharmonia-sfz.mjs",
    defaultArchive: "~/.aria/downloads/philharmonia-all-samples.zip",
    downloadUrl: "https://philharmonia-assets.s3-eu-west-1.amazonaws.com/uploads/2020/02/12112005/all-samples.zip",
    audioExtensions: [".mp3"],
    license: {
      spdx: "LicenseRef-Philharmonia-Sound-Samples-Terms",
      name: "Philharmonia Orchestra sound-sample terms",
      file: "official/SOURCE_TERMS.txt",
      url: "https://philharmonia.co.uk/resources/sound-samples/"
    }
  });
  manifest.content.entryFiles = catalog.map(entry => entry.path);
  manifest.catalogMetadata = {
    sourceSamples: 13683,
    playableSourceSamples: playableSampleCatalog.length,
    officialSourceDefects: sourceDefects.map(sample => ({
      sourceEntry: sample.sourceEntry,
      bytes: sample.sourceBytes,
      reason: sample.reason
    })),
    instrumentEntries: 258,
    pitchedInstrumentEntries: pitched,
    unpitchedOneShotEntries: unpitched,
    recordedClipEntries: clips,
    clipsPlayable: clips,
    missingRuntimeSamples: 0,
    durationProbe: {
      allPlayableAudioFiles: playableSampleCatalog.length,
      primaryMethod: durationProbe.method,
      recordedClipsVerifiedByFfprobe: durationProbe.ffprobeVerifiedFiles,
      maximumProbeDifferenceSec: durationProbe.maximumProbeDifferenceSec
    },
    clipDurationSec: distribution(clipEntries.map(entry => entry.durationSec)),
    longestRecordedClip: {
      id: longestClip.id,
      path: longestClip.path,
      durationSec: longestClip.durationSec,
      tailHintSec: longestClip.tailHintSec,
      requiredRenderWindowFromNoteStartSec: safeTailHint(longestClip.durationSec),
      renderVerification: longestClipRender
    },
    clipPolicy: "Recorded phrases, effects, glissandi, and dynamic curves are exact key-60 one-shots, not pitched instruments."
  };
  manifest.catalog = catalog;
  validateUniqueCatalog(catalog, manifest.content.entryFiles, "Philharmonia");
  return manifest;
}

const SALAMANDER_PIECES = {
  35: ["kick-1", "Kick 1", "킥 1", "첫 번째 베이스 드럼", "kick", /^kick_OH_/],
  36: ["kick-2", "Kick 2", "킥 2", "두 번째 베이스 드럼", "kick2", /^kick2_OH_/],
  37: ["snare-2-off", "Snare 2, snares off", "스네어 2 오프", "두 번째 스네어의 와이어를 끈 타격", "snare2OFF", /^snare2OFF_/],
  38: ["snare-2", "Snare 2", "스네어 2", "두 번째 스네어의 일반·고스트 타격", "snare2", /^snare2_/],
  39: ["snare-1-off", "Snare 1, snares off", "스네어 1 오프", "첫 번째 스네어의 와이어를 끈 타격", "snareOFF", /^snareOFF_/],
  40: ["snare-1", "Snare 1", "스네어 1", "첫 번째 스네어의 일반·고스트 타격", "snare", /^snare_/],
  41: ["snare-stick", "Snare cross-stick", "스네어 크로스 스틱", "스틱을 림에 걸쳐 짧고 딱딱하게 타격", "snareStick", /^snareStick_/],
  42: ["hi-hat-closed", "Hi-hat Closed", "하이햇 닫힘", "두 심벌을 완전히 닫아 짧고 단단하게 타격", "hihatClosed", /^hihatClosed_/],
  43: ["low-tom", "Low tom", "로우 톰", "낮은 톰의 강약·라운드로빈 타격", "loTom", /^loTom_/],
  44: ["hi-hat-foot", "Hi-hat foot / stomp", "하이햇 풋·스톰프", "페달로 닫거나 강하게 밟는 소리", "hihatFoot + hihatFootStomp", /^hihatFoot(?:Stomp)?_/],
  45: ["high-tom", "High tom", "하이 톰", "높은 톰의 강약·라운드로빈 타격", "hiTom", /^hiTom_/],
  46: ["hi-hat-open", "Open hi-hat", "오픈 하이햇", "열린 하이햇의 긴 울림과 초크 연결", "hihatOpen", /^hihatOpen_/],
  47: ["cowbell", "Cowbell", "카우벨", "세 단계 강약의 카우벨 타격", "cowbell", /^cowbell_/],
  48: ["ride-2", "Ride 2 bow", "라이드 2 보우", "두 번째 라이드의 표면 타격", "ride2", /^ride2_OH_/],
  49: ["ride-2-bell", "Ride 2 bell", "라이드 2 벨", "두 번째 라이드의 벨 부분 타격", "ride2Bell", /^ride2Bell_/],
  50: ["ride-2-crash", "Ride 2 crash", "라이드 2 크래시", "두 번째 라이드를 크래시처럼 강하게 타격", "ride2Crash", /^ride2Crash_OH_/],
  51: ["ride-2-crash-choke", "Ride 2 crash choke", "라이드 2 크래시 초크", "울리는 라이드를 손으로 막는 소리", "ride2CrashChoke", /^ride2CrashChoke_/],
  52: ["ride-1", "Ride 1 bow", "라이드 1 보우", "첫 번째 라이드의 표면 타격", "ride1", /^ride1_OH_/],
  53: ["ride-1-bell", "Ride 1 bell", "라이드 1 벨", "첫 번째 라이드의 벨 부분 타격", "ride1Bell", /^ride1Bell_/],
  54: ["crash-1-choke", "Crash 1 choke", "크래시 1 초크", "첫 번째 크래시의 울림을 손으로 막아", "crash1Choke", /^crash1Choke_/],
  55: ["crash-1", "Crash 1", "크래시 1", "첫 번째 크래시 심벌 타격", "crash1", /^crash1_OH_/],
  56: ["crash-2-choke", "Crash 2 choke", "크래시 2 초크", "두 번째 크래시의 울림을 손으로 막아", "crash2Choke", /^crash2Choke_/],
  57: ["crash-2", "Crash 2", "크래시 2", "두 번째 크래시 심벌 타격", "crash2", /^crash2_OH_/],
  58: ["china-1-choke", "China 1 choke", "차이나 1 초크", "첫 번째 차이나 심벌의 울림을 손으로 막아", "china1Choke", /^china1Choke_/],
  59: ["china-1", "China 1", "차이나 1", "첫 번째 차이나 심벌 타격", "china1", /^china1_OH_/],
  60: ["china-2", "China 2", "차이나 2", "두 번째 차이나 심벌 타격", "china2", /^china2_OH_/],
  61: ["china-2-choke", "China 2 choke", "차이나 2 초크", "두 번째 차이나 심벌의 울림을 손으로 막아", "china2Choke", /^china2Choke_/],
  62: ["crash-3", "Crash 3", "크래시 3", "세 번째 크래시 심벌 타격", "crash3", /^crash3_/],
  63: ["splash-1", "Splash 1", "스플래시 1", "짧고 밝은 스플래시 심벌 타격", "splash1", /^splash1_/],
  64: ["bell-chime", "Bell chime", "벨 차임", "벨 차임의 금속성 타격", "bellchime", /^bellchime_/]
};

// 같은 MIDI key 42를 CC64 값으로 나눠 실제로 녹음된 닫힘·반열림 단계를 고른다.
// 전문 용어를 앞에 두고 바로 뒤에 비음악인도 이해할 수 있는 설명을 붙인다.
const SALAMANDER_HIHAT_OPENNESS = [
  ["hi-hat-closed", "Hi-hat Closed", "하이햇 닫힘", "두 심벌을 완전히 닫아 짧고 단단하게 타격", "hihatClosed", 0, /^hihatClosed_/],
  ["hi-hat-semi-open-1", "Hi-hat Semi-open 1", "하이햇 반열림 1", "거의 닫힌 상태로 아주 짧은 공명만 남김", "hihatSemiOpen1", 10, /^hihatSemiOpen1_/],
  ["hi-hat-semi-open-2", "Hi-hat Semi-open 2", "하이햇 반열림 2", "조금 열어 금속성 꼬리를 살짝 늘림", "hihatSemiOpen2", 27, /^hihatSemiOpen2_/],
  ["hi-hat-semi-open-3", "Hi-hat Semi-open 3", "하이햇 반열림 3", "중간보다 덜 열린 공명으로 리듬을 부드럽게 연결", "hihatSemiOpen3", 45, /^hihatSemiOpen3_/],
  ["hi-hat-semi-open-4", "Hi-hat Semi-open 4", "하이햇 반열림 4", "중간 개방도로 닫힌 소리와 열린 소리의 사이를 만듦", "hihatSemiOpen4", 63, /^hihatSemiOpen4_/],
  ["hi-hat-semi-open-5", "Hi-hat Semi-open 5", "하이햇 반열림 5", "더 길고 거친 금속성 울림을 남김", "hihatSemiOpen5", 81, /^hihatSemiOpen5_/],
  ["hi-hat-semi-open-6", "Hi-hat Semi-open 6", "하이햇 반열림 6", "거의 열린 상태의 넓고 긴 공명", "hihatSemiOpen6", 99, /^hihatSemiOpen6_/],
  ["hi-hat-semi-open-7", "Hi-hat Semi-open 7", "하이햇 반열림 7", "완전 오픈 직전의 가장 길고 거친 반열림", "hihatSemiOpen7", 118, /^hihatSemiOpen7_/]
];

const SALAMANDER_ENTRIES = {
  "sfz/ALL-full.sfz": ["salamander-all-full", "Complete Drum Kit", "complete-mapped-kit", "Complete Mapped Kit (전체 매핑 드럼킷) — 535개 완성된 원샷을 RR·초크로 사용하고 미편집 raw take는 별도 클립으로 제공", "drum-kit", true],
  "sfz/ALL.sfz": ["salamander-all-official", "Official Drum Kit Map", "official-mapped-kit", "Official Map (공식 매핑) — 공식 532개 참조 중 미편집 raw take를 분리한 531개와 원래 키 구조를 보존", "drum-kit", false],
  "sfz/crashesFX.sfz": ["salamander-crashes-fx", "Cymbals & Effects", "cymbals-and-effects", "Cymbals & Effects (심벌·효과) — 크래시·차이나·스플래시·카우벨과 초크", "drum-module", false],
  "sfz/hihat.sfz": ["salamander-hi-hat", "Hi-hat", "hi-hat", "Hi-hat (하이햇) — 닫힘·반열림·오픈·페달과 CC64 개방도", "drum-module", false],
  "sfz/hitom.sfz": ["salamander-high-tom", "High Tom", "high-tom", "High Tom (하이 톰) — 강약과 라운드로빈이 있는 높은 톰", "drum-module", false],
  "sfz/kick.sfz": ["salamander-kicks", "Kicks", "kicks", "Kicks (킥) — 서로 다른 두 베이스 드럼과 강약·랜덤 테이크", "drum-module", false],
  "sfz/lotom.sfz": ["salamander-low-tom", "Low Tom", "low-tom", "Low Tom (로우 톰) — 강약과 라운드로빈이 있는 낮은 톰", "drum-module", false],
  "sfz/ride.sfz": ["salamander-rides", "Rides", "rides", "Rides (라이드) — 보우·벨·크래시와 손으로 막는 초크", "drum-module", false],
  "sfz/snare.sfz": ["salamander-snares", "Snares", "snares", "Snares (스네어) — 두 스네어·와이어 오프·크로스 스틱·고스트 노트", "drum-module", false],
  "sfz-clips/kick-oh-p-1-raw-take.sfz": ["salamander-kick-raw-take", "Untrimmed Repeated Kick Raw Take", "recorded-raw-take", "Recorded Clip (녹음 클립) — 미편집 킥 반복 원본을 자르지 않고 한 번 재생", "clip", false]
};

function salamanderPiece(key, samplePaths, entryFile) {
  const metadata = SALAMANDER_PIECES[key];
  if (!metadata) fail(`${entryFile}: no piece metadata for key ${key}`);
  for (const sample of samplePaths) {
    const basename = path.posix.basename(sample);
    if (!metadata[5].test(basename)) fail(`${entryFile}: key ${key} references unexpected sample ${basename}`);
  }
  return {
    id: metadata[0],
    key,
    name: metadata[1],
    label: `${metadata[1]} (${metadata[2]}) — ${metadata[3]}`,
    sampleStem: metadata[4]
  };
}

function salamanderPiecesForKey(key, parsed, entryFile) {
  if (key !== 42) return [salamanderPiece(key, parsed.samplesByKey.get(key), entryFile)];
  return SALAMANDER_HIHAT_OPENNESS.map(metadata => {
    const [id, name, korean, explanation, sampleStem, value, pattern] = metadata;
    const matching = parsed.regions.filter(region => region.low <= key && region.high >= key &&
      pattern.test(path.posix.basename(region.sample)));
    if (!matching.length) fail(`${entryFile}: ${id}에 해당하는 실제 sample region이 없습니다`);
    return {
      id,
      key,
      name,
      label: `${name} (${korean}) — ${explanation}`,
      sampleStem,
      cc: [{ controller: 64, value }]
    };
  });
}

function regionMatchesPiece(region, piece) {
  if (region.low > piece.key || region.high < piece.key) return false;
  for (const control of piece.cc ?? []) {
    const lo = Number(region.opcodes[`locc${control.controller}`] ?? 0);
    const hi = Number(region.opcodes[`hicc${control.controller}`] ?? 127);
    if (control.value < lo || control.value > hi) return false;
  }
  return true;
}

async function buildSalamanderManifest(root) {
  const prepared = verifyPreparedRoot(root, "salamander-drumkit-sfz");
  const generatedCatalog = readJson(path.join(prepared.root, "catalog", "sfz.json")).value;
  if (!Array.isArray(generatedCatalog) || generatedCatalog.length !== 10)
    fail(`Salamander runtime catalog must contain 10 entries, got ${generatedCatalog?.length}`);
  const generatedByFile = new Map(generatedCatalog.map(entry => [entry.file, entry]));
  if (generatedByFile.size !== 10) fail("Salamander runtime catalog has duplicate paths");

  const sampleRows = readJson(path.join(prepared.root, "catalog", "samples.json")).value;
  if (!Array.isArray(sampleRows) || sampleRows.length !== 536) fail("Salamander sample catalog must contain 536 rows");
  const rawTakeFile = "samples/OH/kick_OH_P_1.wav";
  const durationProbe = await probeAudioDurations(prepared, sampleRows.map(sample => sample.file), [rawTakeFile]);

  const catalog = [];
  let referencedSamples = new Set();
  for (const [entryFile, metadata] of Object.entries(SALAMANDER_ENTRIES)) {
    const generated = generatedByFile.get(entryFile);
    if (!generated) fail(`Salamander generated catalog is missing ${entryFile}`);
    const parsed = parseRuntimeSfz(prepared, entryFile);
    if (parsed.regions.length !== generated.regions)
      fail(`${entryFile}: generated region count does not match runtime SFZ`);
    for (const region of parsed.regions) referencedSamples.add(region.sample);
    const keys = [...parsed.keys].sort((left, right) => left - right);
    const recordedClip = metadata[4] === "clip";
    const piecesWithoutDuration = recordedClip ? [{
      id: "play",
      key: 60,
      name: "Play",
      label: "Play (재생) — 미편집 킥 반복 원본을 한 번 재생",
      sampleStem: "kick_OH_P_1"
    }] : keys.flatMap(key => salamanderPiecesForKey(key, parsed, entryFile));
    if (recordedClip && (keys.length !== 1 || keys[0] !== 60 || parsed.regions.length !== 1 ||
        parsed.regions[0].sample !== rawTakeFile))
      fail(`${entryFile}: raw-take clip must map only the exact source to key 60`);
    if (piecesWithoutDuration.length === 0) fail(`${entryFile}: no mapped drum pieces`);
    const pieces = piecesWithoutDuration.map(piece => {
      const sampleFiles = [...new Set(parsed.regions.filter(region => regionMatchesPiece(region, piece))
        .map(region => region.sample))];
      if (!sampleFiles.length) fail(`${entryFile}: piece ${piece.id} has no samples at key ${piece.key}`);
      return {
        ...piece,
        durationSec: roundedSeconds(maxDurationFor(sampleFiles.map(file => ({ file })), durationProbe))
      };
    });
    const entrySampleRows = [...new Set(parsed.regions.map(region => region.sample))].map(file => ({ file }));
    const maxSampleDurationSec = roundedSeconds(maxDurationFor(entrySampleRows, durationProbe));
    const tailHintSec = ONE_SHOT_TAIL_AFTER_SAMPLE_SEC;
    catalog.push({
      id: metadata[0],
      path: entryFile,
      name: metadata[1],
      family: "Salamander Drumkit",
      articulation: metadata[2],
      duration: "one-shot",
      label: metadata[3],
      source: "Salamander Drumkit by Alexander Holm",
      category: "Drums",
      kind: metadata[4],
      recommended: metadata[5],
      gm: { bank: 128, program: 0 },
      gmApproximation: "GM percussion channel with exact Salamander key map (GM 타악기 채널·Salamander 실제 키 유지)",
      drum: true,
      maxSampleDurationSec,
      durationSec: maxSampleDurationSec,
      tailHintSec,
      release: ONE_SHOT_RELEASE_SEC,
      pieces
    });
    if (recordedClip) {
      const entry = catalog.at(-1);
      entry.duration = "recorded-clip";
      entry.clip = { sourceFile: rawTakeFile, reason: "untrimmed-repeated-kick-raw-take" };
    }
  }

  const allFull = catalog[0];
  if (!allFull.recommended || allFull.path !== "sfz/ALL-full.sfz" ||
      new Set(allFull.pieces.map(piece => piece.key)).size !== 30 || allFull.pieces.length !== 37)
    fail("Salamander ALL-full must be the first recommended complete 30-key / 37-control kit");
  const allFullParsed = parseRuntimeSfz(prepared, allFull.path);
  const allFullSamples = new Set(allFullParsed.regions.map(region => region.sample));
  if (allFullSamples.size !== 535 || allFullSamples.has(rawTakeFile))
    fail(`Salamander ALL-full must reference 535 trimmed one-shot sources and exclude the raw take, got ${allFullSamples.size}`);
  const checksumWav = new Set([...prepared.checksumMap.keys()].filter(file => file.endsWith(".wav")));
  if (checksumWav.size !== 536 || referencedSamples.size !== 536 ||
      [...checksumWav].some(file => !referencedSamples.has(file)))
    fail("Salamander runtime kit + recorded clip do not expose every checksummed WAV file");
  for (const entry of catalog.filter(entry => entry.kind !== "clip")) {
    const parsed = parseRuntimeSfz(prepared, entry.path);
    if (parsed.regions.some(region => region.sample === rawTakeFile))
      fail(`${entry.path}: untrimmed raw take leaked back into a drum-kit RR map`);
  }
  const longestSample = sampleRows.reduce((longest, sample) => {
    const durationSec = durationProbe.durations.get(sample.file);
    return !longest || durationSec > longest.durationSec ? { file: sample.file, durationSec } : longest;
  }, null);
  const longestKitSample = sampleRows.filter(sample => sample.file !== rawTakeFile).reduce((longest, sample) => {
    const durationSec = durationProbe.durations.get(sample.file);
    return !longest || durationSec > longest.durationSec ? { file: sample.file, durationSec } : longest;
  }, null);
  const rawTakeEntry = catalog.find(entry => entry.id === "salamander-kick-raw-take");
  if (!rawTakeEntry) fail("Salamander raw-take clip catalog entry is missing");
  const rawTakeRender = await verifyOneShotRender(prepared, rawTakeEntry.path, rawTakeEntry.durationSec);

  const manifest = baseManifest(prepared, {
    installDir: "salamander-drumkit-sfz",
    projectUrl: "https://archive.org/details/SalamanderDrumkit",
    prepareScript: "tools/prepare-salamander-sfz.mjs",
    defaultArchive: "~/.aria/downloads/salamanderDrumkit.tar.bz2",
    downloadUrl: "https://archive.org/download/SalamanderDrumkit/salamanderDrumkit.tar.bz2",
    audioExtensions: [".wav"],
    license: {
      spdx: "CC-BY-SA-3.0",
      name: "Creative Commons Attribution-ShareAlike 3.0 Unported",
      file: "official/REAMDE",
      url: "https://creativecommons.org/licenses/by-sa/3.0/"
    }
  });
  manifest.content.entryFiles = catalog.map(entry => entry.path);
  manifest.catalogMetadata = {
    sourceSamples: 536,
    runtimeEntries: 10,
    drumKitEntries: 9,
    recordedClipEntries: 1,
    recommendedEntry: "salamander-all-full",
    mappedKeys: 30,
    selectablePieces: catalog.reduce((sum, entry) => sum + entry.pieces.length, 0),
    hiHatOpennessControls: 8,
    missingRuntimeSamples: 0,
    allFullSampleCoverage: 535,
    runtimeSampleCoverage: 536,
    durationProbe: {
      allAudioFiles: 536,
      primaryMethod: durationProbe.method,
      ffprobeVerifiedFiles: durationProbe.ffprobeVerifiedFiles
    },
    sampleDurationSec: distribution([...durationProbe.durations.values()]),
    longestSample: {
      ...longestSample,
      tailHintSec: ONE_SHOT_TAIL_AFTER_SAMPLE_SEC,
      requiredRenderWindowFromNoteStartSec: safeTailHint(longestSample.durationSec)
    },
    longestKitSample: {
      ...longestKitSample,
      tailHintSec: ONE_SHOT_TAIL_AFTER_SAMPLE_SEC,
      requiredRenderWindowFromNoteStartSec: safeTailHint(longestKitSample.durationSec)
    },
    detachedRawTake: {
      catalogId: "salamander-kick-raw-take",
      sourceFile: rawTakeFile,
      durationSec: durationProbe.durations.get(rawTakeFile),
      tailHintSec: ONE_SHOT_TAIL_AFTER_SAMPLE_SEC,
      requiredRenderWindowFromNoteStartSec: safeTailHint(durationProbe.durations.get(rawTakeFile)),
      kitReferences: 0,
      clipReferences: 1,
      renderVerification: rawTakeRender
    },
    exactRoundRobinAndChokeMap: true
  };
  manifest.catalog = catalog;
  validateUniqueCatalog(catalog, manifest.content.entryFiles, "Salamander");
  return manifest;
}

function parseArguments(argv) {
  let philRoot = DEFAULT_PHILHARMONIA_ROOT;
  let salamanderRoot = DEFAULT_SALAMANDER_ROOT;
  let mode = "check";
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--phil-root") philRoot = argv[++index];
    else if (argument === "--salamander-root") salamanderRoot = argv[++index];
    else if (argument === "--write") mode = "write";
    else if (argument === "--check") mode = "check";
    else if (argument === "--help" || argument === "-h") {
      console.log(`Usage:
  node tools/build-legacy-pack-manifests.mjs --write [--phil-root DIR] [--salamander-root DIR]
  node tools/build-legacy-pack-manifests.mjs --check [--phil-root DIR] [--salamander-root DIR]

--write regenerates packs/philharmonia-all-sfz.json and packs/salamander-drumkit-sfz.json.
--check verifies prepared payloads and requires the checked-in manifests to be byte-for-byte current.`);
      return { exit: true };
    } else fail(`Unknown argument: ${argument}`);
    if ((argument === "--phil-root" || argument === "--salamander-root") &&
        (!argv[index] || argv[index].startsWith("--"))) fail(`${argument} requires a directory`);
  }
  return { philRoot: path.resolve(philRoot), salamanderRoot: path.resolve(salamanderRoot), mode };
}

function serialized(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function publishOrCheck(file, content, mode) {
  if (mode === "write") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o644 });
    return;
  }
  let existing;
  try { existing = fs.readFileSync(file, "utf8"); }
  catch { fail(`Manifest is missing; run with --write: ${file}`); }
  if (existing !== content) fail(`Manifest is stale; run with --write: ${file}`);
}

const args = parseArguments(process.argv.slice(2));
if (!args.exit) {
  const phil = await buildPhilharmoniaManifest(args.philRoot);
  const salamander = await buildSalamanderManifest(args.salamanderRoot);
  publishOrCheck(PHILHARMONIA_MANIFEST, serialized(phil), args.mode);
  publishOrCheck(SALAMANDER_MANIFEST, serialized(salamander), args.mode);
  console.log(JSON.stringify({
    mode: args.mode,
    philharmonia: {
      manifest: PHILHARMONIA_MANIFEST,
      entries: phil.catalog.length,
      instruments: phil.catalogMetadata.instrumentEntries,
      clips: phil.catalogMetadata.recordedClipEntries,
      sourceSamples: phil.catalogMetadata.sourceSamples,
      missing: phil.catalogMetadata.missingRuntimeSamples
    },
    salamander: {
      manifest: SALAMANDER_MANIFEST,
      entries: salamander.catalog.length,
      sourceSamples: salamander.catalogMetadata.sourceSamples,
      allFullCoverage: salamander.catalogMetadata.allFullSampleCoverage,
      missing: salamander.catalogMetadata.missingRuntimeSamples
    }
  }, null, 2));
}

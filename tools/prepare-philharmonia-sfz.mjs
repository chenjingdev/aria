#!/usr/bin/env node
// Philharmonia Orchestra의 공식 all-samples.zip을 손실 없이 SFZ 준비 팩으로 푼다.
//
// 이 도구는 설치 디렉터리(~/.aria/packs)를 직접 바꾸지 않는다. 지정한 새 output에만
// 원본 MP3, 재생 가능한 SFZ, 클립 카탈로그와 전 파일 체크섬을 원자적으로 만든다.
// 외부 unzip/ffmpeg/sfizz를 사용하기 전에 archive의 모든 경로와 파일 타입을 검사한다.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_ARCHIVE = path.join(os.homedir(), ".aria", "downloads", "philharmonia-all-samples.zip");
const STEADY_DYNAMICS = [
  "molto-pianissimo", "pianissimo", "piano", "mezzo-piano",
  "mezzo-forte", "forte", "fortissimo"
];
const DYNAMIC_INDEX = new Map(STEADY_DYNAMICS.map((value, index) => [value, index]));
const DURATIONS = ["025", "05", "1", "15", "long", "very-long", "phrase"];
const MOVING_CLIP = /(?:^|-)(?:glissando|effect|rhythm|scale|arpeggio)(?:-|$)/i;
const ARCHIVE_MAX_LISTING = 64 * 1024 * 1024;
const SOURCE_TERMS = `Philharmonia Orchestra Sound Samples — source terms summary

Official page: https://philharmonia.co.uk/resources/sound-samples/
Official archive: https://philharmonia-assets.s3-eu-west-1.amazonaws.com/uploads/2020/02/12112005/all-samples.zip
Accessed: 2026-08-09

Summary: Use in musical compositions, including commercial works, is allowed. The samples must not be sold or made available as-is, including as samples or as a sampler instrument.

This is a short source-grounded summary, not a substitute for the current terms on the official page above.
`;

export class PhilharmoniaPrepareError extends Error {
  constructor(code, message, details = undefined, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = "PhilharmoniaPrepareError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details, cause) {
  throw new PhilharmoniaPrepareError(code, message, details, cause);
}

export function safeArchiveEntry(value, label = "archive entry") {
  if (typeof value !== "string" || !value || value.includes("\0") || /[\r\n]/.test(value))
    fail("ARCHIVE_PATH_UNSAFE", `${label} 경로가 비어 있거나 제어 문자를 포함합니다`, { value });
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value))
    fail("ARCHIVE_PATH_UNSAFE", `${label}에 절대 경로나 역슬래시가 들어 있습니다`, { value });
  const directory = value.endsWith("/");
  const normalized = directory ? value.slice(0, -1) : value;
  const parts = normalized.split("/");
  if (!normalized || parts.some(part => !part || part === "." || part === ".."))
    fail("ARCHIVE_PATH_UNSAFE", `${label}이 archive 경계를 벗어날 수 있습니다`, { value });
  if (parts.some(part => /[\u0000-\u001f\u007f]/.test(part)))
    fail("ARCHIVE_PATH_UNSAFE", `${label}에 제어 문자가 들어 있습니다`, { value });
  return { path: normalized, directory };
}

function command(command, args, options = {}) {
  const child = spawnSync(command, args, {
    encoding: options.binary ? null : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: options.maxBuffer ?? ARCHIVE_MAX_LISTING,
    timeout: options.timeout ?? 15 * 60_000,
    cwd: options.cwd,
    env: options.env
  });
  if (child.error || child.status !== 0) {
    fail("COMMAND_FAILED", `${command} 실행에 실패했습니다`, {
      command, args, status: child.status, signal: child.signal,
      stdout: String(child.stdout ?? "").slice(-4000),
      stderr: String(child.stderr ?? "").slice(-4000)
    }, child.error);
  }
  return child.stdout;
}

export function inspectZipArchive(archive, label = path.basename(archive)) {
  let stat;
  try { stat = fs.statSync(archive); }
  catch (error) { fail("ARCHIVE_MISSING", `${label}을 읽을 수 없습니다: ${archive}`, { archive }, error); }
  if (!stat.isFile()) fail("ARCHIVE_MISSING", `${label}이 일반 파일이 아닙니다: ${archive}`, { archive });

  const names = String(command("unzip", ["-Z1", archive])).split(/\r?\n/).filter(Boolean);
  const verbose = String(command("unzip", ["-Z", "-l", archive])).split(/\r?\n/);
  const types = verbose.filter(line => /^[dl-][rwxast-]/.test(line)).map(line => line[0]);
  if (types.length !== names.length)
    fail("ARCHIVE_LIST_INVALID", `${label}의 경로 목록과 타입 목록 수가 다릅니다`, {
      names: names.length, types: types.length
    });
  const entries = names.map((name, index) => {
    const safe = safeArchiveEntry(name, `${label} entry`);
    const type = types[index];
    if (type !== "-" && type !== "d")
      fail("ARCHIVE_TYPE_UNSAFE", `${label}에 링크 또는 특수 파일이 있습니다`, { name, type });
    if ((type === "d") !== safe.directory)
      fail("ARCHIVE_TYPE_UNSAFE", `${label}의 디렉터리 표기가 일치하지 않습니다`, { name, type });
    return { ...safe, type };
  });
  if (!entries.length) fail("ARCHIVE_EMPTY", `${label}이 비어 있습니다`, { archive });
  return entries;
}

function ensureInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
    return candidate;
  fail("ARCHIVE_PATH_UNSAFE", `${label}이 준비 디렉터리를 벗어납니다`, { root, candidate });
}

function verifyExtractedTree(root) {
  const walk = directory => {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = ensureInside(root, path.join(directory, dirent.name), "extracted path");
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        fail("ARCHIVE_TYPE_UNSAFE", "압축 해제 결과에 링크 또는 특수 파일이 있습니다", { file });
      if (stat.isDirectory()) walk(file);
    }
  };
  walk(root);
}

function slug(value) {
  const result = value.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return result || `item-${crypto.createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}

function shortHash(value, length = 10) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function noteToMidi(note) {
  const match = /^([A-G])(s?)(-?\d+)$/.exec(note ?? "");
  if (!match) return null;
  const pitchClass = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]] + (match[2] ? 1 : 0);
  const midi = pitchClass + (Number(match[3]) + 1) * 12;
  return midi >= 0 && midi <= 127 ? midi : null;
}

export function parsePhilharmoniaFilename(file) {
  const base = path.posix.basename(file.replaceAll("\\", "/"));
  if (!base.toLowerCase().endsWith(".mp3")) return null;
  const duration = DURATIONS.join("|");
  const dynamics = [
    ...STEADY_DYNAMICS, "crescendo", "decrescendo", "cresc-decresc"
  ].sort((a, b) => b.length - a.length).join("|");
  const match = new RegExp(`^(.+?)_([A-G](?:s)?-?\\d+)?_(${duration})_(${dynamics})_(.*)\\.mp3$`, "i").exec(base);
  if (!match) return null;
  const note = match[2] || null;
  return {
    instrument: match[1], note, midi: note ? noteToMidi(note) : null,
    duration: match[3].toLowerCase(), dynamic: match[4].toLowerCase(),
    articulation: match[5].toLowerCase() || "unspecified"
  };
}

export function classifyPhilharmoniaSample(parsed) {
  if (!parsed) return { kind: "clip", reason: "filename-unparsed" };
  if (parsed.note && parsed.midi === null) return { kind: "clip", reason: "note-out-of-range" };
  if (parsed.duration === "phrase") return { kind: "clip", reason: "recorded-phrase" };
  if (!DYNAMIC_INDEX.has(parsed.dynamic)) return { kind: "clip", reason: "recorded-dynamic-curve" };
  if (MOVING_CLIP.test(parsed.articulation)) return { kind: "clip", reason: "moving-pitch-or-effect" };
  return { kind: "sfz", reason: parsed.note ? "pitched-region" : "unpitched-one-shot" };
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function mapLimit(values, limit, mapper) {
  const result = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      result[index] = await mapper(values[index], index);
    }
  }));
  return result;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o644 });
}

function acquireOutputLock(output) {
  const file = `${output}.aria-prepare.lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, output })}\n`);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fail(error.code === "EEXIST" ? "OUTPUT_LOCKED" : "OUTPUT_LOCK_FAILED",
      error.code === "EEXIST" ? `다른 준비 작업이 같은 output을 예약했습니다: ${file}` : `output lock을 만들 수 없습니다: ${file}`,
      { output, lock: file }, error);
  }
  return { file, descriptor };
}

function releaseOutputLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.descriptor); } catch {}
  try { fs.rmSync(lock.file, { force: true }); } catch {}
}

function defaultSfizzBinary() {
  if (process.env.ARIA_SFIZZ_BIN) return path.resolve(process.env.ARIA_SFIZZ_BIN);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "engines", "sfizz.json"), "utf8"));
  return path.join(os.homedir(), ".aria", "engines", "sfizz", manifest.commit.slice(0, 12), manifest.binaryRelativePath);
}

function midiProbeBuffer() {
  // Type-0, 480 PPQ: tempo, middle-C note for one quarter, endpoint marker, EOT.
  const body = Buffer.from([
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    0x00, 0x90, 0x3c, 0x64,
    0x83, 0x60, 0x80, 0x3c, 0x00,
    0x83, 0x60, 0xff, 0x7f, 0x00,
    0x00, 0xff, 0x2f, 0x00
  ]);
  const header = Buffer.alloc(14), track = Buffer.alloc(8);
  header.write("MThd", 0); header.writeUInt32BE(6, 4); header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10); header.writeUInt16BE(480, 12);
  track.write("MTrk", 0); track.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, track, body]);
}

function wavHasSignal(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE")
    return false;
  let format = null, data = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4), size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size;
    if (end > buffer.length) return false;
    if (id === "fmt " && size >= 16)
      format = { encoding: buffer.readUInt16LE(start), bits: buffer.readUInt16LE(start + 14) };
    if (id === "data") data = { start, end };
    offset = end + (size & 1);
  }
  if (!format || !data) return false;
  if (format.encoding === 1 && format.bits === 16) {
    for (let offset = data.start; offset + 2 <= data.end; offset += 2)
      if (Math.abs(buffer.readInt16LE(offset)) > 2) return true;
  } else if (format.encoding === 3 && format.bits === 32) {
    for (let offset = data.start; offset + 4 <= data.end; offset += 4)
      if (Math.abs(buffer.readFloatLE(offset)) > 1e-5) return true;
  }
  return false;
}

export async function probeSfizzMp3Support(options = {}) {
  const binary = path.resolve(options.sfizzBinary ?? defaultSfizzBinary());
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  let stat;
  try { stat = fs.statSync(binary); }
  catch (error) { fail("SFIZZ_MISSING", `sfizz_render를 읽을 수 없습니다: ${binary}`, { binary }, error); }
  if (!stat.isFile() || (stat.mode & 0o111) === 0)
    fail("SFIZZ_MISSING", `sfizz_render가 실행 가능한 일반 파일이 아닙니다: ${binary}`, { binary });
  command(binary, ["--help"], { maxBuffer: 2 * 1024 * 1024 });
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aria-phil-mp3-probe-")));
  try {
    const mp3 = path.join(temporary, "probe.mp3");
    command(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "sine=frequency=440:duration=0.5", "-ar", "44100", "-ac", "1",
      "-codec:a", "libmp3lame", "-b:a", "128k", "-map_metadata", "-1", "-y", mp3
    ]);
    fs.writeFileSync(path.join(temporary, "probe.sfz"),
      "<group> lovel=0 hivel=127\n<region> key=60 pitch_keycenter=60 sample=probe.mp3\n", { flag: "wx" });
    fs.writeFileSync(path.join(temporary, "probe.mid"), midiProbeBuffer(), { flag: "wx" });
    const render = spawnSync(binary, [
      "--sfz", path.join(temporary, "probe.sfz"), "--midi", path.join(temporary, "probe.mid"),
      "--wav", path.join(temporary, "probe.wav"), "--samplerate", "44100", "--use-eot"
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const supported = !render.error && render.status === 0 && fs.existsSync(path.join(temporary, "probe.wav")) &&
      wavHasSignal(path.join(temporary, "probe.wav"));
    const version = String(command(ffmpeg, ["-version"], { maxBuffer: 2 * 1024 * 1024 })).split(/\r?\n/)[0];
    return {
      supported,
      engine: "sfizz",
      binarySha256: await sha256File(binary),
      ffmpeg: version,
      failure: supported ? null : {
        status: render.status, signal: render.signal,
        stderr: String(render.stderr ?? "").slice(-2000)
      }
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function extractNestedZip(outerArchive, entry, destination) {
  const inner = command("unzip", ["-p", outerArchive, entry], {
    binary: true, maxBuffer: 128 * 1024 * 1024
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, inner, { flag: "wx", mode: 0o600 });
}

function extractValidatedZip(archive, destination, entries) {
  fs.mkdirSync(destination, { recursive: true });
  command("unzip", ["-qq", "-n", archive, "-d", destination]);
  verifyExtractedTree(destination);
  const expected = new Set(entries.filter(entry => entry.type === "-").map(entry => entry.path));
  const found = [];
  const walk = (directory, prefix = "") => {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) walk(path.join(directory, dirent.name), relative);
      else found.push(relative);
    }
  };
  walk(destination);
  if (found.length !== expected.size || found.some(file => !expected.has(file)))
    fail("ARCHIVE_EXTRACT_MISMATCH", "압축 경로 목록과 실제 추출 결과가 다릅니다", {
      expected: expected.size, found: found.length
    });
  return found;
}

function convertToFlac(source, destination, ffmpeg) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  command(ffmpeg, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-fflags", "+bitexact", "-i", source,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
    "-codec:a", "flac", "-compression_level", "8", "-sample_fmt", "s16",
    "-flags:a", "+bitexact", "-metadata", "encoder=", "-y", destination
  ]);
}

function velocityBands(records) {
  const layers = [...new Set(records.map(record => record.dynamic))]
    .sort((a, b) => DYNAMIC_INDEX.get(a) - DYNAMIC_INDEX.get(b));
  return new Map(layers.map((dynamic, index) => [dynamic, {
    lo: index === 0 ? 1 : Math.floor(127 * index / layers.length) + 1,
    hi: index === layers.length - 1 ? 127 : Math.floor(127 * (index + 1) / layers.length)
  }]));
}

function keyBands(records) {
  const roots = [...new Set(records.map(record => record.midi).filter(value => value !== null))].sort((a, b) => a - b);
  return new Map(roots.map((root, index) => [root, {
    lo: index === 0 ? Math.max(0, root - 2) : Math.floor((roots[index - 1] + root) / 2) + 1,
    hi: index === roots.length - 1 ? Math.min(127, root + 2) : Math.floor((root + roots[index + 1]) / 2)
  }]));
}

function generateSfzFiles(stage, records) {
  const playable = records.filter(record => record.kind === "sfz");
  const groups = new Map();
  for (const record of playable) {
    const mode = record.midi === null ? "one-shot" : "pitched";
    const key = [record.instrument, record.articulation, record.duration, mode].join("\0");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const definitions = [];
  for (const [groupKey, groupRecords] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    groupRecords.sort((a, b) => (a.midi ?? 60) - (b.midi ?? 60) ||
      DYNAMIC_INDEX.get(a.dynamic) - DYNAMIC_INDEX.get(b.dynamic) || a.original.localeCompare(b.original));
    const first = groupRecords[0];
    const relativeFile = `sfz/${slug(first.instrument)}/${slug(first.articulation)}-${slug(first.duration)}-${shortHash(groupKey)}.sfz`;
    const output = path.join(stage, ...relativeFile.split("/"));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const keys = keyBands(groupRecords);
    const lines = [
      "// Generated from the official Philharmonia Orchestra sample archive.",
      `// Instrument: ${first.instrument}; articulation: ${first.articulation}; duration: ${first.duration}`,
      `<global> ampeg_release=${first.midi === null ? "4.0" : "0.12"}`
    ];
    const cells = new Map();
    for (const record of groupRecords) {
      const cell = `${record.midi ?? 60}\0${record.dynamic}`;
      if (!cells.has(cell)) cells.set(cell, []);
      cells.get(cell).push(record);
    }
    for (const cellRecords of cells.values()) {
      const root = cellRecords[0].midi ?? 60;
      const key = cellRecords[0].midi === null ? { lo: 60, hi: 60 } : keys.get(root);
      // 녹음된 dynamic 수가 음마다 다르다. 그룹 전체 레이어 경계를 재사용하면 특정 음에
      // 없는 dynamic 자리만큼 velocity 무음 구멍이 생기므로, 각 root의 가용 레이어만으로
      // 1~127을 다시 완전히 나눈다.
      const rootRecords = groupRecords.filter(record => (record.midi ?? 60) === root);
      const velocity = velocityBands(rootRecords).get(cellRecords[0].dynamic);
      for (const [index, record] of cellRecords.entries()) {
        const sample = path.relative(path.dirname(output), path.join(stage, ...record.playable.split("/"))).split(path.sep).join("/");
        const rr = cellRecords.length > 1 ? ` seq_length=${cellRecords.length} seq_position=${index + 1}` : "";
        lines.push(`<region> lokey=${key.lo} hikey=${key.hi} pitch_keycenter=${root} lovel=${velocity.lo} hivel=${velocity.hi}${rr} loop_mode=${record.midi === null ? "one_shot" : "no_loop"} sample=${sample}`);
        record.sfz = relativeFile;
      }
    }
    fs.writeFileSync(output, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o644 });
    definitions.push({
      file: relativeFile,
      instrument: first.instrument,
      articulation: first.articulation,
      duration: first.duration,
      type: first.midi === null ? "unpitched-one-shot" : "pitched",
      regions: groupRecords.length,
      sourceSamples: groupRecords.map(record => record.id).sort()
    });
  }
  return definitions;
}

function generateClipSfzFiles(stage, records) {
  const definitions = [];
  for (const record of records.filter(record => record.kind === "clip")
    .sort((a, b) => a.sourceArchive.localeCompare(b.sourceArchive) || a.sourceEntry.localeCompare(b.sourceEntry))) {
    const instrument = record.instrument ?? path.posix.basename(record.sourceArchive, ".zip");
    const articulation = record.articulation ?? record.reason;
    const duration = record.duration ?? "clip";
    const relativeFile = `sfz-clips/${slug(instrument)}/${slug(articulation)}-${slug(duration)}-${record.id}.sfz`;
    const output = path.join(stage, ...relativeFile.split("/"));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const sample = path.relative(path.dirname(output), path.join(stage, ...record.playable.split("/"))).split(path.sep).join("/");
    const lines = [
      "// Recorded clip from the official Philharmonia Orchestra sample archive.",
      "// Key 60 plays the original phrase/effect once without treating it as a pitched instrument.",
      `<region> key=60 pitch_keycenter=60 lovel=1 hivel=127 loop_mode=one_shot sample=${sample}`
    ];
    fs.writeFileSync(output, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o644 });
    record.sfz = relativeFile;
    definitions.push({
      file: relativeFile,
      instrument,
      articulation,
      duration,
      type: "recorded-clip",
      clipReason: record.reason,
      regions: 1,
      sourceSamples: [record.id],
      playKey: 60
    });
  }
  return definitions;
}

function sampleReferences(sfz) {
  return fs.readFileSync(sfz, "utf8").split(/\r?\n/).flatMap(line => {
    const match = /(?:^|\s)sample=(.+?)\s*$/.exec(line.replace(/\s*\/\/.*$/, ""));
    return match ? [match[1].trim().replaceAll("\\", "/")] : [];
  });
}

export function verifyPreparedPhilharmonia(root) {
  const samples = JSON.parse(fs.readFileSync(path.join(root, "catalog", "samples.json"), "utf8"));
  const instruments = JSON.parse(fs.readFileSync(path.join(root, "catalog", "sfz.json"), "utf8"));
  const ids = new Set();
  let missingOriginals = 0, missingPlayable = 0, invalidPlayable = 0, missingSfzSamples = 0;
  let duplicateIds = 0, sfzReferences = 0, sourceDefects = 0;
  let velocityHoles = 0;
  for (const sample of samples) {
    if (ids.has(sample.id)) duplicateIds++;
    ids.add(sample.id);
    const original = path.join(root, ...sample.original.split("/"));
    if (!fs.existsSync(original)) missingOriginals++;
    if (sample.kind === "source-defect") {
      sourceDefects++;
      if (sample.playable !== undefined || sample.reason !== "empty-source-file" ||
          !fs.existsSync(original) || fs.statSync(original).size !== 0) invalidPlayable++;
    } else if (typeof sample.playable !== "string" || !fs.existsSync(path.join(root, ...sample.playable.split("/")))) {
      missingPlayable++;
    } else if (fs.statSync(path.join(root, ...sample.playable.split("/"))).size === 0) {
      invalidPlayable++;
    }
  }
  for (const definition of instruments) {
    const sfz = path.join(root, ...definition.file.split("/"));
    const text = fs.readFileSync(sfz, "utf8");
    for (const reference of sampleReferences(sfz)) {
      sfzReferences++;
      const resolved = path.resolve(path.dirname(sfz), ...reference.split("/"));
      if (!fs.existsSync(resolved) || fs.statSync(resolved).size === 0) missingSfzSamples++;
    }
    const byRoot = new Map();
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*<region>/.test(line)) continue;
      const value = opcode => Number(new RegExp(`\\b${opcode}=(\\d+)`).exec(line)?.[1]);
      const rootKey = value("pitch_keycenter"), lo = value("lovel"), hi = value("hivel");
      if (![rootKey, lo, hi].every(Number.isInteger)) continue;
      if (!byRoot.has(rootKey)) byRoot.set(rootKey, []);
      byRoot.get(rootKey).push({ lo, hi });
    }
    for (const ranges of byRoot.values())
      for (let velocity = 1; velocity <= 127; velocity++)
        if (!ranges.some(range => velocity >= range.lo && velocity <= range.hi)) velocityHoles++;
  }
  const playableIds = samples.filter(sample => sample.kind !== "source-defect");
  const mappedIds = new Set(instruments.flatMap(definition => definition.sourceSamples));
  const unmappedPlayable = playableIds.filter(sample => !mappedIds.has(sample.id)).length;
  const clipsPlayable = samples.filter(sample => sample.kind === "clip" &&
    sample.sfz && mappedIds.has(sample.id) && fs.existsSync(path.join(root, ...sample.sfz.split("/")))).length;
  return {
    samples: samples.length, sfzFiles: instruments.length, sfzReferences,
    missingOriginals, missingPlayable, invalidPlayable, missingSfzSamples, duplicateIds, unmappedPlayable,
    velocityHoles, clipsPlayable, sourceDefects
  };
}

async function fileInventory(root, excluded = new Set()) {
  const files = [];
  const walk = directory => {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, dirent.name);
      if (dirent.isDirectory()) walk(file);
      else files.push(path.relative(root, file).split(path.sep).join("/"));
    }
  };
  walk(root);
  const selected = files.filter(file => !excluded.has(file));
  const hashes = await mapLimit(selected, 12, async file => ({
    file, bytes: fs.statSync(path.join(root, ...file.split("/"))).size,
    sha256: await sha256File(path.join(root, ...file.split("/")))
  }));
  return hashes.sort((a, b) => a.file.localeCompare(b.file));
}

export async function preparePhilharmoniaPack(options = {}) {
  const archive = path.resolve(options.archive ?? DEFAULT_ARCHIVE);
  if (!options.output) fail("OUTPUT_REQUIRED", "--output으로 새 준비 디렉터리를 지정해야 합니다");
  const output = path.resolve(options.output);
  if (fs.existsSync(output)) fail("OUTPUT_EXISTS", `기존 경로를 덮어쓰지 않습니다: ${output}`, { output });
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const lock = acquireOutputLock(output);
  const stage = path.join(parent, `.${path.basename(output)}.prepare-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  const progress = typeof options.progress === "function" ? options.progress : () => {};
  try {
    fs.mkdirSync(stage, { recursive: false, mode: 0o755 });
    progress("archive-hash", { archive });
    const archiveSha256 = await sha256File(archive);
    progress("archive-inspect", { archive });
    const outer = inspectZipArchive(archive, "Philharmonia all-samples.zip");
    const nested = outer.filter(entry => entry.type === "-" && /^all-samples\/[^/]+\.zip$/i.test(entry.path));
    const expectedNested = options.expectedNestedArchives ?? 20;
    if (nested.length !== expectedNested)
      fail("ARCHIVE_CONTENT_MISMATCH", `악기별 내부 ZIP이 ${expectedNested}개여야 하지만 ${nested.length}개입니다`, { nested });
    const records = [];
    for (const [nestedIndex, nestedEntry] of nested.sort((a, b) => a.path.localeCompare(b.path)).entries()) {
      progress("nested-extract", { index: nestedIndex + 1, total: nested.length, entry: nestedEntry.path });
      const archiveName = path.posix.basename(nestedEntry.path, ".zip");
      const archiveSlug = slug(archiveName);
      const innerZip = path.join(stage, ".work", `${archiveSlug}-${shortHash(nestedEntry.path)}.zip`);
      extractNestedZip(archive, nestedEntry.path, innerZip);
      const innerEntries = inspectZipArchive(innerZip, nestedEntry.path);
      const originalRoot = path.join(stage, "originals", archiveSlug);
      const extracted = extractValidatedZip(innerZip, originalRoot, innerEntries);
      const mp3Files = extracted.filter(file => file.toLowerCase().endsWith(".mp3"));
      const expectedMp3 = innerEntries.filter(entry => entry.type === "-" && entry.path.toLowerCase().endsWith(".mp3")).length;
      if (mp3Files.length !== expectedMp3)
        fail("ARCHIVE_EXTRACT_MISMATCH", `${nestedEntry.path}의 MP3 수가 다릅니다`, { expectedMp3, actual: mp3Files.length });
      for (const innerPath of mp3Files.sort()) {
        const original = `originals/${archiveSlug}/${innerPath}`;
        const sourceBytes = fs.statSync(path.join(stage, ...original.split("/"))).size;
        const parsed = parsePhilharmoniaFilename(innerPath);
        // The official archive contains two named .mp3 entries whose payload is
        // literally zero bytes. Preserve them as source evidence, but never put a
        // zero-byte file in an SFZ and pretend it is playable.
        const classification = sourceBytes === 0
          ? { kind: "source-defect", reason: "empty-source-file" }
          : classifyPhilharmoniaSample(parsed);
        records.push({
          id: shortHash(`${nestedEntry.path}\0${innerPath}`, 20),
          sourceArchive: nestedEntry.path,
          sourceEntry: innerPath,
          original,
          sourceBytes,
          ...parsed,
          ...classification
        });
      }
    }
    fs.rmSync(path.join(stage, ".work"), { recursive: true, force: true });
    const expectedSamples = options.expectedSamples ?? 13_683;
    if (records.length !== expectedSamples)
      fail("ARCHIVE_CONTENT_MISMATCH", `원본 MP3가 ${expectedSamples}개여야 하지만 ${records.length}개입니다`, {
        expectedSamples, actual: records.length
      });
    const expectedSourceDefects = options.expectedSourceDefects ?? (expectedSamples === 13_683 ? 2 : 0);
    const detectedSourceDefects = records.filter(record => record.kind === "source-defect");
    if (detectedSourceDefects.length !== expectedSourceDefects)
      fail("ARCHIVE_CONTENT_MISMATCH", `0바이트 공식 원본이 ${expectedSourceDefects}개여야 하지만 ${detectedSourceDefects.length}개입니다`, {
        expectedSourceDefects,
        actual: detectedSourceDefects.map(record => record.sourceEntry)
      });

    progress("engine-probe", {});
    const probe = options.engineProbe ?? await probeSfizzMp3Support({
      sfizzBinary: options.sfizzBinary, ffmpeg: options.ffmpeg
    });
    if (!probe || typeof probe.supported !== "boolean")
      fail("PROBE_INVALID", "engineProbe 결과에 supported boolean이 없습니다", { probe });
    const ffmpeg = options.ffmpeg ?? "ffmpeg";
    const playableRecords = records.filter(record => record.kind !== "source-defect");
    if (!probe.supported) {
      progress("audio-convert", { total: playableRecords.length });
      await mapLimit(playableRecords, options.conversionConcurrency ?? 4, async (record, index) => {
        const relative = record.original.replace(/^originals\//, "audio/").replace(/\.mp3$/i, ".flac");
        convertToFlac(path.join(stage, ...record.original.split("/")), path.join(stage, ...relative.split("/")), ffmpeg);
        record.playable = relative;
        if (options.onConverted) options.onConverted({ index: index + 1, total: playableRecords.length, record });
      });
    } else {
      for (const record of playableRecords) record.playable = record.original;
    }

    progress("checksum", { total: records.length });
    await mapLimit(records, 16, async record => {
      record.originalSha256 = await sha256File(path.join(stage, ...record.original.split("/")));
      record.playableSha256 = record.playable === undefined ? null : record.playable === record.original
        ? record.originalSha256
        : await sha256File(path.join(stage, ...record.playable.split("/")));
    });
    const instrumentDefinitions = generateSfzFiles(stage, records);
    const clipDefinitions = generateClipSfzFiles(stage, records);
    const definitions = [...instrumentDefinitions, ...clipDefinitions].sort((a, b) => a.file.localeCompare(b.file));
    fs.mkdirSync(path.join(stage, "official"), { recursive: true });
    fs.writeFileSync(path.join(stage, "official", "SOURCE_TERMS.txt"), SOURCE_TERMS, {
      flag: "wx", mode: 0o644
    });
    const samplesCatalog = records.sort((a, b) => a.sourceArchive.localeCompare(b.sourceArchive) || a.sourceEntry.localeCompare(b.sourceEntry));
    const clips = samplesCatalog.filter(record => record.kind === "clip");
    const sourceDefects = samplesCatalog.filter(record => record.kind === "source-defect");
    writeJson(path.join(stage, "catalog", "samples.json"), samplesCatalog);
    writeJson(path.join(stage, "catalog", "clips.json"), clips);
    writeJson(path.join(stage, "catalog", "source-defects.json"), sourceDefects);
    writeJson(path.join(stage, "catalog", "sfz.json"), definitions);

    const verification = verifyPreparedPhilharmonia(stage);
    if (Object.entries(verification).some(([key, value]) =>
      key.startsWith("missing") || key.startsWith("duplicate") || key.startsWith("unmapped") ||
        key === "invalidPlayable" || key === "velocityHoles"
        ? value !== 0 : false))
      fail("PREPARE_VERIFY_FAILED", "준비된 Philharmonia 팩에 누락 또는 중복이 있습니다", verification);
    if (verification.sourceDefects !== expectedSourceDefects)
      fail("PREPARE_VERIFY_FAILED", "공식 0바이트 source defect 수가 예상과 다릅니다", verification);
    if (verification.clipsPlayable !== clips.length)
      fail("PREPARE_VERIFY_FAILED", "녹음 clip 중 one-shot SFZ로 재생할 수 없는 항목이 있습니다", {
        expected: clips.length, actual: verification.clipsPlayable
      });
    const finalArchiveSha256 = await sha256File(archive);
    if (finalArchiveSha256 !== archiveSha256)
      fail("ARCHIVE_CHANGED", "준비 중 원본 archive가 바뀌어 결과를 게시하지 않습니다", {
        before: archiveSha256, after: finalArchiveSha256
      });
    const inventory = await fileInventory(stage, new Set(["catalog/checksums.json", "pack.json"]));
    writeJson(path.join(stage, "catalog", "checksums.json"), inventory);
    const checksumsSha256 = await sha256File(path.join(stage, "catalog", "checksums.json"));
    const manifest = {
      format: 1,
      id: "philharmonia-all-sfz",
      name: "Philharmonia Orchestra — complete sample archive",
      source: {
        url: "https://philharmonia.co.uk/resources/sound-samples/",
        archive: path.basename(archive), sha256: archiveSha256,
        nestedArchives: nested.length,
        terms: "official/SOURCE_TERMS.txt"
      },
      audio: {
        originals: records.length,
        playableSources: playableRecords.length,
        sourceDefects: sourceDefects.length,
        playableFormat: probe.supported ? "mp3" : "flac",
        conversion: probe.supported ? null : "ffmpeg bitexact FLAC, s16, compression level 8"
      },
      engineProbe: {
        engine: probe.engine ?? "sfizz", supportedMp3: probe.supported,
        binarySha256: probe.binarySha256 ?? null, ffmpeg: probe.ffmpeg ?? null
      },
      counts: {
        sourceMp3: records.length,
        playableSourceMp3: playableRecords.length,
        sourceDefects: sourceDefects.length,
        playableSfzSamples: records.filter(record => record.kind === "sfz").length,
        clipCatalogSamples: clips.length,
        instrumentSfzFiles: instrumentDefinitions.length,
        recordedClipSfzFiles: clipDefinitions.length,
        sfzFiles: definitions.length,
        sfzReferences: verification.sfzReferences,
        missingSamples: 0,
        unplayableOfficialSourceFiles: sourceDefects.length
      },
      checksums: { file: "catalog/checksums.json", sha256: checksumsSha256 },
      limitations: [
        "원본에 녹음된 레가토·프레이즈는 true-legato 전이 샘플로 재구성하지 않고 key 60 one-shot clip으로 원형 재생한다.",
        "자동 SFZ는 원본에 없는 sustain loop를 발명하지 않는다. 각 녹음은 자연 길이까지만 재생된다.",
        "phrase, glissando, effect, rhythm 및 crescendo/decrescendo 녹음은 단일 음정 preset으로 오해하지 않도록 Recorded Clip으로 분리한다.",
        "공식 ZIP의 saxophone_Fs3_15_fortissimo_normal.mp3와 viola_D6_05_piano_arco-normal.mp3는 원본부터 0바이트다. 파일과 결함 기록은 보존하지만 SFZ에는 연결하지 않으며, 같은 음의 실제 레이어로 velocity 범위를 다시 나눠 무음 오류를 숨기지 않는다."
      ]
    };
    writeJson(path.join(stage, "pack.json"), manifest);
    if (fs.existsSync(output))
      fail("OUTPUT_RACE", `준비 중 output 경로가 새로 생겨 덮어쓰지 않습니다: ${output}`, { output });
    fs.renameSync(stage, output);
    progress("complete", { output, counts: manifest.counts });
    return { output, manifest, verification };
  } catch (error) {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  } finally {
    releaseOutputLock(lock);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--archive") options.archive = argv[++index];
    else if (value === "--output") options.output = argv[++index];
    else if (value === "--sfizz-binary") options.sfizzBinary = argv[++index];
    else if (value === "--ffmpeg") options.ffmpeg = argv[++index];
    else if (value === "--help" || value === "-h") options.help = true;
    else fail("ARGUMENT_INVALID", `알 수 없는 인자입니다: ${value}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node tools/prepare-philharmonia-sfz.mjs [--archive FILE] --output NEW_DIRECTORY [--sfizz-binary FILE] [--ffmpeg FILE]");
  } else {
    options.progress = (phase, detail) => console.log(`[${phase}] ${JSON.stringify(detail)}`);
    preparePhilharmoniaPack(options).then(result => {
      console.log(JSON.stringify({ output: result.output, counts: result.manifest.counts, verification: result.verification }, null, 2));
    }).catch(error => {
      console.error(`${error.code ?? error.name}: ${error.message}`);
      if (error.details) console.error(JSON.stringify(error.details, null, 2));
      process.exitCode = 1;
    });
  }
}

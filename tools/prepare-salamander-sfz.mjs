#!/usr/bin/env node
// Salamander Drumkit 공식 tar.bz2를 sfizz용 무손실 준비 팩으로 만든다.
// 공식 SFZ 8개는 그대로 보존하고, 재생용 사본은 POSIX sample 경로로 정규화한다.
// 공식 ALL.sfz가 참조하지 않은 4개 take도 같은 velocity/RR 그룹에 합친 ALL-full.sfz를 만든다.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const DEFAULT_ARCHIVE = path.join(os.homedir(), ".aria", "downloads", "salamanderDrumkit.tar.bz2");
const OFFICIAL_SFZ = [
  "ALL.sfz", "crashesFX.sfz", "hihat.sfz", "hitom.sfz",
  "kick.sfz", "lotom.sfz", "ride.sfz", "snare.sfz"
];
const RAW_TAKE_SOURCE = "OH/kick_OH_P_1.wav";
const RAW_TAKE_REFERENCE = `../samples/${RAW_TAKE_SOURCE}`;
const RAW_TAKE_SFZ = "sfz-clips/kick-oh-p-1-raw-take.sfz";
const MAX_OUTPUT = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export class SalamanderPrepareError extends Error {
  constructor(code, message, details = undefined, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = "SalamanderPrepareError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details, cause) {
  throw new SalamanderPrepareError(code, message, details, cause);
}

export function safeTarEntry(value, label = "tar entry") {
  if (typeof value !== "string" || !value || value.includes("\0") || /[\r\n]/.test(value))
    fail("ARCHIVE_PATH_UNSAFE", `${label} 경로가 비어 있거나 제어 문자를 포함합니다`, { value });
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value))
    fail("ARCHIVE_PATH_UNSAFE", `${label}에 절대 경로나 역슬래시가 들어 있습니다`, { value });
  const directory = value.endsWith("/");
  const normalized = directory ? value.slice(0, -1) : value;
  const parts = normalized.split("/");
  if (!normalized || parts.some(part => !part || part === "." || part === "..") ||
      parts.some(part => /[\u0000-\u001f\u007f]/.test(part)))
    fail("ARCHIVE_PATH_UNSAFE", `${label}이 archive 경계를 벗어날 수 있습니다`, { value });
  return { path: normalized, directory };
}

function command(program, args, options = {}) {
  const child = spawnSync(program, args, {
    encoding: options.binary ? null : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: options.maxBuffer ?? MAX_OUTPUT,
    timeout: options.timeout ?? 15 * 60_000,
    cwd: options.cwd,
    env: options.env
  });
  if (child.error || child.status !== 0)
    fail("COMMAND_FAILED", `${program} 실행에 실패했습니다`, {
      program, args, status: child.status, signal: child.signal,
      stdout: String(child.stdout ?? "").slice(-4000),
      stderr: String(child.stderr ?? "").slice(-4000)
    }, child.error);
  return child.stdout;
}

export async function inspectTarArchive(archive, label = path.basename(archive)) {
  let stat;
  try { stat = fs.statSync(archive); }
  catch (error) { fail("ARCHIVE_MISSING", `${label}을 읽을 수 없습니다: ${archive}`, { archive }, error); }
  if (!stat.isFile()) fail("ARCHIVE_MISSING", `${label}이 일반 파일이 아닙니다`, { archive });
  let listed;
  try {
    listed = await Promise.all([
      execFileAsync("tar", ["-tjf", archive], { encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout: 15 * 60_000 }),
      execFileAsync("tar", ["-tvjf", archive], { encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout: 15 * 60_000 })
    ]);
  } catch (error) {
    fail("COMMAND_FAILED", "tar archive 목록 검사에 실패했습니다", {
      archive, stdout: String(error.stdout ?? "").slice(-4000), stderr: String(error.stderr ?? "").slice(-4000)
    }, error);
  }
  const names = String(listed[0].stdout).split(/\r?\n/).filter(Boolean);
  const verbose = String(listed[1].stdout).split(/\r?\n/).filter(Boolean);
  if (names.length !== verbose.length)
    fail("ARCHIVE_LIST_INVALID", `${label}의 경로 목록과 타입 목록 수가 다릅니다`, {
      names: names.length, types: verbose.length
    });
  const entries = names.map((name, index) => {
    const safe = safeTarEntry(name, `${label} entry`);
    const type = verbose[index][0];
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

function extractedFiles(root) {
  const result = [];
  const walk = (directory, prefix = "") => {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = ensureInside(root, path.join(directory, dirent.name), "extracted path");
      const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        fail("ARCHIVE_TYPE_UNSAFE", "압축 해제 결과에 링크 또는 특수 파일이 있습니다", { file });
      if (stat.isDirectory()) walk(file, relative);
      else result.push(relative);
    }
  };
  walk(root);
  return result;
}

function extractValidatedTar(archive, destination, entries) {
  fs.mkdirSync(destination, { recursive: true });
  command("tar", [
    "-xjf", archive, "-C", destination, "--no-same-owner", "--no-same-permissions"
  ], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const actual = extractedFiles(destination);
  const expected = new Set(entries.filter(entry => entry.type === "-").map(entry => entry.path));
  if (actual.length !== expected.size || actual.some(file => !expected.has(file)))
    fail("ARCHIVE_EXTRACT_MISMATCH", "tar 경로 목록과 실제 추출 결과가 다릅니다", {
      expected: expected.size, actual: actual.length
    });
  return actual;
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

export function sfzSampleReferences(text) {
  const references = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s*\/\/.*$/, "");
    const match = /(?:^|\s)sample=([^\s]+)/i.exec(line);
    if (match) references.push(match[1].replaceAll("\\", "/"));
  }
  return references;
}

export function normalizeOfficialSfz(text) {
  const source = String(text).replace(/\r\n?/g, "\n");
  if (/^\s*#(?:include|define)\b/im.test(source) || /(?:^|\s)default_path\s*=/i.test(source))
    fail("SFZ_PATH_UNSAFE", "공식 SFZ의 include, macro 또는 default_path는 안전하게 정규화할 수 없습니다");
  return source.split("\n").map(line =>
    line.replace(/sample=([^\s]+)/gi, (_match, sample) => {
      if (sample.startsWith("*") || /["'$]/.test(sample))
        fail("SFZ_PATH_UNSAFE", "공식 SFZ sample 경로에 지원하지 않는 특수 표기가 있습니다", { sample });
      const normalized = sample.replaceAll("\\", "/").replace(/^\.\//, "");
      const safe = safeTarEntry(normalized, "SFZ sample");
      if (safe.directory || !safe.path.startsWith("OH/") || !safe.path.toLowerCase().endsWith(".wav"))
        fail("SFZ_PATH_UNSAFE", "Salamander SFZ sample은 OH 아래 WAV여야 합니다", { sample, normalized });
      return `sample=../samples/${safe.path}`;
    })
  ).join("\n").replace(/\n*$/, "\n");
}

export function detachRawTake(text, reference = RAW_TAKE_REFERENCE) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let removed = 0;
  const filtered = lines.filter(line => {
    if (!sfzSampleReferences(line).includes(reference)) return true;
    removed++;
    return false;
  });
  return { text: filtered.join("\n").replace(/\n*$/, "\n"), removed };
}

function parseOpcodes(line) {
  return Object.fromEntries([...String(line).matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/g)]
    .map(match => [match[1].toLowerCase(), match[2]]));
}

function setOpcode(line, name, value) {
  const expression = new RegExp(`(\\b${name}=)[^\\s]+`, "i");
  if (expression.test(line)) return line.replace(expression, `$1${value}`);
  const comment = line.indexOf("//");
  if (comment === -1) return `${line.trimEnd()} ${name}=${value}`;
  return `${line.slice(0, comment).trimEnd()} ${name}=${value} ${line.slice(comment)}`;
}

function removeOpcode(line, name) {
  return line.replace(new RegExp(`\\s+${name}=[^\\s]+`, "i"), "");
}

function ccSignature(opcodes) {
  return Object.entries(opcodes).filter(([name]) => /^(?:lo|hi)cc\d+$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`).join(";");
}

export function repairRuntimeSfz(text) {
  let lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const repairs = {
    randomPartitions: 0,
    velocityRanges: 0,
    removedInvalidSequenceLengths: 0,
    closedHiHatCcRanges: 0
  };

  // 공식 파일의 random 숫자에는 오타와 공백/겹침이 있다. 같은 group의 모든 take를
  // 균등한 [0,1] partition으로 다시 써 RR/random 의도를 보존한다.
  for (const block of groupBlocks(lines)) {
    const regionIndexes = [];
    let hasRandom = false, hasSequencePosition = false;
    for (let index = block.start + 1; index < block.end; index++) {
      if (!/^\s*<region>/.test(lines[index])) continue;
      regionIndexes.push(index);
      const opcodes = parseOpcodes(lines[index]);
      if (opcodes.lorand !== undefined || opcodes.hirand !== undefined) hasRandom = true;
      if (opcodes.seq_position !== undefined) hasSequencePosition = true;
    }
    if (hasRandom) {
      for (const [position, index] of regionIndexes.entries()) {
        const lo = formatFraction(position / regionIndexes.length);
        const hi = formatFraction((position + 1) / regionIndexes.length);
        const before = lines[index];
        lines[index] = setOpcode(setOpcode(lines[index], "lorand", lo), "hirand", hi);
        if (lines[index] !== before) repairs.randomPartitions++;
      }
    }
    if (hasRandom && !hasSequencePosition && /\bseq_length=/i.test(lines[block.start])) {
      lines[block.start] = removeOpcode(lines[block.start], "seq_length");
      repairs.removedInvalidSequenceLengths++;
    }
  }

  // 공식 hihat closed 그룹은 key 42에 CC 조건이 없어, CC64로 semi-open을
  // 고를 때 닫힌 샘플도 동시에 겹쳐 울린다. 원본 WAV는 그대로 보존하고 실행용
  // 정의에서만 완전 닫힘을 CC64 0~1로 명시해 7개 반열림 구간과 정확히 분리한다.
  for (const block of groupBlocks(lines)) {
    const group = parseOpcodes(lines[block.start]);
    if (Number(group.key) !== 42 || group.locc64 !== undefined || group.hicc64 !== undefined) continue;
    const references = [];
    for (let index = block.start + 1; index < block.end; index++)
      references.push(...sfzSampleReferences(lines[index]));
    if (!references.length || !references.every(reference => /(?:^|\/)hihatClosed_/i.test(reference))) continue;
    const before = lines[block.start];
    lines[block.start] = setOpcode(setOpcode(before, "locc64", 0), "hicc64", 1);
    if (lines[block.start] !== before) repairs.closedHiHatCcRanges++;
  }

  // 같은 key와 같은 CC 조건의 velocity layer는 MIDI velocity 1~127을 정확히 한 번씩
  // 덮어야 한다. 원본 bellchime처럼 한 layer뿐인데 60부터 시작하면 1~59가 무음이 된다.
  const partitions = new Map();
  for (const block of groupBlocks(lines)) {
    const opcodes = parseOpcodes(lines[block.start]);
    const key = Number(opcodes.key);
    if (!Number.isInteger(key) || key < 0 || key > 127) continue;
    const lo = opcodes.lovel === undefined ? 1 : Number(opcodes.lovel);
    const hi = opcodes.hivel === undefined ? 127 : Number(opcodes.hivel);
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi > 127 || lo > hi)
      fail("SFZ_RANGE_INVALID", "공식 SFZ velocity 범위를 해석할 수 없습니다", {
        line: lines[block.start], key, lo, hi
      });
    const signature = `${key}|${ccSignature(opcodes)}`;
    if (!partitions.has(signature)) partitions.set(signature, []);
    partitions.get(signature).push({ index: block.start, lo: Math.max(1, lo), hi });
  }
  for (const layers of partitions.values()) {
    layers.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    if (new Set(layers.map(layer => layer.lo)).size !== layers.length)
      fail("SFZ_RANGE_INVALID", "같은 trigger의 velocity layer 시작점이 중복됩니다", { layers });
    for (let index = 0; index < layers.length; index++) {
      const desiredLo = index === 0 ? 1 : layers[index].lo;
      const desiredHi = index === layers.length - 1 ? 127 : layers[index + 1].lo - 1;
      if (desiredLo > desiredHi)
        fail("SFZ_RANGE_INVALID", "velocity layer를 겹치지 않게 정규화할 수 없습니다", { layers });
      const before = lines[layers[index].index];
      lines[layers[index].index] = setOpcode(setOpcode(before, "lovel", desiredLo), "hivel", desiredHi);
      if (lines[layers[index].index] !== before) repairs.velocityRanges++;
    }
  }
  const repaired = lines.join("\n").replace(/\n*$/, "\n");
  return { text: repaired, repairs, analysis: analyzeRuntimeSfz(repaired) };
}

export function analyzeRuntimeSfz(text) {
  const lines = String(text).split(/\r?\n/);
  const report = {
    groups: 0, regions: 0,
    invalidRandomValues: 0, randomGaps: 0, randomOverlaps: 0,
    velocityGaps: 0, velocityOverlaps: 0,
    invalidSequenceGroups: 0,
    cc64Gaps: 0, cc64Overlaps: 0
  };
  const velocityPartitions = new Map();
  const cc64Partitions = new Map();
  for (const block of groupBlocks(lines)) {
    report.groups++;
    const group = parseOpcodes(lines[block.start]);
    const regions = [];
    for (let index = block.start + 1; index < block.end; index++) {
      if (!/^\s*<region>/.test(lines[index])) continue;
      report.regions++;
      regions.push(parseOpcodes(lines[index]));
    }
    const random = regions.filter(region => region.lorand !== undefined || region.hirand !== undefined);
    if (random.length) {
      const ranges = random.map(region => ({ lo: Number(region.lorand), hi: Number(region.hirand) }));
      report.invalidRandomValues += ranges.filter(range => !Number.isFinite(range.lo) || !Number.isFinite(range.hi) ||
        range.lo < 0 || range.hi > 1 || range.lo >= range.hi).length;
      const valid = ranges.filter(range => Number.isFinite(range.lo) && Number.isFinite(range.hi)).sort((a, b) => a.lo - b.lo);
      for (let index = 0; index < valid.length; index++) {
        const previous = index === 0 ? 0 : valid[index - 1].hi;
        if (valid[index].lo > previous + 1e-7) report.randomGaps++;
        if (valid[index].lo < previous - 1e-7) report.randomOverlaps++;
      }
      if (valid.length && valid.at(-1).hi < 1 - 1e-7) report.randomGaps++;
      if (valid.length && valid.at(-1).hi > 1 + 1e-7) report.randomOverlaps++;
    }
    const sequence = regions.filter(region => region.seq_position !== undefined);
    if (sequence.length || group.seq_length !== undefined) {
      const length = Number(group.seq_length);
      const positions = sequence.map(region => Number(region.seq_position));
      if (!Number.isInteger(length) || length !== sequence.length ||
          positions.some(position => !Number.isInteger(position) || position < 1 || position > length) ||
          new Set(positions).size !== positions.length)
        report.invalidSequenceGroups++;
    }
    const key = Number(group.key);
    if (Number.isInteger(key) && key >= 0 && key <= 127) {
      const lo = Math.max(1, group.lovel === undefined ? 1 : Number(group.lovel));
      const hi = group.hivel === undefined ? 127 : Number(group.hivel);
      const signature = `${key}|${ccSignature(group)}`;
      if (!velocityPartitions.has(signature)) velocityPartitions.set(signature, []);
      velocityPartitions.get(signature).push({ lo, hi });
      if (group.locc64 !== undefined || group.hicc64 !== undefined) {
        const ccLo = group.locc64 === undefined ? 0 : Number(group.locc64);
        const ccHi = group.hicc64 === undefined ? 127 : Number(group.hicc64);
        if (Number.isInteger(ccLo) && Number.isInteger(ccHi) && ccLo >= 0 && ccHi <= 127 && ccLo <= ccHi) {
          if (!cc64Partitions.has(key)) cc64Partitions.set(key, new Map());
          cc64Partitions.get(key).set(`${ccLo}:${ccHi}`, { lo: ccLo, hi: ccHi });
        } else report.cc64Gaps++;
      }
    }
  }
  for (const ranges of velocityPartitions.values()) {
    for (let velocity = 1; velocity <= 127; velocity++) {
      const matches = ranges.filter(range => velocity >= range.lo && velocity <= range.hi).length;
      if (matches === 0) report.velocityGaps++;
      if (matches > 1) report.velocityOverlaps++;
    }
  }
  for (const rangesBySignature of cc64Partitions.values()) {
    const ranges = [...rangesBySignature.values()];
    for (let value = 0; value <= 127; value++) {
      const matches = ranges.filter(range => value >= range.lo && value <= range.hi).length;
      if (matches === 0) report.cc64Gaps++;
      if (matches > 1) report.cc64Overlaps++;
    }
  }
  return report;
}

function takeStem(reference) {
  const normalized = reference.replaceAll("\\", "/");
  const match = /^(.*_)(\d*)\.wav$/i.exec(normalized);
  return match ? match[1] : null;
}

function formatFraction(value) {
  if (value === 0 || value === 1) return String(value);
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function groupBlocks(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index++)
    if (/^\s*<group>/.test(lines[index])) starts.push(index);
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? lines.length }));
}

function augmentOneRandomGroup(text, missingReference) {
  const lines = text.split("\n");
  const stem = takeStem(missingReference);
  if (!stem) fail("SFZ_AUGMENT_FAILED", "누락 sample의 take 번호를 해석할 수 없습니다", { missingReference });
  const candidates = [];
  for (const block of groupBlocks(lines)) {
    const regions = [];
    for (let index = block.start + 1; index < block.end; index++) {
      const refs = sfzSampleReferences(lines[index]);
      if (refs.length) regions.push({ index, reference: refs[0] });
    }
    if (regions.some(region => takeStem(region.reference) === stem)) candidates.push({ block, regions });
  }
  if (candidates.length !== 1)
    fail("SFZ_AUGMENT_FAILED", "누락 sample과 대응하는 공식 RR 그룹이 하나가 아닙니다", {
      missingReference, candidates: candidates.length
    });
  const { regions } = candidates[0];
  if (regions.some(region => region.reference === missingReference)) return { text, added: false };
  for (const region of regions) {
    const residue = lines[region.index]
      .replace(/<region>/i, "").replace(/\bsample=[^\s]+/i, "")
      .replace(/\blorand=[^\s]+/i, "").replace(/\bhirand=[^\s]+/i, "")
      .replace(/\s*\/\/.*$/, "").trim();
    if (residue)
      fail("SFZ_AUGMENT_FAILED", "자동 편입 대상 RR region에 보존해야 할 추가 opcode가 있습니다", {
        missingReference, line: lines[region.index], residue
      });
  }
  const references = [...regions.map(region => region.reference), missingReference]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const replacement = references.map((reference, index) =>
    `<region> sample=${reference} lorand=${formatFraction(index / references.length)} hirand=${formatFraction((index + 1) / references.length)}`
  );
  const first = regions[0].index;
  const regionIndexes = new Set(regions.map(region => region.index));
  const rebuilt = [];
  for (let index = 0; index < lines.length; index++) {
    if (index === first) rebuilt.push(...replacement);
    if (!regionIndexes.has(index)) rebuilt.push(lines[index]);
  }
  return { text: rebuilt.join("\n"), added: true, groupSamples: references.length };
}

export function augmentAllSfz(normalizedAll, allWavReferences) {
  const referenced = new Set(sfzSampleReferences(normalizedAll));
  const missing = [...allWavReferences].filter(reference => !referenced.has(reference)).sort();
  let text = normalizedAll;
  const augmented = [];
  for (const reference of missing) {
    const result = augmentOneRandomGroup(text, reference);
    text = result.text;
    if (result.added) augmented.push({ sample: reference, groupSamples: result.groupSamples });
  }
  const after = new Set(sfzSampleReferences(text));
  const stillMissing = [...allWavReferences].filter(reference => !after.has(reference));
  if (stillMissing.length)
    fail("SFZ_AUGMENT_FAILED", "ALL-full.sfz에 여전히 누락 sample이 있습니다", { stillMissing });
  return { text: text.replace(/\n*$/, "\n"), beforeMissing: missing, augmented, afterMissing: stillMissing };
}

function countOpcode(text, opcode) {
  return (String(text).match(new RegExp(`\\b${opcode}=`, "g")) ?? []).length;
}

export function verifyPreparedSalamander(root, expectedWavCount = 536) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "catalog", "samples.json"), "utf8"));
  const sfzCatalog = JSON.parse(fs.readFileSync(path.join(root, "catalog", "sfz.json"), "utf8"));
  const allFull = fs.readFileSync(path.join(root, "sfz", "ALL-full.sfz"), "utf8");
  let missingSamples = 0, missingReferences = 0, foreignReferences = 0, referenceCount = 0;
  let invalidRandomValues = 0, randomGaps = 0, randomOverlaps = 0;
  let velocityGaps = 0, velocityOverlaps = 0, invalidSequenceGroups = 0;
  let cc64Gaps = 0, cc64Overlaps = 0;
  let rawTakeKitReferences = 0, rawTakeClipReferences = 0, recordedClipsPlayable = 0;
  const runtimeUnique = new Set();
  const allowedSamples = new Set(catalog.map(sample => sample.file));
  const realRoot = fs.realpathSync(root);
  for (const sample of catalog)
    if (!fs.existsSync(path.join(root, ...sample.file.split("/")))) missingSamples++;
  for (const definition of sfzCatalog) {
    const sfz = path.join(root, ...definition.file.split("/"));
    const text = fs.readFileSync(sfz, "utf8");
    const recordedClip = definition.kind === "recorded-clip";
    const analysis = analyzeRuntimeSfz(text);
    invalidRandomValues += analysis.invalidRandomValues;
    randomGaps += analysis.randomGaps;
    randomOverlaps += analysis.randomOverlaps;
    velocityGaps += analysis.velocityGaps;
    velocityOverlaps += analysis.velocityOverlaps;
    invalidSequenceGroups += analysis.invalidSequenceGroups;
    cc64Gaps += analysis.cc64Gaps;
    cc64Overlaps += analysis.cc64Overlaps;
    for (const reference of sfzSampleReferences(text)) {
      referenceCount++;
      runtimeUnique.add(reference);
      if (reference === RAW_TAKE_REFERENCE) {
        if (recordedClip) rawTakeClipReferences++;
        else rawTakeKitReferences++;
      }
      const resolved = path.resolve(path.dirname(sfz), ...reference.split("/"));
      let safe;
      try { safe = ensureInside(realRoot, resolved, "runtime SFZ sample"); }
      catch { foreignReferences++; continue; }
      if (!fs.existsSync(safe)) { missingReferences++; continue; }
      const actual = fs.realpathSync(safe);
      try { ensureInside(realRoot, actual, "runtime SFZ sample realpath"); }
      catch { foreignReferences++; continue; }
      const relative = path.relative(realRoot, actual).split(path.sep).join("/");
      if (!allowedSamples.has(relative)) foreignReferences++;
    }
    if (recordedClip && definition.playKey === 60 && sfzSampleReferences(text).length === 1)
      recordedClipsPlayable++;
  }
  const fullUnique = new Set(sfzSampleReferences(allFull));
  const allSamples = new Set(catalog.map(sample => `../samples/${sample.sourceEntry}`));
  const kitSamples = new Set([...allSamples].filter(sample => sample !== RAW_TAKE_REFERENCE));
  const unmappedFull = [...kitSamples].filter(sample => !fullUnique.has(sample)).length;
  const unmappedRuntime = [...allSamples].filter(sample => !runtimeUnique.has(sample)).length;
  return {
    samples: catalog.length,
    expectedSamples: expectedWavCount,
    sfzFiles: sfzCatalog.length,
    referenceCount,
    allFullUniqueSamples: fullUnique.size,
    runtimeUniqueSamples: runtimeUnique.size,
    missingSamples,
    missingReferences,
    foreignReferences,
    unmappedFull,
    unmappedRuntime,
    rawTakeKitReferences,
    rawTakeClipReferences,
    recordedClipsPlayable,
    invalidRandomValues,
    randomGaps,
    randomOverlaps,
    velocityGaps,
    velocityOverlaps,
    invalidSequenceGroups,
    cc64Gaps,
    cc64Overlaps,
    randomRegions: countOpcode(allFull, "lorand"),
    roundRobinRegions: countOpcode(allFull, "seq_position"),
    chokeGroups: countOpcode(allFull, "off_by"),
    chokeModes: countOpcode(allFull, "off_mode")
  };
}

async function smokeWithSfizz(sfzFile) {
  const { openSfizzSession } = await import("../src/sfizz-engine.js");
  const file = fs.realpathSync(sfzFile);
  const session = openSfizzSession(file, 44_100);
  try {
    const conditions = new Map();
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!/^\s*<group>/.test(line)) continue;
      const opcodes = parseOpcodes(line), key = Number(opcodes.key);
      if (!Number.isInteger(key)) continue;
      const lo = Math.max(1, Number(opcodes.lovel ?? 1)), hi = Number(opcodes.hivel ?? 127);
      for (const velocity of [lo, Math.floor((lo + hi) / 2), hi])
        conditions.set(`${key}:${velocity}`, { key, velocity });
    }
    const tested = [...conditions.values()].sort((a, b) => a.key - b.key || a.velocity - b.velocity);
    const stride = 2_205, gate = 1_102;
    const notes = tested.map(({ key, velocity }, index) => ({
      startSample: index * stride,
      endSample: index * stride + gate,
      key, velocity, bend: 0, gain: 1
    }));
    const rendered = session.renderTrack({ notes, length: notes.length * stride + 4_410 });
    return {
      engine: rendered.diagnostics.engine,
      notes: rendered.diagnostics.notes,
      keys: [...new Set(tested.map(condition => condition.key))],
      minVelocity: Math.min(...tested.map(condition => condition.velocity)),
      maxVelocity: Math.max(...tested.map(condition => condition.velocity)),
      peak: rendered.diagnostics.peak,
      nonzeroSamples: rendered.diagnostics.nonzeroSamples
    };
  } finally {
    session.close();
  }
}

function wavDuration(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE")
    fail("WAV_INVALID", `WAV header를 읽을 수 없습니다: ${file}`);
  let offset = 12, byteRate = null, dataBytes = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) fail("WAV_INVALID", `WAV chunk가 파일 경계를 벗어납니다: ${file}`);
    if (id === "fmt " && size >= 16) byteRate = buffer.readUInt32LE(start + 8);
    if (id === "data") dataBytes = size;
    offset = start + size + (size % 2);
  }
  if (!Number.isFinite(byteRate) || byteRate <= 0 || !Number.isFinite(dataBytes))
    fail("WAV_INVALID", `WAV duration 정보를 읽을 수 없습니다: ${file}`);
  return dataBytes / byteRate;
}

async function smokeRawTakeClip(sfzFile, sampleFile) {
  const { openSfizzSession } = await import("../src/sfizz-engine.js");
  const sampleRate = 44_100;
  const durationSec = wavDuration(sampleFile);
  const tailAfterSampleSec = 0.5;
  const requiredRenderWindowFromNoteStartSec = Math.ceil((durationSec + tailAfterSampleSec) * 1000) / 1000;
  const length = Math.ceil((requiredRenderWindowFromNoteStartSec + 1) * sampleRate);
  const session = openSfizzSession(fs.realpathSync(sfzFile), sampleRate);
  try {
    const rendered = session.renderTrack({
      notes: [{ startSample: 0, endSample: 2_205, key: 60, velocity: 100, bend: 0, gain: 1 }],
      length
    });
    let lastNonzero = -1;
    for (let index = 0; index < length; index++)
      if (Math.abs(rendered.left[index]) > 1 / 32768 || Math.abs(rendered.right[index]) > 1 / 32768)
        lastNonzero = index;
    const lastNonzeroSec = lastNonzero / sampleRate;
    if (lastNonzero < 0 || lastNonzeroSec < durationSec - 1 || lastNonzeroSec > requiredRenderWindowFromNoteStartSec)
      fail("SFIZZ_CLIP_TRUNCATED", "미편집 kick clip의 끝까지 sfizz로 재생되지 않았습니다", {
        durationSec, tailAfterSampleSec, requiredRenderWindowFromNoteStartSec, lastNonzeroSec
      });
    return {
      engine: rendered.diagnostics.engine,
      durationSec,
      tailHintSec: tailAfterSampleSec,
      requiredRenderWindowFromNoteStartSec,
      renderLengthSec: length / sampleRate,
      lastNonzeroSec,
      peak: rendered.diagnostics.peak,
      nonzeroSamples: rendered.diagnostics.nonzeroSamples,
      trimmedFrames: rendered.diagnostics.trimmedFrames
    };
  } finally {
    session.close();
  }
}

async function fileInventory(root, excluded = new Set()) {
  const files = extractedFiles(root).filter(file => !excluded.has(file));
  const result = await mapLimit(files, 12, async file => ({
    file,
    bytes: fs.statSync(path.join(root, ...file.split("/"))).size,
    sha256: await sha256File(path.join(root, ...file.split("/")))
  }));
  return result.sort((a, b) => a.file.localeCompare(b.file));
}

export async function prepareSalamanderPack(options = {}) {
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
    const entries = await inspectTarArchive(archive, "Salamander Drumkit tar.bz2");
    const sourceRoot = path.join(stage, ".extract");
    const actual = extractValidatedTar(archive, sourceRoot, entries);
    const wavEntries = actual.filter(file => file.toLowerCase().endsWith(".wav")).sort();
    const sfzEntries = actual.filter(file => file.toLowerCase().endsWith(".sfz")).sort();
    const expectedWavCount = options.expectedWavCount ?? 536;
    const expectedSfz = options.expectedOfficialSfz ?? OFFICIAL_SFZ;
    if (wavEntries.length !== expectedWavCount)
      fail("ARCHIVE_CONTENT_MISMATCH", `공식 WAV가 ${expectedWavCount}개여야 하지만 ${wavEntries.length}개입니다`, {
        expectedWavCount, actual: wavEntries.length
      });
    if (JSON.stringify(sfzEntries) !== JSON.stringify([...expectedSfz].sort()))
      fail("ARCHIVE_CONTENT_MISMATCH", "공식 SFZ 파일 목록이 예상과 다릅니다", {
        expected: [...expectedSfz].sort(), actual: sfzEntries
      });

    fs.mkdirSync(path.join(stage, "samples"), { recursive: true });
    const samples = await mapLimit(wavEntries, 12, async sourceEntry => {
      const target = `samples/${sourceEntry}`;
      const sourceFile = path.join(sourceRoot, ...sourceEntry.split("/"));
      const targetFile = path.join(stage, ...target.split("/"));
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(sourceFile, targetFile, fs.constants.COPYFILE_FICLONE);
      return {
        id: crypto.createHash("sha256").update(sourceEntry).digest("hex").slice(0, 20),
        sourceEntry,
        file: target,
        bytes: fs.statSync(targetFile).size,
        sha256: await sha256File(targetFile)
      };
    });
    fs.mkdirSync(path.join(stage, "official"), { recursive: true });
    for (const file of [...sfzEntries, ...actual.filter(file => file === "REAMDE")])
      fs.copyFileSync(path.join(sourceRoot, file), path.join(stage, "official", file));

    fs.mkdirSync(path.join(stage, "sfz"), { recursive: true });
    const sfzCatalog = [];
    const repairCatalog = [];
    let normalizedAll = null;
    let officialAllUniqueSamples = null;
    let detachedRuntimeDefinitions = 0;
    const rawTakeSample = samples.find(sample => sample.sourceEntry === RAW_TAKE_SOURCE) ?? null;
    if (expectedWavCount === 536 && !rawTakeSample)
      fail("ARCHIVE_CONTENT_MISMATCH", `공식 미편집 raw take가 없습니다: ${RAW_TAKE_SOURCE}`);
    for (const file of sfzEntries) {
      const original = fs.readFileSync(path.join(sourceRoot, file), "utf8");
      const normalized = normalizeOfficialSfz(original);
      if (file === "ALL.sfz") officialAllUniqueSamples = new Set(sfzSampleReferences(normalized)).size;
      const detached = rawTakeSample ? detachRawTake(normalized) : { text: normalized, removed: 0 };
      if (detached.removed > 1)
        fail("SFZ_RAW_TAKE_INVALID", `${file}이 같은 미편집 raw take를 여러 번 참조합니다`, { removed: detached.removed });
      if (detached.removed) detachedRuntimeDefinitions++;
      const runtime = repairRuntimeSfz(detached.text);
      if (Object.entries(runtime.analysis).some(([name, value]) =>
        !["groups", "regions"].includes(name) && value !== 0))
        fail("SFZ_PARTITION_INVALID", `${file}의 runtime random/velocity/sequence 검증에 실패했습니다`, runtime.analysis);
      fs.writeFileSync(path.join(stage, "sfz", file), runtime.text, { flag: "wx", mode: 0o644 });
      const references = sfzSampleReferences(runtime.text);
      const missing = references.filter(reference =>
        !fs.existsSync(path.resolve(path.join(stage, "sfz"), ...reference.split("/"))));
      if (missing.length)
        fail("SFZ_SAMPLE_MISSING", `${file}의 공식 sample 참조가 누락됐습니다`, { missing });
      sfzCatalog.push({
        file: `sfz/${file}`, kind: detached.removed ? "official-normalized-raw-take-detached" : "official-normalized",
        regions: references.length, uniqueSamples: new Set(references).size,
        randomRegions: countOpcode(normalized, "lorand"),
        roundRobinRegions: countOpcode(normalized, "seq_position"),
        chokeGroups: countOpcode(normalized, "off_by"),
        repairs: runtime.repairs
      });
      repairCatalog.push({ file: `sfz/${file}`, ...runtime.repairs });
      if (file === "ALL.sfz") normalizedAll = runtime.text;
    }
    if (!normalizedAll) fail("ARCHIVE_CONTENT_MISMATCH", "공식 ALL.sfz가 없습니다");
    if (rawTakeSample && detachedRuntimeDefinitions !== 2)
      fail("SFZ_RAW_TAKE_INVALID", "미편집 raw take는 runtime ALL과 kick 두 정의에서 정확히 분리되어야 합니다", {
        detachedRuntimeDefinitions
      });
    const allWavReferences = samples
      .filter(sample => sample !== rawTakeSample)
      .map(sample => `../samples/${sample.sourceEntry}`);
    const augmented = augmentAllSfz(normalizedAll, allWavReferences);
    const fullRuntime = repairRuntimeSfz(augmented.text);
    if (Object.entries(fullRuntime.analysis).some(([name, value]) =>
      !["groups", "regions"].includes(name) && value !== 0))
      fail("SFZ_PARTITION_INVALID", "ALL-full.sfz의 runtime random/velocity/sequence 검증에 실패했습니다", fullRuntime.analysis);
    fs.writeFileSync(path.join(stage, "sfz", "ALL-full.sfz"), fullRuntime.text, { flag: "wx", mode: 0o644 });
    sfzCatalog.push({
      file: "sfz/ALL-full.sfz", kind: "official-augmented-complete",
      regions: sfzSampleReferences(fullRuntime.text).length,
      uniqueSamples: new Set(sfzSampleReferences(fullRuntime.text)).size,
      randomRegions: countOpcode(fullRuntime.text, "lorand"),
      roundRobinRegions: countOpcode(fullRuntime.text, "seq_position"),
      chokeGroups: countOpcode(fullRuntime.text, "off_by"),
      addedSamples: augmented.augmented,
      repairs: fullRuntime.repairs
    });
    repairCatalog.push({ file: "sfz/ALL-full.sfz", ...fullRuntime.repairs });

    let rawTakeCatalog = null;
    if (rawTakeSample) {
      const rawTakeFile = path.join(stage, ...RAW_TAKE_SFZ.split("/"));
      fs.mkdirSync(path.dirname(rawTakeFile), { recursive: true });
      const sampleReference = path.relative(path.dirname(rawTakeFile), path.join(stage, ...rawTakeSample.file.split("/")))
        .split(path.sep).join("/");
      const rawTakeText = [
        "// Recorded clip from the official Salamander Drumkit archive.",
        "// This untrimmed repeated-kick source is intentionally not part of a drum-kit RR group.",
        `<region> key=60 pitch_keycenter=60 lovel=1 hivel=127 loop_mode=one_shot sample=${sampleReference}`,
        ""
      ].join("\n");
      fs.writeFileSync(rawTakeFile, rawTakeText, { flag: "wx", mode: 0o644 });
      rawTakeCatalog = {
        file: RAW_TAKE_SFZ,
        kind: "recorded-clip",
        regions: 1,
        uniqueSamples: 1,
        playKey: 60,
        sourceSample: rawTakeSample.file,
        sourceEntry: rawTakeSample.sourceEntry,
        reason: "untrimmed-repeated-kick-raw-take"
      };
      sfzCatalog.push(rawTakeCatalog);
    }

    writeJson(path.join(stage, "catalog", "samples.json"), samples.sort((a, b) => a.sourceEntry.localeCompare(b.sourceEntry)));
    writeJson(path.join(stage, "catalog", "sfz.json"), sfzCatalog.sort((a, b) => a.file.localeCompare(b.file)));
    writeJson(path.join(stage, "catalog", "augmentation.json"), {
      officialAllUniqueSamples,
      runtimeOfficialAllUniqueSamples: new Set(sfzSampleReferences(normalizedAll)).size,
      initiallyUnreferenced: augmented.beforeMissing,
      additions: augmented.augmented,
      remainingUnreferenced: augmented.afterMissing,
      detachedRawTake: rawTakeCatalog
    });
    writeJson(path.join(stage, "catalog", "repairs.json"), repairCatalog.sort((a, b) => a.file.localeCompare(b.file)));
    fs.rmSync(sourceRoot, { recursive: true, force: true });

    const verification = verifyPreparedSalamander(stage, expectedWavCount);
    const expectedKitSamples = expectedWavCount - (rawTakeSample ? 1 : 0);
    if (verification.samples !== expectedWavCount || verification.allFullUniqueSamples !== expectedKitSamples ||
        verification.runtimeUniqueSamples !== expectedWavCount ||
        verification.missingSamples || verification.missingReferences || verification.foreignReferences ||
        verification.unmappedFull || verification.unmappedRuntime || verification.invalidRandomValues || verification.randomGaps ||
        verification.randomOverlaps || verification.velocityGaps || verification.velocityOverlaps ||
        verification.invalidSequenceGroups || verification.cc64Gaps || verification.cc64Overlaps ||
        verification.randomRegions === 0 ||
        verification.chokeGroups === 0 || verification.chokeModes === 0 ||
        (rawTakeSample && (verification.rawTakeKitReferences !== 0 || verification.rawTakeClipReferences !== 1 ||
          verification.recordedClipsPlayable !== 1)))
      fail("PREPARE_VERIFY_FAILED", "준비된 Salamander 팩의 전수/RR/choke 검증에 실패했습니다", verification);
    progress("sfizz-smoke", {});
    const engineSmoke = options.skipEngineSmoke ? null : {
      kit: await smokeWithSfizz(path.join(stage, "sfz", "ALL-full.sfz")),
      rawTakeClip: rawTakeSample ? await smokeRawTakeClip(
        path.join(stage, ...RAW_TAKE_SFZ.split("/")),
        path.join(stage, ...rawTakeSample.file.split("/"))
      ) : null
    };
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
      id: "salamander-drumkit-sfz",
      name: "Salamander Drumkit — complete official SFZ pack",
      source: {
        url: "https://archive.org/details/SalamanderDrumkit",
        archive: path.basename(archive), sha256: archiveSha256,
        author: "Alexander Holm", license: "CC-BY-SA-3.0"
      },
      counts: {
        wav: samples.length,
        officialSfz: sfzEntries.length,
        runtimeSfz: sfzCatalog.length,
        kitSfz: sfzCatalog.filter(definition => definition.kind !== "recorded-clip").length,
        recordedClipSfz: sfzCatalog.filter(definition => definition.kind === "recorded-clip").length,
        officialAllUniqueSamples,
        runtimeOfficialAllUniqueSamples: new Set(sfzSampleReferences(normalizedAll)).size,
        fullAllUniqueSamples: verification.allFullUniqueSamples,
        runtimeUniqueSamples: verification.runtimeUniqueSamples,
        initiallyUnreferenced: augmented.beforeMissing.length,
        missingSamples: 0
      },
      preservation: {
        officialDefinitions: "official/*.sfz",
        officialReadme: fs.existsSync(path.join(stage, "official", "REAMDE")) ? "official/REAMDE" : null,
        runtimeFullDefinition: "sfz/ALL-full.sfz",
        detachedRawTakeClip: rawTakeSample ? RAW_TAKE_SFZ : null,
        augmentation: "catalog/augmentation.json",
        repairs: "catalog/repairs.json"
      },
      engineSmoke,
      checksums: { file: "catalog/checksums.json", sha256: checksumsSha256 },
      limitations: [
        "원본은 overhead microphone(OH) stereo mix 한 종류이며 close/room mic stem은 없다.",
        "공식 ALL.sfz의 velocity, random round-robin, off_by/off_mode choke 설계를 보존하되 잘못된 숫자·공백·겹침은 균등 구간으로 교정한다.",
        "공식 ALL.sfz에서 빠진 4개 take는 같은 sample stem의 기존 random 그룹에 균등 확률로 편입했다.",
        "44.55625초짜리 kick_OH_P_1.wav는 여러 타격이 반복된 미편집 raw take이므로 kit RR에서는 제외하고, 원본을 자르지 않은 key 60 Recorded Clip으로 별도 제공한다."
      ]
    };
    writeJson(path.join(stage, "pack.json"), manifest);
    if (fs.existsSync(output))
      fail("OUTPUT_RACE", `준비 중 output 경로가 새로 생겨 덮어쓰지 않습니다: ${output}`, { output });
    fs.renameSync(stage, output);
    progress("complete", { output, counts: manifest.counts });
    return { output, manifest, verification, augmentation: augmented };
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
    else if (value === "--skip-engine-smoke") options.skipEngineSmoke = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else fail("ARGUMENT_INVALID", `알 수 없는 인자입니다: ${value}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node tools/prepare-salamander-sfz.mjs [--archive FILE] --output NEW_DIRECTORY [--skip-engine-smoke]");
  } else {
    options.progress = (phase, detail) => console.log(`[${phase}] ${JSON.stringify(detail)}`);
    prepareSalamanderPack(options).then(result => {
      console.log(JSON.stringify({ output: result.output, counts: result.manifest.counts, verification: result.verification }, null, 2));
    }).catch(error => {
      console.error(`${error.code ?? error.name}: ${error.message}`);
      if (error.details) console.error(JSON.stringify(error.details, null, 2));
      process.exitCode = 1;
    });
  }
}

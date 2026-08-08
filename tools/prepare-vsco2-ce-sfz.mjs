#!/usr/bin/env node
// Build a complete, auditable VSCO 2 CE SFZ pack without changing the installed
// official pack in place. The 75 upstream SFZ files and every upstream payload
// byte are copied unchanged. Supplemental definitions expose WAV files which the
// upstream SFZ branch ships but does not reference.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_SOURCE = path.join(os.homedir(), ".aria", "packs", "vsco2-ce-sfz");
export const VSCO_IDENTITY = Object.freeze({
  commit: "6dd651d55dde97fd4028699be9d4481f26917891",
  tree: "553ef3b90c87fe43ef19a3a8f8965a4a2945d570",
  repositoryUrl: "https://github.com/sgossner/VSCO-2-CE.git",
  projectUrl: "https://github.com/sgossner/VSCO-2-CE",
  licenseSha256: "36ffd9dc085d529a7e60e1276d73ae5a030b020313e6c5408593a6ae2af39673",
  trackedFiles: 3273,
  wavFiles: 3168,
  officialSfzFiles: 75,
  officialSampleReferenceLines: 3163,
  officialUniqueReferencedSamples: 2034,
  officialUnreferencedSamples: 1134
});

const DYNAMIC_NAMES = new Map([
  ["pppp", 0], ["ppp", 1], ["pp", 2], ["p", 3], ["mp", 4],
  ["mf", 5], ["f", 6], ["ff", 7], ["fff", 8], ["ffff", 9]
]);
const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;

export class VscoPrepareError extends Error {
  constructor(code, message, details = undefined, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = "VscoPrepareError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details, cause) {
  throw new VscoPrepareError(code, message, details, cause);
}

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function posixRelative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function ensureInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
    return candidate;
  fail("PATH_ESCAPE", `${label} escapes the VSCO source root`, { root, candidate });
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") ||
      path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value))
    fail("PATH_UNSAFE", `${label} must be a safe POSIX relative path`, { value });
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part)))
    fail("PATH_UNSAFE", `${label} contains an unsafe segment`, { value });
  return value;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
  const output = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index], index);
    }
  }));
  return output;
}

function command(program, args, options = {}) {
  const child = spawnSync(program, args, {
    encoding: options.binary ? null : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout ?? 30 * 60_000,
    maxBuffer: options.maxBuffer ?? MAX_COMMAND_OUTPUT
  });
  if (child.error || child.status !== 0)
    fail("COMMAND_FAILED", `${program} failed`, {
      program, args, status: child.status, signal: child.signal,
      stdout: String(child.stdout ?? "").slice(-4000),
      stderr: String(child.stderr ?? "").slice(-4000)
    }, child.error);
  return child.stdout;
}

function listFilesNoLinks(root, excluded = new Set()) {
  let rootStat;
  try { rootStat = fs.lstatSync(root); }
  catch (error) { fail("SOURCE_MISSING", `VSCO source is missing: ${root}`, { root }, error); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail("SOURCE_INVALID", `VSCO source must be a real directory: ${root}`, { root });
  const records = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => bytewise(a.name, b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = posixRelative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail("SOURCE_SYMLINK", `symbolic link is forbidden: ${relative}`, { relative });
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        if (!excluded.has(relative)) records.push({
          path: relative,
          absolute,
          size: stat.size,
          signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
        });
      } else fail("SOURCE_SPECIAL_FILE", `special file is forbidden: ${relative}`, { relative });
    }
  };
  visit(root);
  return records.sort((a, b) => bytewise(a.path, b.path));
}

function cleanSfzValue(value) {
  const trimmed = String(value).trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function stripSfzComments(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function expandMacros(value, macros, file) {
  return value.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, name => {
    if (!macros.has(name)) fail("SFZ_MACRO_UNDEFINED", `undefined SFZ macro ${name}`, { file, name });
    return macros.get(name);
  });
}

function tokenizeSfz(text, baseDir) {
  const tokens = [];
  const expression = /<\s*([A-Za-z_][\w-]*)\s*>|(?:^|\s)([A-Za-z_][\w-]*)\s*=/gm;
  let match;
  while ((match = expression.exec(text))) {
    tokens.push({
      type: match[1] ? "tag" : "opcode",
      name: (match[1] ?? match[2]).toLowerCase(),
      start: match.index,
      valueStart: expression.lastIndex,
      baseDir
    });
  }
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type === "opcode")
      tokens[index].value = text.slice(tokens[index].valueStart, tokens[index + 1]?.start ?? text.length).trim();
  }
  return tokens;
}

function midiValue(value) {
  if (value === undefined) return null;
  const cleaned = cleanSfzValue(value);
  if (/^\d{1,3}$/.test(cleaned)) {
    const number = Number(cleaned);
    return number >= 0 && number <= 127 ? number : null;
  }
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(cleaned);
  if (!match) return null;
  const pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1].toUpperCase()] +
    (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0);
  const number = (Number(match[3]) + 1) * 12 + pc;
  return number >= 0 && number <= 127 ? number : null;
}

/**
 * Resolve SFZ sample paths with the same sequential include/default_path/macro
 * model used by src/sfizz-engine.js. It also returns region pitch metadata so
 * supplemental definitions can learn the upstream library's octave convention.
 */
export function inspectSfzReferences(root, entryFiles) {
  root = fs.realpathSync(root);
  // Each top-level SFZ starts with its own default_path and scope state in sfizz.
  // Aggregate independent inspections instead of leaking state from one preset to
  // the next merely because the audit asked for a whole catalog at once.
  if (entryFiles.length > 1) {
    const inspections = entryFiles.map(entry => inspectSfzReferences(root, [entry]));
    const references = inspections.flatMap(item => item.references);
    return {
      references,
      uniqueReferences: new Set(references),
      regions: inspections.flatMap(item => item.regions),
      includeFiles: new Set(inspections.flatMap(item => [...item.includeFiles])),
      ampegReleaseSec: Math.max(0, ...inspections.map(item => item.ampegReleaseSec ?? 0))
    };
  }
  const macros = new Map();
  const includeStack = new Set();
  const included = new Set();
  const tokens = [];
  const visit = file => {
    const real = ensureInside(root, fs.realpathSync(file), "SFZ include");
    if (includeStack.has(real)) fail("SFZ_INCLUDE_CYCLE", `cyclic SFZ include: ${real}`);
    // The runtime limit is 256 files for one entry. This audit function can inspect
    // hundreds of independent catalog entries at once, so bound nesting rather than
    // the union of every top-level file passed by the caller.
    if (includeStack.size >= 256) fail("SFZ_INCLUDE_LIMIT", "SFZ include nesting limit exceeded");
    includeStack.add(real);
    included.add(real);
    const text = stripSfzComments(fs.readFileSync(real, "utf8"));
    const baseDir = path.dirname(real);
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      tokens.push(...tokenizeSfz(expandMacros(pending.join("\n"), macros, real), baseDir));
      pending = [];
    };
    for (const line of text.split(/\r?\n/)) {
      const define = /^\s*#define\s+(\$[A-Za-z_][A-Za-z0-9_]*)\s+(.+?)\s*$/.exec(line);
      if (define) {
        flush();
        macros.set(define[1], cleanSfzValue(expandMacros(define[2], macros, real)));
        continue;
      }
      const include = /^\s*#include\s+(.+?)\s*$/.exec(line);
      if (include) {
        flush();
        const relative = cleanSfzValue(expandMacros(include[1], macros, real)).replaceAll("\\", "/");
        const candidate = path.isAbsolute(relative) ? path.resolve(relative) : path.resolve(baseDir, relative);
        ensureInside(root, candidate, "SFZ include");
        visit(candidate);
        continue;
      }
      if (/^\s*#/.test(line)) fail("SFZ_DIRECTIVE_UNSUPPORTED", `unsupported SFZ directive: ${line.trim()}`);
      pending.push(line);
    }
    flush();
    includeStack.delete(real);
  };

  const mainEntry = entryFiles[0];
  if (!mainEntry) fail("SFZ_ENTRY_REQUIRED", "at least one SFZ entry is required");
  safeRelative(mainEntry, "SFZ entry");
  const mainFile = path.join(root, ...mainEntry.split("/"));
  visit(mainFile);

  let defaultRoot = path.dirname(mainFile);
  const releaseValues = [];
  const switchLabels = new Map();
  let pendingSwitch = null;
  let defaultSwitch = null;
  let scope = "none";
  let global = {}, master = {}, group = {}, region = null;
  const regions = [];
  const references = [];
  const finishRegion = () => {
    if (!region) return;
    if (region.__sample) {
      const key = midiValue(region.key);
      regions.push({
        sample: region.__sample,
        key,
        lokey: key ?? midiValue(region.lokey) ?? 0,
        hikey: key ?? midiValue(region.hikey) ?? 127,
        pitchKeycenter: midiValue(region.pitch_keycenter) ?? key,
        lovel: Number.isInteger(Number(region.lovel)) ? Number(region.lovel) : 0,
        hivel: Number.isInteger(Number(region.hivel)) ? Number(region.hivel) : 127
      });
    }
    region = null;
  };
  for (const token of tokens) {
    if (token.type === "tag") {
      finishRegion();
      scope = token.name;
      if (scope === "global") { global = {}; master = {}; group = {}; }
      else if (scope === "master") { master = {}; group = {}; }
      else if (scope === "group") group = {};
      else if (scope === "region") region = { ...global, ...master, ...group };
      continue;
    }
    const value = cleanSfzValue(token.value);
    if (token.name === "sw_default") {
      const key = midiValue(value);
      if (key !== null && defaultSwitch === null) defaultSwitch = key;
    }
    if (token.name === "sw_last") pendingSwitch = midiValue(value);
    if (token.name === "sw_label" && pendingSwitch !== null) {
      const previous = switchLabels.get(pendingSwitch);
      if (previous && previous !== value)
        fail("SFZ_SWITCH_INVALID", `keyswitch ${pendingSwitch}에 서로 다른 label이 있습니다`, {
          entry: mainEntry, previous, value
        });
      switchLabels.set(pendingSwitch, value);
    }
    if (token.name === "ampeg_release") {
      const release = Number(value);
      if (Number.isFinite(release) && release >= 0) releaseValues.push(release);
    }
    if (token.name === "default_path") {
      const normalized = value.replaceAll("\\", "/");
      defaultRoot = ensureInside(root, path.isAbsolute(normalized)
        ? path.resolve(normalized) : path.resolve(token.baseDir, normalized), "SFZ default_path");
      continue;
    }
    const target = scope === "global" ? global : scope === "master" ? master :
      scope === "group" ? group : scope === "region" ? region : null;
    if (!target) continue;
    target[token.name] = value;
    if (token.name !== "sample" || value.startsWith("*")) continue;
    const normalized = value.replaceAll("\\", "/");
    const candidate = ensureInside(root, path.isAbsolute(normalized)
      ? path.resolve(normalized) : path.resolve(defaultRoot, normalized), "SFZ sample");
    let stat;
    try { stat = fs.statSync(candidate); }
    catch (error) { fail("SFZ_SAMPLE_MISSING", `SFZ sample is missing: ${candidate}`, { candidate }, error); }
    if (!stat.isFile()) fail("SFZ_SAMPLE_MISSING", `SFZ sample is not a file: ${candidate}`);
    const real = ensureInside(root, fs.realpathSync(candidate), "SFZ sample real path");
    const relative = posixRelative(root, real);
    references.push(relative);
    target.__sample = relative;
  }
  finishRegion();
  return {
    references,
    uniqueReferences: new Set(references),
    regions,
    includeFiles: included,
    ampegReleaseSec: releaseValues.length ? Math.max(...releaseValues) : null,
    switches: [...switchLabels].sort((a, b) => a[0] - b[0]).map(([key, label]) => ({ key, label })),
    defaultSwitch
  };
}

export function readWavInfo(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(12);
    if (fs.readSync(descriptor, header, 0, 12, 0) !== 12 || header.toString("ascii", 0, 4) !== "RIFF" ||
        header.toString("ascii", 8, 12) !== "WAVE")
      fail("WAV_INVALID", `not a RIFF/WAVE file: ${file}`);
    const size = fs.fstatSync(descriptor).size;
    let position = 12, format = null, dataBytes = null;
    const chunk = Buffer.alloc(8);
    while (position + 8 <= size) {
      if (fs.readSync(descriptor, chunk, 0, 8, position) !== 8) break;
      const id = chunk.toString("ascii", 0, 4), bytes = chunk.readUInt32LE(4);
      const start = position + 8;
      if (start + bytes > size) fail("WAV_INVALID", `WAV chunk exceeds file size: ${file}`, { id, bytes, size });
      if (id === "fmt " && bytes >= 16) {
        const body = Buffer.alloc(Math.min(bytes, 40));
        fs.readSync(descriptor, body, 0, body.length, start);
        format = {
          encoding: body.readUInt16LE(0),
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          byteRate: body.readUInt32LE(8),
          blockAlign: body.readUInt16LE(12),
          bitsPerSample: body.readUInt16LE(14)
        };
      } else if (id === "data" && dataBytes === null) dataBytes = bytes;
      position = start + bytes + (bytes & 1);
    }
    if (!format || dataBytes === null || !format.byteRate || !format.sampleRate || !format.blockAlign)
      fail("WAV_INVALID", `WAV fmt/data metadata is incomplete: ${file}`);
    return { ...format, dataBytes, frames: dataBytes / format.blockAlign, durationSec: dataBytes / format.byteRate };
  } finally {
    fs.closeSync(descriptor);
  }
}

function filenameNote(relative) {
  const stem = path.posix.basename(relative, path.posix.extname(relative));
  const matches = [...stem.matchAll(/(?:^|_)([A-Ga-g])([#b]?)(-?\d+)(?=_|$)/g)];
  if (!matches.length) return null;
  const match = matches[matches.length - 1];
  const pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1].toUpperCase()] +
    (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0);
  return { token: `${match[1].toUpperCase()}${match[2]}${match[3]}`, standardMidi: (Number(match[3]) + 1) * 12 + pc };
}

function dynamicMetadata(relative) {
  const stem = path.posix.basename(relative, path.posix.extname(relative));
  const parts = stem.split(/[_-]/);
  let rank = null, token = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (DYNAMIC_NAMES.has(lower)) { rank = DYNAMIC_NAMES.get(lower); token = lower; }
    const velocity = /^v(\d+)$/.exec(lower);
    if (velocity) { rank = 20 + Number(velocity[1]); token = lower; }
  }
  return { rank: rank ?? 0, token: token ?? "single" };
}

function semanticStem(relative, { keepNote = true } = {}) {
  let stem = path.posix.basename(relative, path.posix.extname(relative));
  const hasDynamicLayer = /(?:^|[_-])(?:pppp|ppp|pp|mp|mf|ffff|fff|ff|p|f|v\d+)(?=[_-]|$)/i.test(stem);
  const hasNamedRoundRobin = /(?:^|[_-])(?:rr?|take)\d+(?=[_-]|$)/i.test(stem);
  // A trailing `_1`, `_2`, ... after an explicit dynamic, RR marker, or note is
  // a recorded take in this library. Strip only in those evidenced cases so
  // unrelated numbered effects such as alien1/alien2 stay separate.
  if (hasDynamicLayer || hasNamedRoundRobin || filenameNote(relative)) stem = stem.replace(/[_-]\d+$/i, "");
  stem = stem.replace(/(?:_|-)(?:pppp|ppp|pp|mp|mf|ffff|fff|ff|p|f)(?=_|-|$)/ig, "");
  stem = stem.replace(/(?:_|-)v\d+(?=_|-|$)/ig, "");
  stem = stem.replace(/(?:_|-)(?:rr?|take)\d+(?=_|-|$)/ig, "");
  stem = stem.replace(/(?:_|-)r\d+(?=_|-|$)/ig, "");
  stem = stem.replace(/(?:_|-)main$/i, "");
  stem = stem.replace(/(?:_|-)sum$/i, "");
  if (!keepNote) stem = stem.replace(/(?:^|_)[A-Ga-g][#b]?-?\d+(?=_|$)/g, "");
  return stem.replace(/[_-]+/g, "-").replace(/^-+|-+$/g, "") || "sample";
}

function slug(value) {
  const normalized = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || `item-${sha256Buffer(value).slice(0, 10)}`;
}

function shortHash(value, length = 10) {
  return sha256Buffer(value).slice(0, length);
}

function displayWords(value) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function directoryMetadata(relative) {
  const directory = path.posix.dirname(relative);
  const parts = directory.split("/");
  let family = displayWords(parts.at(-2) ?? parts.at(-1));
  let articulation = displayWords(parts.at(-1));
  let program = 0;
  if (parts[0] === "Brass") {
    family = parts[1] === "F Horn" ? "French Horn" : parts[1] === "OldTrombone" ? "Trombone" : displayWords(parts[1]);
    articulation = displayWords(parts[2] ?? "Natural");
    program = family === "French Horn" ? 60 : family.includes("Trumpet") ? 56 : family.includes("Tuba") ? 58 : 57;
  } else if (parts[0] === "Strings") {
    family = displayWords(parts[1]);
    articulation = displayWords(parts[2] ?? "Natural");
    program = family.includes("Violin") ? 40 : family.includes("Viola") ? 41 : family.includes("Cello") ? 42 :
      family.includes("Contrabass") ? 43 : family.includes("Harp") ? 46 : 48;
  } else if (parts[0] === "Woodwinds") {
    family = displayWords(parts[1]);
    articulation = displayWords(parts[2] ?? "Natural");
    program = family.includes("Flute") || family.includes("Piccolo") ? 73 : family.includes("Oboe") ? 68 :
      family.includes("Clarinet") ? 71 : 70;
  } else if (parts[0] === "Keys") {
    family = parts[1] === "Organ" ? "Organ" : "Piano";
    articulation = displayWords(parts.slice(1).join(" "));
    program = family === "Organ" ? 16 : 0;
  } else if (parts[0] === "Percussion" && parts.length > 1) {
    family = displayWords(parts[1]);
    articulation = displayWords(parts.slice(2).join(" ") || "Natural");
    program = family.includes("Glock") ? 9 : family.includes("Marimba") ? 12 :
      family.includes("Xylo") ? 13 : family.includes("Timpani") ? 47 : 0;
  } else if (relative.startsWith("Percussion/TB_hit_")) {
    family = "Tubular Bells"; articulation = "Hit"; program = 14;
  }
  return { directory, family, articulation, program };
}

function learnedOctaveOffsets(official) {
  const counts = new Map();
  for (const region of official.regions) {
    if (!Number.isInteger(region.pitchKeycenter)) continue;
    const note = filenameNote(region.sample);
    if (!note) continue;
    const delta = region.pitchKeycenter - note.standardMidi;
    if (delta % 12 !== 0) continue;
    const directory = path.posix.dirname(region.sample);
    if (!counts.has(directory)) counts.set(directory, new Map());
    const options = counts.get(directory);
    options.set(delta, (options.get(delta) ?? 0) + 1);
  }
  return new Map([...counts].map(([directory, options]) => [directory,
    [...options].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]]));
}

function isPitchedCandidate(relative, octaveOffsets) {
  if (!filenameNote(relative)) return false;
  if (/\b(?:fall|buzz|gliss|glissando|scrape|rub|cresc|shake|roll|phrase|rhythm|effect|fx)\b/i.test(relative.replace(/[\/_-]+/g, " ")))
    return false;
  const directory = path.posix.dirname(relative);
  if (octaveOffsets.has(directory)) return true;
  if (/^Brass\/OldTrombone\/(?:Short|Sustain|Vibrato)\//.test(relative)) return true;
  if (/^Percussion\/TB_hit_/.test(relative)) return true;
  return false;
}

function rootMidi(relative, octaveOffsets) {
  const note = filenameNote(relative);
  if (!note) return null;
  const directory = path.posix.dirname(relative);
  const inferred = octaveOffsets.get(directory) ?? (/^Keys\//.test(relative) ? 0 : 12);
  const midi = note.standardMidi + inferred;
  return midi >= 0 && midi <= 127 ? midi : null;
}

function velocityBands(records) {
  const ranks = [...new Set(records.map(record => record.dynamic.rank))].sort((a, b) => a - b);
  return new Map(ranks.map((rank, index) => [rank, {
    lo: index === 0 ? 1 : Math.floor(127 * index / ranks.length) + 1,
    hi: index === ranks.length - 1 ? 127 : Math.floor(127 * (index + 1) / ranks.length)
  }]));
}

function keyBands(roots) {
  return new Map(roots.map((root, index) => [root, {
    lo: index === 0 ? root : Math.floor((roots[index - 1] + root) / 2) + 1,
    hi: index === roots.length - 1 ? root : Math.floor((root + roots[index + 1]) / 2)
  }]));
}

function relativeSamplePath(sfzFile, sampleFile) {
  return path.posix.relative(path.posix.dirname(sfzFile), sampleFile);
}

function roundedSeconds(value) {
  return Number(value.toFixed(6));
}

const ONE_SHOT_RELEASE_SEC = 0.3;
const ONE_SHOT_TAIL_AFTER_SAMPLE_SEC = 0.5;

function requiredOneShotWindow(duration) {
  return Number(Math.min(120, Math.max(ONE_SHOT_TAIL_AFTER_SAMPLE_SEC,
    duration + ONE_SHOT_TAIL_AFTER_SAMPLE_SEC)).toFixed(3));
}

function melodicRelease(articulation) {
  if (/short|stac|spic|pizz/i.test(articulation)) return 0.55;
  if (/trem|roll/i.test(articulation)) return 1.8;
  return 1.1;
}

function createPitchedDefinition(stage, directory, records, durations) {
  const metadata = directoryMetadata(records[0].path);
  const roots = [...new Set(records.map(record => record.midi))].sort((a, b) => a - b);
  const bands = keyBands(roots);
  const directoryPath = directory.split("/").map(slug).join("/");
  const file = `sfz-extra/pitched/${directoryPath}/complete-${shortHash(directory)}.sfz`;
  const maxDuration = Math.max(...records.map(record => durations.get(record.path)));
  const release = melodicRelease(metadata.articulation);
  const lines = [
    "// Aria supplemental mapping for official VSCO 2 CE samples.",
    "// Upstream SFZ files remain byte-for-byte unchanged.",
    `<global> ampeg_release=${release}`
  ];
  for (const root of roots) {
    const rootRecords = records.filter(record => record.midi === root);
    const velocities = velocityBands(rootRecords);
    for (const rank of [...new Set(rootRecords.map(record => record.dynamic.rank))].sort((a, b) => a - b)) {
      const cell = rootRecords.filter(record => record.dynamic.rank === rank).sort((a, b) => bytewise(a.path, b.path));
      const velocity = velocities.get(rank), key = bands.get(root);
      for (const [index, record] of cell.entries()) {
        const sequence = cell.length > 1 ? ` seq_length=${cell.length} seq_position=${index + 1}` : "";
        lines.push(`<region> lokey=${key.lo} hikey=${key.hi} pitch_keycenter=${root} lovel=${velocity.lo} hivel=${velocity.hi}${sequence} loop_mode=no_loop sample=${relativeSamplePath(file, record.path)}`);
      }
    }
  }
  const output = path.join(stage, ...file.split("/"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o644 });
  return {
    id: `vsco-extra-pitched-${slug(directory)}-${shortHash(directory, 8)}`,
    path: file,
    name: `${metadata.family} Complete Samples`,
    family: metadata.family,
    articulation: slug(metadata.articulation),
    label: `Complete Sample Set (전체 샘플 세트) — ${metadata.articulation} 주법의 공식 WAV와 추가 테이크를 모두 사용`,
    source: "VSCO 2 CE",
    category: directory.split("/")[0],
    kind: "pitched-instrument",
    gm: { bank: 0, program: metadata.program },
    gmApproximation: `GM program ${metadata.program + 1} approximation (GM 프로그램 ${metadata.program + 1} 근사치)`,
    drum: false,
    sourceSampleCount: records.length,
    maxSampleDurationSec: roundedSeconds(maxDuration),
    tailHintSec: release,
    release,
    samplePaths: records.map(record => record.path)
  };
}

function clipSemanticKey(relative) {
  const directory = path.posix.dirname(relative);
  const base = semanticStem(relative, { keepNote: true });
  return `${directory}\0${base}`;
}

function createClipDefinition(stage, key, records, durations) {
  const [directory, stem] = key.split("\0");
  const sorted = [...records].sort((a, b) => a.dynamic.rank - b.dynamic.rank || bytewise(a.path, b.path));
  const maxDuration = Math.max(...sorted.map(record => durations.get(record.path)));
  const directoryPath = directory.split("/").map(slug).join("/");
  const file = `sfz-extra/clips/${directoryPath}/${slug(stem)}-${shortHash(key)}.sfz`;
  const velocities = velocityBands(sorted);
  const lines = [
    "// Recorded one-shot clip from the official VSCO 2 CE sample tree.",
    "// Key 60 plays the original recording without chromatic pitch mapping.",
    `<global> ampeg_release=${ONE_SHOT_RELEASE_SEC}`
  ];
  for (const rank of [...new Set(sorted.map(record => record.dynamic.rank))].sort((a, b) => a - b)) {
    const cell = sorted.filter(record => record.dynamic.rank === rank);
    const velocity = velocities.get(rank);
    for (const [index, record] of cell.entries()) {
      const sequence = cell.length > 1 ? ` seq_length=${cell.length} seq_position=${index + 1}` : "";
      lines.push(`<region> key=60 pitch_keycenter=60 lovel=${velocity.lo} hivel=${velocity.hi}${sequence} loop_mode=one_shot sample=${relativeSamplePath(file, record.path)}`);
    }
  }
  const output = path.join(stage, ...file.split("/"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o644 });
  const metadata = directoryMetadata(sorted[0].path);
  const display = displayWords(stem);
  return {
    id: `vsco-extra-clip-${slug(directory)}-${slug(stem)}-${shortHash(key, 8)}`,
    path: file,
    name: display,
    family: metadata.family || "Recorded Effects",
    articulation: "recorded-clip",
    label: `Recorded Clip (녹음 클립) — ${display} 원음을 key 60에서 한 번 재생`,
    source: "VSCO 2 CE",
    category: directory.split("/")[0],
    kind: "clip",
    duration: "one-shot",
    gm: { bank: 128, program: 0 },
    gmApproximation: "GM percussion key 60 approximation (GM 타악기 60번 근사치) — 원본 녹음을 그대로 재생",
    drum: true,
    sourceSampleCount: sorted.length,
    durationSec: roundedSeconds(maxDuration),
    maxSampleDurationSec: roundedSeconds(maxDuration),
    // durationSec is the recording itself. tailHintSec is only the short guard
    // after the sample ends; combining them here makes the renderer count a
    // long clip twice.
    tailHintSec: ONE_SHOT_TAIL_AFTER_SAMPLE_SEC,
    release: ONE_SHOT_RELEASE_SEC,
    pieces: [{
      id: "play", key: 60, name: "Play",
      label: "Play (재생) — 원래 녹음을 한 번 재생",
      sampleStem: path.posix.basename(sorted[0].path, path.posix.extname(sorted[0].path))
    }],
    samplePaths: sorted.map(record => record.path)
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o644 });
}

async function inventory(root, excluded) {
  const records = listFilesNoLinks(root, excluded);
  return await mapLimit(records, 12, async record => ({
    file: record.path,
    bytes: record.size,
    sha256: await sha256File(record.absolute)
  }));
}

function copyOfficialTree(source, stage, records) {
  for (const record of records) {
    const destination = path.join(stage, ...record.path.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(record.absolute, destination, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(destination, 0o644);
  }
}

function verifyManagedIdentity(source) {
  const metadataFile = path.join(source, ".aria-pack.json");
  if (!fs.existsSync(metadataFile)) return;
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  if (metadata.packId !== "vsco2-ce" || metadata.source?.commit !== VSCO_IDENTITY.commit ||
      metadata.source?.tree !== VSCO_IDENTITY.tree || metadata.source?.repositoryUrl !== VSCO_IDENTITY.repositoryUrl)
    fail("SOURCE_IDENTITY_MISMATCH", "managed VSCO source does not match the pinned official commit/tree", {
      packId: metadata.packId, source: metadata.source
    });
}

function inspectTarArchive(archive) {
  const names = String(command("tar", ["-tzf", archive])).split(/\r?\n/).filter(Boolean);
  const verbose = String(command("tar", ["-tvzf", archive])).split(/\r?\n/).filter(Boolean);
  if (!names.length || names.length !== verbose.length)
    fail("ARCHIVE_LIST_INVALID", "archive name/type listing is inconsistent", { names: names.length, verbose: verbose.length });
  const roots = new Set();
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    if (name.includes("\\") || name.startsWith("/") || name.includes("\0"))
      fail("ARCHIVE_PATH_UNSAFE", `unsafe archive path: ${name}`);
    const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
    const parts = normalized.split("/");
    if (!normalized || parts.some(part => !part || part === "." || part === ".."))
      fail("ARCHIVE_PATH_UNSAFE", `unsafe archive path: ${name}`);
    roots.add(parts[0]);
    const type = verbose[index][0];
    if (type !== "-" && type !== "d") fail("ARCHIVE_TYPE_UNSAFE", `archive link/special file is forbidden: ${name}`, { type });
  }
  if (roots.size !== 1) fail("ARCHIVE_LAYOUT_INVALID", "archive must have one top-level directory", { roots: [...roots] });
  return { entries: names, root: [...roots][0] };
}

function extractArchive(archive, work) {
  const inspected = inspectTarArchive(archive);
  fs.mkdirSync(work, { recursive: false, mode: 0o700 });
  command("tar", ["-xzf", archive, "-C", work, "--no-same-owner", "--no-same-permissions"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" }
  });
  const source = path.join(work, inspected.root);
  listFilesNoLinks(source);
  return source;
}

function acquireLock(output) {
  const file = `${output}.aria-prepare.lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, output })}\n`);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fail(error.code === "EEXIST" ? "OUTPUT_LOCKED" : "OUTPUT_LOCK_FAILED", `cannot lock output: ${file}`, undefined, error);
  }
  return { file, descriptor };
}

function releaseLock(lock) {
  try { fs.closeSync(lock.descriptor); } catch {}
  try { fs.rmSync(lock.file, { force: true }); } catch {}
}

export function verifyPreparedVsco(root, officialEntryFiles) {
  const wavFiles = listFilesNoLinks(root).filter(record => path.posix.extname(record.path).toLowerCase() === ".wav");
  const runtime = JSON.parse(fs.readFileSync(path.join(root, "catalog", "runtime.json"), "utf8"));
  const entryFiles = [...officialEntryFiles, ...runtime.map(entry => entry.path)];
  const parsed = inspectSfzReferences(root, entryFiles);
  const wavSet = new Set(wavFiles.map(record => record.path));
  const referencedWav = new Set([...parsed.uniqueReferences].filter(file => file.toLowerCase().endsWith(".wav")));
  const missing = [...referencedWav].filter(file => !wavSet.has(file));
  const unmapped = [...wavSet].filter(file => !referencedWav.has(file));
  let velocityHoles = 0, invalidKeyRanges = 0;
  for (const entry of runtime) {
    const one = inspectSfzReferences(root, [entry.path]);
    if (!one.regions.length) invalidKeyRanges++;
    const covered = new Map();
    for (const region of one.regions) {
      if (region.lokey < 0 || region.hikey > 127 || region.lokey > region.hikey ||
          region.lovel < 0 || region.hivel > 127 || region.lovel > region.hivel) invalidKeyRanges++;
      for (let key = region.lokey; key <= region.hikey; key++) {
        if (!covered.has(key)) covered.set(key, []);
        covered.get(key).push({ lo: region.lovel, hi: region.hivel });
      }
    }
    for (const ranges of covered.values())
      for (let velocity = 1; velocity <= 127; velocity++)
        if (!ranges.some(range => velocity >= range.lo && velocity <= range.hi)) velocityHoles++;
  }
  return {
    audioFiles: wavSet.size,
    officialEntryFiles: officialEntryFiles.length,
    supplementalEntryFiles: runtime.length,
    referenceLines: parsed.references.length,
    uniqueReferencedAudio: referencedWav.size,
    missingReferences: missing.length,
    unmappedAudio: unmapped.length,
    velocityHoles,
    invalidKeyRanges
  };
}

export async function prepareVscoPack(options = {}) {
  if (!options.output) fail("OUTPUT_REQUIRED", "--output must name a new prepared directory");
  const output = path.resolve(options.output);
  if (fs.existsSync(output)) fail("OUTPUT_EXISTS", `existing output will not be overwritten: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const lock = acquireLock(output);
  const stage = path.join(path.dirname(output), `.${path.basename(output)}.prepare-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  let archiveSha256 = options.archiveSha256 ?? null;
  let archiveFile = null;
  let source = null;
  try {
    fs.mkdirSync(stage, { recursive: false, mode: 0o755 });
    if (options.archive) {
      archiveFile = path.resolve(options.archive);
      archiveSha256 = await sha256File(archiveFile);
      source = extractArchive(archiveFile, path.join(stage, ".source"));
    } else {
      source = fs.realpathSync(path.resolve(options.source ?? DEFAULT_SOURCE));
      verifyManagedIdentity(source);
      if (!/^[a-f0-9]{64}$/.test(archiveSha256 ?? ""))
        fail("ARCHIVE_IDENTITY_REQUIRED", "directory preparation requires the pinned --archive-sha256 identity");
    }

    const excluded = new Set([".aria-pack.json"]);
    const sourceFiles = listFilesNoLinks(source, excluded);
    const sourceSnapshot = sourceFiles.map(record => ({
      path: record.path, size: record.size, signature: record.signature
    }));
    const expectedTrackedFiles = options.expectedTrackedFiles ?? VSCO_IDENTITY.trackedFiles;
    const wavFiles = sourceFiles.filter(record => path.posix.extname(record.path).toLowerCase() === ".wav");
    const sfzFiles = sourceFiles.filter(record => path.posix.extname(record.path).toLowerCase() === ".sfz");
    const expectedWavFiles = options.expectedWavFiles ?? VSCO_IDENTITY.wavFiles;
    const expectedOfficialSfzFiles = options.expectedOfficialSfzFiles ?? VSCO_IDENTITY.officialSfzFiles;
    if (sourceFiles.length !== expectedTrackedFiles || wavFiles.length !== expectedWavFiles || sfzFiles.length !== expectedOfficialSfzFiles)
      fail("SOURCE_COUNT_MISMATCH", "VSCO source counts do not match the pinned tree", {
        files: sourceFiles.length, wav: wavFiles.length, sfz: sfzFiles.length,
        expectedTrackedFiles, expectedWavFiles, expectedOfficialSfzFiles
      });
    const licenseFile = path.join(source, "LICENSE");
    const expectedLicenseSha256 = options.expectedLicenseSha256 ?? VSCO_IDENTITY.licenseSha256;
    if (await sha256File(licenseFile) !== expectedLicenseSha256)
      fail("LICENSE_MISMATCH", "VSCO CC0 LICENSE does not match the pinned source");

    const repositoryManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "packs", "vsco2-ce.json"), "utf8"));
    const officialEntryFiles = repositoryManifest.content.entryFiles.filter(file => !file.startsWith("sfz-extra/"));
    if (officialEntryFiles.length !== expectedOfficialSfzFiles)
      fail("OFFICIAL_CATALOG_MISMATCH", `expected ${expectedOfficialSfzFiles} official entry paths`, { officialEntryFiles });
    const official = inspectSfzReferences(source, officialEntryFiles);
    const expectedReferenceLines = options.expectedReferenceLines ?? VSCO_IDENTITY.officialSampleReferenceLines;
    const expectedUniqueReferences = options.expectedUniqueReferences ?? VSCO_IDENTITY.officialUniqueReferencedSamples;
    if (official.references.length !== expectedReferenceLines || official.uniqueReferences.size !== expectedUniqueReferences)
      fail("OFFICIAL_REFERENCE_MISMATCH", "official SFZ reference counts differ from the pinned tree", {
        referenceLines: official.references.length, uniqueReferences: official.uniqueReferences.size,
        expectedReferenceLines, expectedUniqueReferences
      });
    const wavSet = new Set(wavFiles.map(record => record.path));
    const officialNonWav = [...official.uniqueReferences].filter(file => !wavSet.has(file));
    if (officialNonWav.length) fail("OFFICIAL_REFERENCE_MISMATCH", "official SFZ points outside the WAV inventory", { officialNonWav });
    const unreferenced = wavFiles.map(record => record.path).filter(file => !official.uniqueReferences.has(file));
    const expectedUnreferenced = options.expectedUnreferenced ?? VSCO_IDENTITY.officialUnreferencedSamples;
    if (unreferenced.length !== expectedUnreferenced)
      fail("OFFICIAL_REFERENCE_MISMATCH", "unreferenced WAV count differs from the pinned tree", {
        actual: unreferenced.length, expected: expectedUnreferenced
      });

    copyOfficialTree(source, stage, sourceFiles);
    const durations = new Map();
    for (const record of wavFiles) durations.set(record.path, readWavInfo(record.absolute).durationSec);
    if (options.archive) fs.rmSync(path.join(stage, ".source"), { recursive: true, force: true });
    const offsets = learnedOctaveOffsets(official);
    const unreferencedSet = new Set(unreferenced);
    const pitchedDirectories = new Set(unreferenced.filter(file => isPitchedCandidate(file, offsets)).map(path.posix.dirname));
    const runtime = [];
    const mappedBySupplement = new Set();
    for (const directory of [...pitchedDirectories].sort(bytewise)) {
      const records = wavFiles.filter(record => path.posix.dirname(record.path) === directory).map(record => ({
        path: record.path,
        midi: rootMidi(record.path, offsets),
        dynamic: dynamicMetadata(record.path)
      })).filter(record => Number.isInteger(record.midi));
      if (!records.length) continue;
      const entry = createPitchedDefinition(stage, directory, records, durations);
      runtime.push(entry);
      for (const file of entry.samplePaths) mappedBySupplement.add(file);
    }
    const clipRecords = unreferenced.filter(file => !mappedBySupplement.has(file)).map(file => ({
      path: file, dynamic: dynamicMetadata(file)
    }));
    const clipGroups = new Map();
    for (const record of clipRecords) {
      const key = clipSemanticKey(record.path);
      if (!clipGroups.has(key)) clipGroups.set(key, []);
      clipGroups.get(key).push(record);
    }
    for (const [key, records] of [...clipGroups].sort(([a], [b]) => bytewise(a, b))) {
      const entry = createClipDefinition(stage, key, records, durations);
      runtime.push(entry);
      for (const file of entry.samplePaths) mappedBySupplement.add(file);
    }
    runtime.sort((a, b) => bytewise(a.path, b.path));
    const newlyMapped = unreferenced.filter(file => mappedBySupplement.has(file));
    if (newlyMapped.length !== unreferenced.length)
      fail("SUPPLEMENTAL_MAPPING_INCOMPLETE", "some unreferenced WAV files have no supplemental mapping", {
        missing: unreferenced.filter(file => !mappedBySupplement.has(file))
      });
    writeJson(path.join(stage, "catalog", "runtime.json"), runtime);
    writeJson(path.join(stage, "catalog", "samples.json"), wavFiles.map(record => ({
      file: record.path,
      sha256: null,
      durationSec: roundedSeconds(durations.get(record.path)),
      officialReferenced: official.uniqueReferences.has(record.path),
      supplementalReferenced: mappedBySupplement.has(record.path)
    })));

    const verification = verifyPreparedVsco(stage, officialEntryFiles);
    if (verification.audioFiles !== expectedWavFiles || verification.uniqueReferencedAudio !== expectedWavFiles ||
        verification.missingReferences || verification.unmappedAudio || verification.velocityHoles || verification.invalidKeyRanges)
      fail("PREPARED_VERIFY_FAILED", "prepared VSCO pack is incomplete", verification);

    const longest = [...durations].sort((a, b) => b[1] - a[1] || bytewise(a[0], b[0]))[0];
    const stats = {
      officialFiles: sourceFiles.length,
      officialSfzFiles: officialEntryFiles.length,
      officialReferenceLines: official.references.length,
      officialUniqueReferencedSamples: official.uniqueReferences.size,
      officialUnreferencedSamples: unreferenced.length,
      wavFiles: wavFiles.length,
      supplementalEntries: runtime.length,
      supplementalPitchedEntries: runtime.filter(entry => entry.kind === "pitched-instrument").length,
      supplementalClipEntries: runtime.filter(entry => entry.kind === "clip").length,
      supplementalUniqueSamples: mappedBySupplement.size,
      totalUniquePlayableSamples: verification.uniqueReferencedAudio,
      longestSample: {
        file: longest[0],
        durationSec: roundedSeconds(longest[1]),
        tailHintSec: ONE_SHOT_TAIL_AFTER_SAMPLE_SEC,
        requiredRenderWindowFromNoteStartSec: requiredOneShotWindow(longest[1])
      }
    };
    writeJson(path.join(stage, "catalog", "verification.json"), stats);

    const sampleCatalogFile = path.join(stage, "catalog", "samples.json");
    const sampleCatalog = JSON.parse(fs.readFileSync(sampleCatalogFile, "utf8"));
    await mapLimit(sampleCatalog, 12, async record => {
      record.sha256 = await sha256File(path.join(stage, ...record.file.split("/")));
    });
    fs.writeFileSync(sampleCatalogFile, `${JSON.stringify(sampleCatalog, null, 2)}\n`);

    const checksums = await inventory(stage, new Set(["pack.json", "catalog/checksums.json"]));
    writeJson(path.join(stage, "catalog", "checksums.json"), checksums);
    const checksumsRaw = fs.readFileSync(path.join(stage, "catalog", "checksums.json"));
    writeJson(path.join(stage, "pack.json"), {
      format: 1,
      id: "vsco2-ce",
      name: "VS Chamber Orchestra: Community Edition — complete",
      source: {
        url: VSCO_IDENTITY.repositoryUrl,
        archive: options.archive ? path.basename(options.archive) : options.archiveName ?? "vsco2-ce-official-source.tar.gz",
        sha256: archiveSha256,
        officialCommit: VSCO_IDENTITY.commit,
        officialTree: VSCO_IDENTITY.tree
      },
      checksums: { algorithm: "sha256", file: "catalog/checksums.json", sha256: sha256Buffer(checksumsRaw) },
      verification: stats
    });
    if (archiveFile) {
      const finalArchiveSha256 = await sha256File(archiveFile);
      if (finalArchiveSha256 !== archiveSha256)
        fail("ARCHIVE_CHANGED", "official VSCO archive changed during preparation", {
          before: archiveSha256, after: finalArchiveSha256
        });
    } else {
      const finalSnapshot = listFilesNoLinks(source, excluded).map(record => ({
        path: record.path, size: record.size, signature: record.signature
      }));
      if (JSON.stringify(finalSnapshot) !== JSON.stringify(sourceSnapshot))
        fail("SOURCE_CHANGED", "managed VSCO source changed during preparation");
    }
    fs.renameSync(stage, output);
    return { output, archiveSha256, checksumsSha256: sha256Buffer(checksumsRaw), verification, stats, runtime };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  } finally {
    releaseLock(lock);
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (["--source", "--archive", "--output", "--archive-sha256", "--archive-name"].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail("ARGUMENT_ERROR", `${argument} requires a value`);
      const key = argument.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      options[key] = value;
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else fail("ARGUMENT_ERROR", `unknown argument: ${argument}`);
  }
  if (options.source && options.archive) fail("ARGUMENT_ERROR", "--source and --archive are mutually exclusive");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage:
  node tools/prepare-vsco2-ce-sfz.mjs --archive <official-tar.gz> --output <new-directory>
  node tools/prepare-vsco2-ce-sfz.mjs --source <managed-directory> --archive-sha256 <sha256> --output <new-directory>`);
    return;
  }
  const result = await prepareVscoPack(options);
  console.log(JSON.stringify({
    output: result.output,
    archiveSha256: result.archiveSha256,
    checksumsSha256: result.checksumsSha256,
    ...result.stats
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`${error.name}${error.code ? ` [${error.code}]` : ""}: ${error.message}`);
    if (error.details) console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 1;
  });
}

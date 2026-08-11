// aria — pinned sfizz_render CLI를 동기식 SFZ offline sampler로 감싼다.
//
// 이 adapter는 SFZ를 다른 SoundFont나 preset으로 대체하지 않는다. 실행 파일, pack,
// SFZ, include, sample, note coverage 중 하나라도 정확하지 않으면 렌더 전에 실패한다.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assignSfizzChannels, MAX_SFIZZ_MIDI_CHANNELS } from "./sfizz-channels.js";

export const SFIZZ_ENGINE_ID = "sfizz";
export const SFIZZ_BLOCK_SIZE = 128;
export const SFIZZ_PITCH_RANGE = 12;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_MANIFEST_PATH = path.join(ROOT, "engines", "sfizz.json");
const PACK_MANIFEST_DIR = path.join(ROOT, "packs");
const MAX_SFZ_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SFZ_INCLUDE_FILES = 256;
const MAX_GAIN = 16;
const verifiedBinaries = new Map();
const packManifestCache = new Map();
const installedPackCache = new Map();

export class SfizzEngineError extends Error {
  constructor(code, message, details = undefined, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = "SfizzEngineError";
    this.code = code;
    this.engine = SFIZZ_ENGINE_ID;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details, cause) => {
  throw new SfizzEngineError(code, message, details, cause);
};

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    fail("INVALID_RENDER_REQUEST", `${name}은(는) ${min}~${max} 정수여야 합니다`, { name, value, min, max });
  return value;
}

function finite(value, name, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    fail("INVALID_RENDER_REQUEST", `${name}은(는) ${min}~${max} 사이 숫자여야 합니다`, { name, value, min, max });
  return value;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value))
    fail("ASSET_SPEC_INVALID", `${label}은(는) 비어 있지 않은 상대 경로여야 합니다`, { [label]: value });
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some(part => part === "" || part === "." || part === ".."))
    fail("ASSET_PATH_ESCAPE", `${label}이(가) pack 경계를 벗어날 수 있습니다`, { [label]: value });
  return normalized;
}

function readJson(file, code, label) {
  let raw;
  try { raw = fs.readFileSync(file); }
  catch (error) {
    fail(code, `${label}을(를) 읽지 못했습니다: ${file}`, { file, causeCode: error.code }, error);
  }
  try { return { value: JSON.parse(raw.toString("utf8")), raw }; }
  catch (error) {
    fail("ASSET_CORRUPT", `${label}이(가) 올바른 JSON이 아닙니다: ${file}`, { file }, error);
  }
}

function fileSignature(file) {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function packManifest(packId) {
  const file = path.join(PACK_MANIFEST_DIR, `${packId}.json`);
  let signature;
  try { signature = fileSignature(file); }
  catch (error) {
    fail("PACK_MISSING", `pack ${packId} manifest를 읽지 못했습니다: ${file}`,
      { pack: packId, file, causeCode: error.code }, error);
  }
  const cached = packManifestCache.get(packId);
  if (cached?.signature === signature) return cached;
  const { value, raw } = readJson(file, "PACK_MISSING", `pack ${packId} manifest`);
  const record = { file, signature, value, raw, sha256: sha256Buffer(raw) };
  packManifestCache.set(packId, record);
  return record;
}

function assertRegularFile(file, missingCode, label) {
  let stat;
  try { stat = fs.statSync(file); }
  catch (error) {
    fail(error.code === "ENOENT" ? missingCode : "ASSET_UNREADABLE",
      `${label}을(를) 읽을 수 없습니다: ${file}`, { file, causeCode: error.code }, error);
  }
  if (!stat.isFile()) fail(missingCode, `${label}이(가) 일반 파일이 아닙니다: ${file}`, { file });
  return stat;
}

function pathInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
    return candidate;
  fail("ASSET_PATH_ESCAPE", `${label}이(가) pack 경계를 벗어납니다`, { root, path: candidate });
}

function packRootOverride(packRoots, id) {
  if (packRoots instanceof Map) return packRoots.get(id);
  if (packRoots && typeof packRoots === "object" && !Array.isArray(packRoots)) return packRoots[id];
  return undefined;
}

function installedPackRoot(packId, options) {
  if (typeof packId !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(packId))
    fail("ASSET_SPEC_INVALID", "SFZ pack id는 안전한 소문자 ID여야 합니다", { pack: packId });

  const explicit = packRootOverride(options?.packRoots, packId);
  if (explicit !== undefined) {
    if (typeof explicit !== "string" || !path.isAbsolute(explicit))
      fail("ASSET_SPEC_INVALID", `packRoots.${packId}는 절대 경로여야 합니다`, { pack: packId, root: explicit });
    let root;
    try { root = fs.realpathSync(explicit); }
    catch (error) {
      fail("PACK_MISSING", `SFZ pack ${packId}이(가) 설치되지 않았습니다: ${explicit}`,
        { pack: packId, root: explicit, causeCode: error.code }, error);
    }
    return { root, manifest: null, installed: null, explicit: true };
  }

  const manifestRecord = packManifest(packId);
  const manifestFile = manifestRecord.file;
  const manifest = manifestRecord.value;
  const manifestRaw = manifestRecord.raw;
  if (manifest?.id !== packId)
    fail("ASSET_CORRUPT", `pack manifest ID가 요청과 다릅니다: ${manifestFile}`,
      { requested: packId, manifestId: manifest?.id });
  const installDir = safeRelativePath(manifest.installDir, "installDir");
  if (installDir.includes("/"))
    fail("ASSET_SPEC_INVALID", "pack installDir은 pack home 바로 아래의 한 디렉터리여야 합니다", { installDir });
  const packHomeOverride = process.env.ARIA_PACKS_DIR || process.env.ARIA_PACK_HOME;
  const packHome = packHomeOverride
    ? path.resolve(packHomeOverride)
    : path.join(os.homedir(), ".aria", "packs");
  const expectedRoot = path.join(packHome, installDir);
  let expectedRootStat;
  try { expectedRootStat = fs.lstatSync(expectedRoot); }
  catch (error) {
    fail("PACK_MISSING", `SFZ pack ${packId}이(가) 설치되지 않았습니다: ${expectedRoot}`,
      { pack: packId, root: expectedRoot, causeCode: error.code }, error);
  }
  if (!expectedRootStat.isDirectory() || expectedRootStat.isSymbolicLink())
    fail("PACK_UNVERIFIED", `SFZ pack ${packId} root는 symlink가 아닌 실제 디렉터리여야 합니다`,
      { pack: packId, root: expectedRoot });
  let root;
  try { root = fs.realpathSync(expectedRoot); }
  catch (error) {
    fail("PACK_MISSING", `SFZ pack ${packId}이(가) 설치되지 않았습니다: ${expectedRoot}`,
      { pack: packId, root: expectedRoot, causeCode: error.code }, error);
  }
  pathInside(fs.realpathSync(packHome), root, "pack root");
  if (fs.existsSync(path.join(root, ".git")))
    fail("PACK_UNVERIFIED", `관리되는 SFZ pack ${packId}에 .git 디렉터리가 남아 있습니다`, { pack: packId, root });

  const installedFile = path.join(root, ".aria-pack.json");
  let installedStat;
  try { installedStat = fs.lstatSync(installedFile); }
  catch (error) {
    fail("PACK_UNVERIFIED", `pack ${packId} 설치 metadata가 없습니다: ${installedFile}`,
      { pack: packId, file: installedFile, causeCode: error.code }, error);
  }
  if (!installedStat.isFile() || installedStat.isSymbolicLink())
    fail("PACK_UNVERIFIED", `pack ${packId} 설치 metadata는 symlink가 아닌 실제 파일이어야 합니다`,
      { pack: packId, file: installedFile });
  const installedSignature = fileSignature(installedFile);
  const cacheKey = `${packId}\0${root}`;
  const cached = installedPackCache.get(cacheKey);
  if (cached?.installedSignature === installedSignature &&
      cached?.manifestSignature === manifestRecord.signature && cached?.root === root) {
    if (cached.error) throw cached.error;
    return cached.value;
  }
  try {
    const { value: installed } = readJson(installedFile, "PACK_UNVERIFIED", `pack ${packId} install metadata`);
    const installedId = installed.packId ?? installed.id;
    const installedCommit = installed.commit ?? installed.source?.commit;
    if (installed.schemaVersion !== 1 || installedId !== packId || installed.name !== manifest.name ||
        installed.format !== manifest.format || installed.installDir !== manifest.installDir ||
        installed.source?.type !== manifest.source?.type ||
        installed.source?.repositoryUrl !== manifest.source?.repositoryUrl ||
        installed.source?.branch !== manifest.source?.branch ||
        installedCommit !== manifest.source?.commit || installed.source?.tree !== manifest.source?.tree ||
        installed.license?.spdx !== manifest.license?.spdx ||
        installed.license?.file !== manifest.license?.file ||
        installed.license?.sha256 !== manifest.license?.sha256 ||
        installed.manifestSha256 !== sha256Buffer(manifestRaw)) {
      fail("PACK_UNVERIFIED", `SFZ pack ${packId}의 설치 정보가 고정 manifest와 다릅니다`, {
        pack: packId,
        installedId,
        expectedCommit: manifest.source?.commit,
        installedCommit,
        expectedManifestSha256: sha256Buffer(manifestRaw),
        installedManifestSha256: installed.manifestSha256
      });
    }
    if (!Array.isArray(installed.entries))
      fail("PACK_UNVERIFIED", `SFZ pack ${packId} 설치 metadata에 entry checksum 목록이 없습니다`, { pack: packId });
    const entryMap = new Map();
    for (const entry of installed.entries) {
      if (!entry || typeof entry.path !== "string" || entryMap.has(entry.path))
        fail("PACK_UNVERIFIED", `SFZ pack ${packId} 설치 metadata의 entry 목록이 올바르지 않습니다`, { pack: packId });
      entryMap.set(entry.path, entry);
    }
    const value = { root, manifest, installed, entryMap, explicit: false };
    installedPackCache.set(cacheKey, {
      root, manifestSignature: manifestRecord.signature, installedSignature, value
    });
    return value;
  } catch (error) {
    installedPackCache.set(cacheKey, {
      root, manifestSignature: manifestRecord.signature, installedSignature, error
    });
    throw error;
  }
}

/**
 * SFZ preset contract:
 *   { engine:'sfizz', sfz:'/absolute/file.sfz', ... }
 * or
 *   { engine:'sfizz', pack:'pack-id', sfz:'entry/file.sfz', ... }
 *
 * Relative paths require an exact pack manifest/install record or an explicit absolute
 * `packRoots[pack]` override. cwd and similarly named directories are never searched.
 */
export function resolveSfzPath(spec, options = {}) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || spec.engine !== SFIZZ_ENGINE_ID)
    fail("ASSET_SPEC_INVALID", "SFZ preset은 {engine:'sfizz', sfz} 객체여야 합니다", { spec });
  if (typeof spec.sfz !== "string" || !spec.sfz.trim())
    fail("ASSET_SPEC_INVALID", "SFZ preset의 sfz 경로가 비어 있습니다", { spec });

  if (path.isAbsolute(spec.sfz)) {
    if (spec.pack !== undefined)
      fail("ASSET_SPEC_INVALID", "절대 sfz 경로와 pack ID를 동시에 지정할 수 없습니다", { spec });
    const file = path.resolve(spec.sfz);
    assertRegularFile(file, "ASSET_MISSING", "SFZ 파일");
    return { file: fs.realpathSync(file), root: null, pack: null, manifest: null, installed: null };
  }

  const relative = safeRelativePath(spec.sfz, "sfz");
  if (!spec.pack)
    fail("PACK_ROOT_MISSING", "상대 SFZ 경로는 pack ID와 검증된 pack root가 필요합니다", { sfz: spec.sfz });
  const pack = installedPackRoot(spec.pack, options);
  const candidate = pathInside(pack.root, path.resolve(pack.root, relative), "SFZ 경로");
  assertRegularFile(candidate, "ASSET_MISSING", "SFZ 파일");
  const real = pathInside(pack.root, fs.realpathSync(candidate), "SFZ real path");
  if (pack.manifest?.content?.entryFiles && !pack.manifest.content.entryFiles.includes(relative))
    fail("ASSET_UNREGISTERED", `SFZ ${relative}이(가) pack ${spec.pack} manifest에 등록되지 않았습니다`,
      { pack: spec.pack, sfz: relative });
  if (pack.installed) {
    const recorded = pack.entryMap?.get(relative) ?? pack.installed.entries.find(entry => entry?.path === relative);
    const stat = fs.statSync(real);
    if (!recorded || recorded.size !== stat.size || typeof recorded.sha256 !== "string" ||
        (options.verifyEntryChecksum !== false && recorded.sha256 !== sha256File(real))) {
      fail("PACK_UNVERIFIED", `SFZ ${relative}의 크기/checksum이 설치 metadata와 다릅니다`, {
        pack: spec.pack,
        sfz: relative,
        expectedSize: recorded?.size,
        actualSize: stat.size,
        expectedSha256: recorded?.sha256
      });
    }
  }
  return { file: real, root: pack.root, pack: spec.pack, manifest: pack.manifest, installed: pack.installed };
}

function engineManifest() {
  const { value: manifest } = readJson(ENGINE_MANIFEST_PATH, "ENGINE_UNAVAILABLE", "sfizz engine manifest");
  if (manifest?.id !== SFIZZ_ENGINE_ID || !/^[a-f0-9]{40}$/.test(manifest.commit ?? ""))
    fail("ENGINE_UNAVAILABLE", "sfizz engine manifest의 id/commit이 올바르지 않습니다", { manifestFile: ENGINE_MANIFEST_PATH });
  safeRelativePath(manifest.binaryRelativePath, "binaryRelativePath");
  return manifest;
}

export function resolveSfizzBinary() {
  const override = process.env.ARIA_SFIZZ_RENDER?.trim();
  const manifest = engineManifest();
  const engineHome = process.env.ARIA_SFIZZ_ENGINE_HOME
    ? path.resolve(process.env.ARIA_SFIZZ_ENGINE_HOME)
    : path.join(os.homedir(), ".aria", "engines", "sfizz");
  const binary = override
    ? path.resolve(override)
    : path.join(engineHome, manifest.commit.slice(0, 12), manifest.binaryRelativePath);
  const stat = assertRegularFile(binary, "ENGINE_UNAVAILABLE", "sfizz_render 실행 파일");
  if ((stat.mode & 0o111) === 0)
    fail("ENGINE_UNAVAILABLE", `sfizz_render에 실행 권한이 없습니다: ${binary}`, { binary });

  const signature = `${binary}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  if (verifiedBinaries.has(signature)) return verifiedBinaries.get(signature);

  let installed = null;
  if (!override) {
    const installFile = path.join(engineHome, manifest.commit.slice(0, 12), "install.json");
    installed = readJson(installFile, "ENGINE_UNAVAILABLE", "sfizz install metadata").value;
    if (installed.engine !== SFIZZ_ENGINE_ID || installed.commit !== manifest.commit ||
        installed.binaryRelativePath !== manifest.binaryRelativePath ||
        typeof installed.binarySha256 !== "string" || installed.binarySha256 !== sha256File(binary)) {
      fail("ENGINE_UNVERIFIED", "설치된 sfizz_render가 고정 engine manifest와 다릅니다", {
        binary,
        expectedCommit: manifest.commit,
        installedCommit: installed.commit
      });
    }
  }

  const probe = spawnSync(binary, ["--help"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, maxBuffer: 1024 * 1024
  });
  if (probe.error || probe.status !== 0 ||
      !`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`.includes("Render a midi file through an SFZ file")) {
    fail("ENGINE_UNAVAILABLE", `sfizz_render 실행 검증에 실패했습니다: ${binary}`,
      { binary, status: probe.status, signal: probe.signal, stderr: String(probe.stderr ?? "").slice(0, 2000) }, probe.error);
  }
  const resolved = Object.freeze({ file: fs.realpathSync(binary), commit: manifest.commit, override: !!override, installed });
  verifiedBinaries.set(signature, resolved);
  return resolved;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function expandMacros(value, macros, context) {
  return value.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, name => {
    if (!macros.has(name))
      fail("CAPABILITY_UNSUPPORTED", `SFZ의 정의되지 않은 macro ${name}을 경로에서 해석할 수 없습니다`, { name, context });
    return macros.get(name);
  });
}

function cleanValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function tokenizeSfText(text, baseDir) {
  const matches = [];
  const token = /<\s*([A-Za-z_][\w-]*)\s*>|(?:^|\s)([A-Za-z_][\w-]*)\s*=/gm;
  let match;
  while ((match = token.exec(text))) {
    matches.push({
      type: match[1] ? "tag" : "opcode",
      name: (match[1] ?? match[2]).toLowerCase(),
      start: match.index,
      valueStart: token.lastIndex,
      baseDir
    });
  }
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].type !== "opcode") continue;
    matches[i].value = text.slice(matches[i].valueStart, matches[i + 1]?.start ?? text.length).trim();
  }
  return matches;
}

function noteNameToMidi(value) {
  if (/^\d{1,3}$/.test(value)) {
    const number = Number(value);
    return number >= 0 && number <= 127 ? number : null;
  }
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(value.trim());
  if (!match) return null;
  const pitch = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1].toUpperCase()]
    + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0);
  const midi = (Number(match[3]) + 1) * 12 + pitch;
  return midi >= 0 && midi <= 127 ? midi : null;
}

function opcodeInt(value, fallback, min, max) {
  if (value === undefined) return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function inspectSfz(resolved) {
  const macros = new Map();
  const includeStack = new Set();
  const includedFiles = new Set();
  const tokens = [];
  let totalBytes = 0;

  const visit = file => {
    const actual = fs.realpathSync(file);
    if (resolved.root) pathInside(resolved.root, actual, "SFZ include");
    if (includeStack.has(actual))
      fail("ASSET_CORRUPT", `SFZ include 순환을 발견했습니다: ${actual}`, { file: actual });
    if (includedFiles.size >= MAX_SFZ_INCLUDE_FILES)
      fail("CAPABILITY_UNSUPPORTED", `SFZ include 파일이 ${MAX_SFZ_INCLUDE_FILES}개를 넘습니다`, { file: actual });
    const stat = assertRegularFile(actual, "ASSET_MISSING", "SFZ/include 파일");
    totalBytes += stat.size;
    if (stat.size > MAX_SFZ_FILE_BYTES || totalBytes > MAX_SFZ_FILE_BYTES)
      fail("CAPABILITY_UNSUPPORTED", `SFZ 정의 크기가 ${MAX_SFZ_FILE_BYTES} byte 한도를 넘습니다`, { file: actual, totalBytes });
    let text;
    try { text = stripComments(fs.readFileSync(actual, "utf8")); }
    catch (error) {
      fail("ASSET_UNREADABLE", `SFZ 파일을 읽지 못했습니다: ${actual}`, { file: actual }, error);
    }
    if (text.includes("\0")) fail("ASSET_CORRUPT", `SFZ 파일에 NUL byte가 있습니다: ${actual}`, { file: actual });

    includeStack.add(actual);
    includedFiles.add(actual);
    const baseDir = path.dirname(actual);
    const lines = text.split(/\r?\n/);
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      const expanded = expandMacros(pending.join("\n"), macros, actual);
      tokens.push(...tokenizeSfText(expanded, baseDir));
      pending = [];
    };
    for (const line of lines) {
      const define = /^\s*#define\s+(\$[A-Za-z_][A-Za-z0-9_]*)\s+(.+?)\s*$/.exec(line);
      if (define) {
        flush();
        macros.set(define[1], cleanValue(expandMacros(define[2], macros, actual)));
        continue;
      }
      const include = /^\s*#include\s+(.+?)\s*$/.exec(line);
      if (include) {
        flush();
        const relative = cleanValue(expandMacros(include[1], macros, actual)).replaceAll("\\", "/");
        if (!relative || /[<>]/.test(relative))
          fail("CAPABILITY_UNSUPPORTED", `SFZ include 경로를 해석할 수 없습니다: ${include[1]}`, { file: actual });
        const includeFile = path.isAbsolute(relative) ? path.resolve(relative) : path.resolve(baseDir, relative);
        assertRegularFile(includeFile, "ASSET_MISSING", "SFZ include 파일");
        visit(includeFile);
        continue;
      }
      if (/^\s*#/.test(line))
        fail("CAPABILITY_UNSUPPORTED", `아직 지원하지 않는 SFZ preprocessor 지시자입니다: ${line.trim()}`, { file: actual });
      pending.push(line);
    }
    flush();
    includeStack.delete(actual);
  };

  visit(resolved.file);

  let scope = "none";
  let global = {}, master = {}, group = {}, region = null;
  let defaultRoot = path.dirname(resolved.file);
  let defaultKeyswitch = null;
  const regions = [];
  const samples = new Set();
  const finishRegion = () => {
    if (!region) return;
    const key = region.key !== undefined ? noteNameToMidi(region.key) : null;
    let lokey = key ?? noteNameToMidi(region.lokey ?? "0");
    let hikey = key ?? noteNameToMidi(region.hikey ?? "127");
    if (lokey === null || hikey === null)
      fail("ASSET_CORRUPT", "SFZ region의 key/lokey/hikey를 해석할 수 없습니다", { sfz: resolved.file, region });
    const lovel = opcodeInt(region.lovel, 0, 0, 127);
    const hivel = opcodeInt(region.hivel, 127, 0, 127);
    if (lokey > hikey || lovel > hivel)
      fail("ASSET_CORRUPT", "SFZ region의 key/velocity 범위가 거꾸로 되어 있습니다", { sfz: resolved.file, lokey, hikey, lovel, hivel });
    const controllers = new Set();
    for (const name of Object.keys(region)) {
      const match = /^(?:lo|hi)cc(\d{1,3})$/.exec(name);
      if (match && Number(match[1]) >= 0 && Number(match[1]) <= 127) controllers.add(Number(match[1]));
    }
    const ccRanges = [...controllers].sort((a, b) => a - b).map(controller => {
      const lo = opcodeInt(region[`locc${controller}`], 0, 0, 127);
      const hi = opcodeInt(region[`hicc${controller}`], 127, 0, 127);
      if (lo > hi)
        fail("ASSET_CORRUPT", `SFZ region의 CC${controller} 범위가 거꾸로 되어 있습니다`, {
          sfz: resolved.file, controller, lo, hi
        });
      return { controller, lo, hi };
    });
    const swLast = region.sw_last === undefined ? null : noteNameToMidi(region.sw_last);
    if (region.sw_last !== undefined && swLast === null)
      fail("ASSET_CORRUPT", "SFZ region의 sw_last keyswitch를 해석할 수 없습니다", {
        sfz: resolved.file, swLast: region.sw_last
      });
    regions.push({
      lokey, hikey, lovel, hivel, ccRanges,
      swLast,
      trigger: region.trigger ?? "attack", sample: region.__sample ?? null
    });
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
    const value = cleanValue(token.value);
    if (token.name === "sw_default") {
      const key = noteNameToMidi(value);
      if (key === null)
        fail("ASSET_CORRUPT", "SFZ sw_default keyswitch를 해석할 수 없습니다", {
          sfz: resolved.file, swDefault: value
        });
      if (defaultKeyswitch !== null && defaultKeyswitch !== key)
        fail("ASSET_CORRUPT", "SFZ에 서로 다른 sw_default keyswitch가 선언되어 있습니다", {
          sfz: resolved.file, previous: defaultKeyswitch, next: key
        });
      defaultKeyswitch = key;
    }
    if (token.name === "default_path") {
      const normalized = value.replaceAll("\\", "/");
      const candidate = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(token.baseDir, normalized);
      defaultRoot = resolved.root ? pathInside(resolved.root, candidate, "SFZ default_path") : candidate;
      continue;
    }
    let target = scope === "global" ? global : scope === "master" ? master
      : scope === "group" ? group : scope === "region" ? region : null;
    if (!target) continue;
    target[token.name] = value;
    if (token.name === "sample") {
      if (value.startsWith("*")) {
        target.__sample = { special: value };
        continue;
      }
      const normalized = value.replaceAll("\\", "/");
      const candidate = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(defaultRoot, normalized);
      if (resolved.root) pathInside(resolved.root, candidate, "SFZ sample");
      const sampleStat = assertRegularFile(candidate, "SAMPLE_MISSING", "SFZ sample");
      // 파일 이름만 있고 내용이 없는 공식 archive 결함도 "설치됨"이나 무음 성공으로
      // 취급하지 않는다. sfizz는 이런 입력을 종료 코드 0으로 넘길 수 있으므로 실행 전에 막는다.
      if (sampleStat.size === 0)
        fail("SAMPLE_CORRUPT", `SFZ sample이 비어 있습니다(0 byte): ${candidate}`, { file: candidate });
      const actual = fs.realpathSync(candidate);
      if (resolved.root) pathInside(resolved.root, actual, "SFZ sample real path");
      samples.add(actual);
      target.__sample = { file: actual };
    }
  }
  finishRegion();
  if (!regions.length)
    fail("ASSET_CORRUPT", `SFZ에 region이 하나도 없습니다: ${resolved.file}`, { sfz: resolved.file });
  return Object.freeze({
    regions: Object.freeze(regions),
    defaultKeyswitch,
    sampleFiles: Object.freeze([...samples]),
    includeFiles: Object.freeze([...includedFiles]),
    bytes: totalBytes
  });
}

export function sfzStatus(spec, options = {}) {
  try {
    const resolved = resolveSfzPath(spec, {
      ...options,
      // 큰 catalog 목록은 metadata identity와 정확한 파일 경로·크기까지만 확인한다.
      // 실제 선택/렌더에서는 기본값 true로 파일 checksum까지 다시 검증한다.
      verifyEntryChecksum: options.shallow !== true
    });
    // 목록·시작 화면은 pack installer가 기록한 identity와 entry size까지만 빠르게 확인한다.
    // 실제 선택/렌더 시에는 아래 full preflight가 include·sample·key/velocity까지 다시 검사한다.
    const index = options.shallow ? null : inspectSfz(resolved);
    return {
      engine: SFIZZ_ENGINE_ID,
      available: true,
      state: "installed",
      file: resolved.file,
      name: path.basename(resolved.file),
      pack: resolved.pack,
      regions: index?.regions.length ?? null,
      samples: index?.sampleFiles.length ?? null,
      reason: null
    };
  } catch (error) {
    if (!(error instanceof SfizzEngineError)) throw error;
    const states = {
      PACK_MISSING: "pack-missing",
      PACK_UNVERIFIED: "pack-unverified",
      PACK_ROOT_MISSING: "pack-root-missing",
      ASSET_MISSING: "missing",
      SAMPLE_MISSING: "sample-missing",
      SAMPLE_CORRUPT: "sample-corrupt",
      ASSET_UNREGISTERED: "unregistered",
      ASSET_PATH_ESCAPE: "unsafe",
      CAPABILITY_UNSUPPORTED: "unsupported"
    };
    return {
      engine: SFIZZ_ENGINE_ID,
      available: false,
      state: states[error.code] ?? "corrupt",
      file: error.details?.file ?? null,
      name: typeof spec?.sfz === "string" ? path.basename(spec.sfz) : null,
      pack: spec?.pack ?? null,
      reason: error.message,
      code: error.code
    };
  }
}

function normalizeArticulation(preset, track) {
  if (track === undefined || track === null) track = {};
  if (typeof track !== "object" || Array.isArray(track))
    fail("INVALID_RENDER_REQUEST", "track은 객체여야 합니다", { track });
  const unsupported = [];
  for (const name of ["attack", "release", "vibrato", "ensemble"])
    if (track[name] !== undefined && track[name] !== null &&
        !((name === "vibrato" && track[name] === 0) || (name === "ensemble" && track[name] === 1))) unsupported.push(name);
  if (track.cc !== undefined) unsupported.push("arbitrary-cc");
  if (unsupported.length)
    fail("CAPABILITY_UNSUPPORTED", `sfizz adapter가 ${unsupported.join(", ")} 제어를 조용히 무시하지 않았습니다`,
      { controls: unsupported });

  const id = track.articulation ?? preset?.defaultArticulation;
  if (id === undefined || id === null) return { id: null, label: null, keyswitch: null, cc: [] };
  const definitions = preset?.articulations;
  const raw = definitions instanceof Map ? definitions.get(id) : definitions?.[id];
  if (!raw)
    fail("ARTICULATION_MISSING", `SFZ preset에 articulation ${JSON.stringify(id)} 정의가 없습니다`, { articulation: id });
  if (typeof raw !== "object" || Array.isArray(raw))
    fail("ASSET_SPEC_INVALID", `articulation ${id}는 객체여야 합니다`, { articulation: raw });
  let keyswitch = null;
  if (raw.keyswitch !== undefined) {
    keyswitch = typeof raw.keyswitch === "number"
      ? { key: integer(raw.keyswitch, `articulations.${id}.keyswitch`, 0, 127), velocity: 127 }
      : {
          key: integer(raw.keyswitch?.key, `articulations.${id}.keyswitch.key`, 0, 127),
          velocity: integer(raw.keyswitch?.velocity ?? 127, `articulations.${id}.keyswitch.velocity`, 1, 127)
        };
  }
  if (raw.cc !== undefined && !Array.isArray(raw.cc))
    fail("ASSET_SPEC_INVALID", `articulations.${id}.cc는 배열여야 합니다`, { cc: raw.cc });
  const cc = (raw.cc ?? []).map((entry, index) => ({
    controller: integer(entry?.controller ?? entry?.cc, `articulations.${id}.cc[${index}].controller`, 0, 127),
    value: integer(entry?.value, `articulations.${id}.cc[${index}].value`, 0, 127)
  }));
  return { id, label: raw.label ?? id, keyswitch, cc };
}

function normalizeNoteControls(value, where) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    fail("INVALID_RENDER_REQUEST", `${where}.controls는 MIDI CC 배열이어야 합니다`, { controls: value });
  const seen = new Set();
  const controls = value.map((entry, index) => {
    const controller = integer(entry?.controller ?? entry?.cc, `${where}.controls[${index}].controller`, 0, 127);
    const controlValue = integer(entry?.value, `${where}.controls[${index}].value`, 0, 127);
    if (seen.has(controller))
      fail("INVALID_RENDER_REQUEST", `${where}.controls에 CC${controller}가 중복됩니다`, { controls: value });
    seen.add(controller);
    return { controller, value: controlValue };
  });
  return controls.sort((left, right) => left.controller - right.controller);
}

function normalizePerformanceNote(note, index, where = `notes[${index}]`) {
  if (!note || typeof note !== "object" || Array.isArray(note))
    fail("INVALID_RENDER_REQUEST", `${where}는 노트 객체여야 합니다`, { note });
  return {
    index,
    key: integer(note.key, `${where}.key`, 0, 127),
    velocity: integer(note.velocity, `${where}.velocity`, 1, 127),
    controls: normalizeNoteControls(note.controls, where)
  };
}

function normalizeNotes(notes, length) {
  if (!Array.isArray(notes)) fail("INVALID_RENDER_REQUEST", "notes는 배열여야 합니다", { notes });
  return notes.map((note, index) => {
    const where = `notes[${index}]`;
    const performance = normalizePerformanceNote(note, index, where);
    const startSample = integer(note.startSample, `${where}.startSample`, 0, Math.max(0, length - 1));
    const endSample = integer(note.endSample, `${where}.endSample`, 1, length);
    if (endSample <= startSample)
      fail("INVALID_RENDER_REQUEST", `${where}.endSample은 startSample보다 커야 합니다`, { startSample, endSample });
    return {
      ...performance,
      startSample,
      endSample,
      bend: finite(note.bend ?? 0, `${where}.bend`, -SFIZZ_PITCH_RANGE, SFIZZ_PITCH_RANGE),
      gain: finite(note.gain ?? 1, `${where}.gain`, 0, MAX_GAIN),
      channel: 0
    };
  }).sort((a, b) => a.startSample - b.startSample || a.endSample - b.endSample || a.index - b.index);
}

function ensureCoverage(index, notes, sfzPath, articulation) {
  const activeKeyswitch = articulation.keyswitch?.key ?? index.defaultKeyswitch;
  for (const note of notes) {
    const controllerValues = new Map(articulation.cc.map(control => [control.controller, control.value]));
    for (const control of note.controls) {
      if (controllerValues.has(control.controller) && controllerValues.get(control.controller) !== control.value)
        fail("CAPABILITY_UNSUPPORTED",
          `트랙 연주법과 피스가 CC${control.controller}에 서로 다른 값을 요구합니다`, {
            articulation: controllerValues.get(control.controller), piece: control.value, key: note.key
          });
      controllerValues.set(control.controller, control.value);
    }
    // 고정 sfizz f5c6e29는 sw_lokey/sw_hikey를 sw_last 선택 판정에 쓰지 않고,
    // region의 sw_last 값 자체를 sticky keyswitch slot로 등록한다. 범위 밖이라는
    // 이유로 여기서 거부하면 실제 renderer가 내는 소리를 preflight만 거짓 거부한다.
    const matches = index.regions.some(region =>
      !region.trigger.startsWith("release") && note.key >= region.lokey && note.key <= region.hikey &&
      note.velocity >= region.lovel && note.velocity <= region.hivel && region.sample !== null &&
      (region.swLast === null || region.swLast === activeKeyswitch) &&
      region.ccRanges.every(range => {
        const value = controllerValues.get(range.controller) ?? 0;
        return value >= range.lo && value <= range.hi;
      }));
    if (!matches)
      fail("SAMPLE_MISSING",
        `SFZ ${path.basename(sfzPath)}에 MIDI ${note.key}, velocity ${note.velocity}, 요청한 Keyswitch/CC 상태를 재생할 attack region/sample이 없습니다 — 무음으로 넘기지 않았습니다`,
        {
          reason: "attack-region-missing",
          sfz: sfzPath,
          noteIndex: note.index,
          key: note.key,
          velocity: note.velocity,
          keyswitch: activeKeyswitch,
          articulation: articulation.id,
          controls: note.controls
        });
  }
}

// 편집 시점의 호환성 검사. sfizz_render를 실행하거나 임시 MIDI/WAV를 만들지 않고,
// 실제 렌더와 같은 SFZ parser·Articulation/Keyswitch/CC·Velocity coverage 판정을 쓴다.
// layers: [{ articulation, notes:[{key, velocity, controls?}, ...] }, ...]
export function assertSfizzCoverage(spec, layers, options = {}) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || spec.engine !== SFIZZ_ENGINE_ID)
    fail("ASSET_SPEC_INVALID", "SFZ coverage 검사는 engine:'sfizz' preset 객체가 필요합니다", { spec });
  if (!Array.isArray(layers))
    fail("INVALID_RENDER_REQUEST", "SFZ coverage layers는 배열이어야 합니다", { layers });
  const resolved = resolveSfzPath(spec, options);
  const index = inspectSfz(resolved);
  let checkedNotes = 0;
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layer = layers[layerIndex];
    if (!layer || typeof layer !== "object" || Array.isArray(layer))
      fail("INVALID_RENDER_REQUEST", `layers[${layerIndex}]는 객체여야 합니다`, { layer });
    if (!Array.isArray(layer.notes))
      fail("INVALID_RENDER_REQUEST", `layers[${layerIndex}].notes는 배열이어야 합니다`, { notes: layer.notes });
    const articulation = normalizeArticulation(spec, { articulation: layer.articulation });
    const notes = layer.notes.map((note, noteIndex) =>
      normalizePerformanceNote(note, noteIndex, `layers[${layerIndex}].notes[${noteIndex}]`));
    try {
      ensureCoverage(index, notes, resolved.file, articulation);
    } catch (error) {
      if (error instanceof SfizzEngineError && error.details?.reason === "attack-region-missing")
        error.details = { ...error.details, layerIndex };
      throw error;
    }
    checkedNotes += notes.length;
  }
  return {
    engine: SFIZZ_ENGINE_ID,
    sfz: resolved.file,
    layers: layers.length,
    notes: checkedNotes
  };
}

function assignChannels(notes) {
  const planned = assignSfizzChannels(notes);
  if (planned.requiredChannels > MAX_SFIZZ_MIDI_CHANNELS)
    fail("CAPABILITY_UNSUPPORTED",
      `동시/개별 bend를 정확히 보존하려면 MIDI channel ${planned.requiredChannels}개가 필요하지만 sfizz CLI는 ${MAX_SFIZZ_MIDI_CHANNELS}개까지 사용합니다`,
      { requestedChannels: planned.requiredChannels, maximumChannels: MAX_SFIZZ_MIDI_CHANNELS });
  return {
    channelCount: planned.channelCount,
    channelControls: planned.channelControls
  };
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function midiTimebase(sampleRate) {
  const divisor = gcd(sampleRate, 1_000_000);
  const exactPpq = sampleRate / divisor;
  const exactTempo = 1_000_000 / divisor;
  if (exactPpq <= 0x7fff && exactTempo <= 0xffffff)
    return { ppq: exactPpq, tempo: exactTempo, sampleToTick: sample => sample };
  const ppq = 0x7fff;
  const tempo = Math.max(1, Math.min(0xffffff, Math.round(ppq * 1_000_000 / sampleRate)));
  const ticksPerSample = ppq * 1_000_000 / (sampleRate * tempo);
  return { ppq, tempo, sampleToTick: sample => Math.round(sample * ticksPerSample) };
}

function vlq(number) {
  if (!Number.isInteger(number) || number < 0 || number > 0x0fffffff)
    fail("CAPABILITY_UNSUPPORTED", "MIDI event 간격이 4-byte VLQ 범위를 넘습니다", { deltaTicks: number });
  const bytes = [number & 0x7f];
  while ((number >>= 7) > 0) bytes.unshift((number & 0x7f) | 0x80);
  return bytes;
}

function wheelValue(bend) {
  return Math.max(0, Math.min(16383, Math.round(8192 + bend / SFIZZ_PITCH_RANGE * 8192)));
}

function buildMidi(notes, length, sampleRate, articulation) {
  const { channelCount, channelControls } = assignChannels(notes);
  const time = midiTimebase(sampleRate);
  const events = [];
  let order = 0;
  const add = (sample, priority, bytes) => events.push({ tick: time.sampleToTick(sample), priority, order: order++, bytes });
  add(0, 0, [0xff, 0x51, 0x03, (time.tempo >> 16) & 0xff, (time.tempo >> 8) & 0xff, time.tempo & 0xff]);

  for (let channel = 0; channel < channelCount; channel++) {
    // RPN 0,0 pitch bend sensitivity = ±12 semitones, then RPN null.
    for (const [controller, value] of [[101, 0], [100, 0], [6, SFIZZ_PITCH_RANGE], [38, 0], [101, 127], [100, 127]])
      add(0, 10, [0xb0 | channel, controller, value]);
    const controls = new Map(articulation.cc.map(control => [control.controller, control.value]));
    for (const control of channelControls[channel] ?? []) {
      if (controls.has(control.controller) && controls.get(control.controller) !== control.value)
        fail("CAPABILITY_UNSUPPORTED", `channel ${channel}에서 CC${control.controller} 요구가 충돌합니다`, {
          articulation: controls.get(control.controller), piece: control.value
        });
      controls.set(control.controller, control.value);
    }
    for (const [controller, value] of [...controls].sort((a, b) => a[0] - b[0]))
      add(0, 20, [0xb0 | channel, controller, value]);
    if (articulation.keyswitch) {
      add(0, 30, [0x90 | channel, articulation.keyswitch.key, articulation.keyswitch.velocity]);
      add(0, 40, [0x80 | channel, articulation.keyswitch.key, 0]);
    }
  }

  let bendEventCount = 0;
  for (const note of notes) {
    add(note.startSample, 100, [0xe0 | note.channel, 0, 64]);
    add(note.startSample, 200, [0x90 | note.channel, note.key, note.velocity]);
    if (note.bend !== 0) {
      for (let sample = note.startSample + SFIZZ_BLOCK_SIZE; sample < note.endSample; sample += SFIZZ_BLOCK_SIZE) {
        const progress = (sample - note.startSample) / (note.endSample - note.startSample);
        const wheel = wheelValue(note.bend * progress);
        add(sample, 100, [0xe0 | note.channel, wheel & 0x7f, wheel >> 7]);
        bendEventCount++;
      }
      const endpoint = wheelValue(note.bend);
      add(note.endSample, 100, [0xe0 | note.channel, endpoint & 0x7f, endpoint >> 7]);
      bendEventCount++;
    }
    add(note.endSample, 200, [0x80 | note.channel, note.key, 0]);
  }
  // sfizz_render --use-eot ignores an otherwise empty EOT timestamp and stops at the last
  // actual MIDI event. A harmless sequencer-specific meta event pins the requested endpoint.
  add(length, 300, [0xff, 0x7f, 0x00]);
  events.sort((a, b) => a.tick - b.tick || a.priority - b.priority || a.order - b.order);

  const body = [];
  let lastTick = 0;
  for (const event of events) {
    body.push(...vlq(event.tick - lastTick), ...event.bytes);
    lastTick = event.tick;
  }
  body.push(...vlq(0), 0xff, 0x2f, 0x00);
  const track = Buffer.alloc(8 + body.length);
  track.write("MTrk", 0);
  track.writeUInt32BE(body.length, 4);
  Buffer.from(body).copy(track, 8);
  const header = Buffer.alloc(14);
  header.write("MThd", 0);
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt16BE(time.ppq, 12);
  return { buffer: Buffer.concat([header, track]), channelCount, bendEventCount, timebase: time };
}

function parseStereoWav(buffer, expectedSampleRate, file) {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE")
    fail("PCM_INVALID", `sfizz_render 출력이 RIFF/WAVE가 아닙니다: ${file}`, { file });
  let format = null, data = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size;
    if (end > buffer.length)
      fail("PCM_INVALID", `WAV ${id} chunk가 파일 크기를 넘습니다`, { file, id, size });
    if (id === "fmt ") {
      if (size < 16) fail("PCM_INVALID", "WAV fmt chunk가 너무 짧습니다", { file, size });
      let encoding = buffer.readUInt16LE(start);
      if (encoding === 0xfffe && size >= 40) encoding = buffer.readUInt16LE(start + 24);
      format = {
        encoding,
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        blockAlign: buffer.readUInt16LE(start + 12),
        bits: buffer.readUInt16LE(start + 14)
      };
    } else if (id === "data" && data === null) data = { start, size };
    offset = end + (size & 1);
  }
  if (!format || !data) fail("PCM_INVALID", "sfizz_render WAV에 fmt/data chunk가 없습니다", { file });
  if (format.channels !== 2 || format.sampleRate !== expectedSampleRate)
    fail("PCM_INVALID", "sfizz_render WAV의 channel/sample rate가 요청과 다릅니다",
      { file, expectedSampleRate, ...format });
  const bytesPerSample = format.bits / 8;
  if (![2, 3, 4, 8].includes(bytesPerSample) || format.blockAlign !== bytesPerSample * 2 || data.size % format.blockAlign !== 0)
    fail("PCM_INVALID", "sfizz_render WAV의 sample 크기/block alignment를 지원할 수 없습니다", { file, ...format });
  if (!((format.encoding === 1 && [16, 24, 32].includes(format.bits)) ||
        (format.encoding === 3 && [32, 64].includes(format.bits))))
    fail("CAPABILITY_UNSUPPORTED", "sfizz_render WAV encoding을 지원하지 않습니다", { file, ...format });

  const frames = data.size / format.blockAlign;
  const left = new Float32Array(frames), right = new Float32Array(frames);
  const read = offset => {
    if (format.encoding === 3) return format.bits === 32 ? buffer.readFloatLE(offset) : buffer.readDoubleLE(offset);
    if (format.bits === 16) return buffer.readInt16LE(offset) / 32768;
    if (format.bits === 24) return buffer.readIntLE(offset, 3) / 8388608;
    return buffer.readInt32LE(offset) / 2147483648;
  };
  for (let frame = 0; frame < frames; frame++) {
    const offset = data.start + frame * format.blockAlign;
    left[frame] = read(offset);
    right[frame] = read(offset + bytesPerSample);
  }
  return { left, right, format };
}

function exactLength(channel, length) {
  if (channel.length === length) return channel;
  const exact = new Float32Array(length);
  exact.set(channel.subarray(0, Math.min(length, channel.length)));
  return exact;
}

function validatePcm(left, right, notes, details) {
  let peak = 0, nonzero = 0, stereoDifference = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i], r = right[i];
    if (!Number.isFinite(l) || !Number.isFinite(r))
      fail("PCM_INVALID", `sfizz_render가 유효하지 않은 PCM을 만들었습니다 (sample ${i})`,
        { ...details, sample: i, left: l, right: r });
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    if (Math.abs(l) > 1 / 32768 || Math.abs(r) > 1 / 32768) nonzero++;
    stereoDifference += Math.abs(l - r);
  }
  // Missing sample/unmapped key일 때 CLI가 -1 LSB로 채운 WAV를 exit 0으로 내보낸다.
  if (notes.length && nonzero === 0)
    fail("PCM_SILENT", "노트가 있지만 sfizz 출력이 실질적인 무음입니다 — 성공으로 처리하지 않았습니다", details);
  return { peak, nonzeroSamples: nonzero, stereoMeanDifference: left.length ? stereoDifference / left.length : 0 };
}

/**
 * One SFZ file owns one temporary sidecar session.
 *
 * preset metadata may contain:
 *   { engine:'sfizz', articulations:{id:{label,keyswitch?,cc?}}, defaultArticulation? }
 * renderTrack accepts notes `{startSample,endSample,key,velocity,bend?,gain?}`. Per-note
 * gain is exact only when every note has the same value; differing values fail explicitly.
 */
export function openSfizzSession(sfzPath, sampleRate = 44100, options = {}) {
  finite(sampleRate, "sampleRate", 8000, 192000);
  if (!options || typeof options !== "object" || Array.isArray(options))
    fail("INVALID_RENDER_REQUEST", "sfizz session options은 객체여야 합니다", { options });
  const spec = options.preset ?? { engine: SFIZZ_ENGINE_ID, sfz: sfzPath };
  // pack spec이 있으면 호출자가 함께 건넨 절대 sfzPath를 신뢰해 검증을 우회하지 않고,
  // manifest/install metadata에서 경로를 다시 결정한다.
  const resolutionSpec = spec.pack !== undefined || !path.isAbsolute(sfzPath)
    ? spec
    : { ...spec, engine: SFIZZ_ENGINE_ID, pack: undefined, sfz: sfzPath };
  const resolved = resolveSfzPath(resolutionSpec, options);
  let requestedReal;
  try { requestedReal = fs.realpathSync(path.resolve(sfzPath)); }
  catch { requestedReal = path.resolve(sfzPath); }
  if (path.resolve(resolved.file) !== requestedReal)
    fail("ASSET_SPEC_INVALID", "resolved SFZ 경로와 session 경로가 다릅니다", { sfzPath, resolved: resolved.file });
  const binary = resolveSfizzBinary();
  const index = inspectSfz(resolved);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aria-sfizz-render-"));
  let closed = false, rendering = false, sequence = 0;

  const session = {
    engine: Object.freeze({
      id: SFIZZ_ENGINE_ID,
      commit: binary.commit,
      binary: binary.file,
      blockSize: SFIZZ_BLOCK_SIZE,
      regions: index.regions.length,
      samples: index.sampleFiles.length
    }),
    sfzPath: resolved.file,
    sampleRate,
    temporaryDirectory,

    renderTrack({ preset = spec, track = {}, notes, length } = {}) {
      if (closed) fail("SESSION_CLOSED", "이미 닫힌 sfizz session입니다", { sfz: resolved.file });
      if (rendering) fail("RENDER_BUSY", "같은 sfizz session에서 동시에 두 번 렌더할 수 없습니다", { sfz: resolved.file });
      integer(length, "length", 1, 0x7fffffff);
      const articulation = normalizeArticulation(preset, track);
      const planned = normalizeNotes(notes, length);
      ensureCoverage(index, planned, resolved.file, articulation);
      const gains = new Set(planned.map(note => note.gain));
      if (gains.size > 1)
        fail("CAPABILITY_UNSUPPORTED",
          "sfizz CLI sidecar는 한 트랙 안의 서로 다른 per-note gain을 RR/레이어를 깨지 않고 보존하지 못합니다",
          { capability: "varying-per-note-gain", gains: [...gains] });
      const gain = planned[0]?.gain ?? 1;
      if (!planned.length) {
        return {
          left: new Float32Array(length), right: new Float32Array(length),
          diagnostics: {
            engine: SFIZZ_ENGINE_ID, sfz: path.basename(resolved.file), notes: 0,
            articulation: articulation.id, invocations: 0, sourceFrames: 0, trimmedFrames: 0,
            peak: 0, nonzeroSamples: 0, stereoMeanDifference: 0
          }
        };
      }

      const midi = buildMidi(planned, length, sampleRate, articulation);
      const id = `${process.pid}-${sequence++}`;
      const midiFile = path.join(temporaryDirectory, `${id}.mid`);
      const wavFile = path.join(temporaryDirectory, `${id}.wav`);
      rendering = true;
      try {
        fs.writeFileSync(midiFile, midi.buffer, { mode: 0o600, flag: "wx" });
        const duration = length / sampleRate;
        const timeout = Math.max(30_000, Math.min(15 * 60_000, Math.ceil(duration * 20_000)));
        const child = spawnSync(binary.file, [
          "--sfz", resolved.file,
          "--midi", midiFile,
          "--wav", wavFile,
          "--samplerate", String(sampleRate),
          "--blocksize", String(SFIZZ_BLOCK_SIZE),
          "--use-eot"
        ], {
          cwd: path.dirname(resolved.file),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout,
          maxBuffer: 16 * 1024 * 1024
        });
        if (child.error || child.status !== 0 || !fs.existsSync(wavFile)) {
          fail(child.error?.code === "ETIMEDOUT" ? "RENDER_TIMEOUT" : "RENDER_FAILED",
            `sfizz_render가 SFZ 렌더에 실패했습니다: ${path.basename(resolved.file)}`, {
              sfz: resolved.file,
              status: child.status,
              signal: child.signal,
              stdout: String(child.stdout ?? "").slice(-4000),
              stderr: String(child.stderr ?? "").slice(-4000)
            }, child.error);
        }
        const parsed = parseStereoWav(fs.readFileSync(wavFile), sampleRate, wavFile);
        const left = exactLength(parsed.left, length), right = exactLength(parsed.right, length);
        if (gain !== 1) {
          for (let i = 0; i < length; i++) { left[i] *= gain; right[i] *= gain; }
        }
        const pcm = validatePcm(left, right, planned, {
          sfz: resolved.file,
          notes: planned.length,
          sourceFrames: parsed.left.length,
          requestedFrames: length
        });
        return {
          left, right,
          diagnostics: {
            engine: SFIZZ_ENGINE_ID,
            sfz: path.basename(resolved.file),
            pack: resolved.pack,
            notes: planned.length,
            articulation: articulation.id,
            invocations: 1,
            channels: midi.channelCount,
            bendNotes: planned.filter(note => note.bend !== 0).length,
            controlledNotes: planned.filter(note => note.controls.length).length,
            bendEvents: midi.bendEventCount,
            pitchRangeSemitones: SFIZZ_PITCH_RANGE,
            sourceFrames: parsed.left.length,
            trimmedFrames: Math.max(0, parsed.left.length - length),
            paddedFrames: Math.max(0, length - parsed.left.length),
            sourceEncoding: `${parsed.format.encoding === 1 ? "pcm" : "float"}${parsed.format.bits}`,
            gain,
            ...pcm
          }
        };
      } finally {
        rendering = false;
        for (const file of [midiFile, wavFile]) {
          try { fs.rmSync(file, { force: true }); } catch { /* session.close retries directory cleanup */ }
        }
      }
    },

    close() {
      if (closed) return;
      if (rendering) fail("RENDER_BUSY", "렌더 중인 sfizz session을 닫을 수 없습니다", { sfz: resolved.file });
      closed = true;
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  };
  return session;
}

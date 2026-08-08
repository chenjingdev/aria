#!/usr/bin/env node
// Install an SFZ pack generated from a pinned official archive.
//
// A preparation script is allowed to transform an archive into a portable pack, but
// its output is never trusted on sight. This installer verifies the generated
// pack.json, the complete checksum inventory, every payload file, and the pinned
// repository manifest before publishing the directory atomically.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const METADATA_NAME = ".aria-pack.json";
const PREPARED_MANIFEST_NAME = "pack.json";
const HASH_ALGORITHM = "sha256";

export class PreparedPackInstallError extends Error {
  constructor(code, message, details = undefined, cause = undefined) {
    super(message, cause ? { cause } : undefined);
    this.name = "PreparedPackInstallError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details, cause) {
  throw new PreparedPackInstallError(code, message, details, cause);
}

function usage() {
  console.log(`Usage:
  node tools/install-prepared-pack.mjs <pack-id|manifest.json>
  node tools/install-prepared-pack.mjs <pack-id|manifest.json> --archive <official-archive>
  node tools/install-prepared-pack.mjs <pack-id|manifest.json> --adopt <prepared-directory>
  node tools/install-prepared-pack.mjs <pack-id|manifest.json> --verify-source <prepared-directory>

Environment:
  ARIA_PACKS_DIR  Preferred sample-pack root override
  ARIA_PACK_HOME  Backward-compatible sample-pack root override`);
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    return { exit: argv.length === 0 ? 1 : 0 };
  }
  const manifestRef = argv[0];
  let mode = "install";
  let sourcePath;
  let archivePath;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--adopt" || argument === "--verify-source") {
      if (mode !== "install") fail("ARGUMENT_ERROR", "--adopt and --verify-source are mutually exclusive");
      mode = argument === "--adopt" ? "adopt" : "verify";
      sourcePath = argv[++index];
      if (!sourcePath || sourcePath.startsWith("--"))
        fail("ARGUMENT_ERROR", `${argument} requires a prepared directory`);
    } else if (argument === "--archive") {
      archivePath = argv[++index];
      if (!archivePath || archivePath.startsWith("--"))
        fail("ARGUMENT_ERROR", "--archive requires a file path");
    } else {
      fail("ARGUMENT_ERROR", `unknown argument: ${argument}`);
    }
  }
  if (mode !== "install" && archivePath)
    fail("ARGUMENT_ERROR", "--archive is only valid for preparation/install mode");
  return { manifestRef, mode, sourcePath, archivePath };
}

function manifestPathFor(reference) {
  if (reference.endsWith(".json") || reference.includes("/") || reference.includes("\\"))
    return path.resolve(reference);
  return path.join(ROOT, "packs", `${reference}.json`);
}

function sha256Buffer(buffer) {
  return crypto.createHash(HASH_ALGORITHM).update(buffer).digest("hex");
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(HASH_ALGORITHM);
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function assertSha256(label, value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    fail("MANIFEST_INVALID", `${label} must be a lowercase SHA-256 hash`);
}

function assertPositiveInteger(label, value) {
  if (!Number.isSafeInteger(value) || value < 1)
    fail("MANIFEST_INVALID", `${label} must be a positive integer`);
}

function assertNonNegativeInteger(label, value) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail("MANIFEST_INVALID", `${label} must be a non-negative integer`);
}

function assertPositiveNumber(label, value) {
  if (!Number.isFinite(value) || value <= 0)
    fail("MANIFEST_INVALID", `${label} must be a positive finite number`);
}

function assertNonNegativeNumber(label, value) {
  if (!Number.isFinite(value) || value < 0)
    fail("MANIFEST_INVALID", `${label} must be a non-negative finite number`);
}

function safeRelativePath(label, value, { singleSegment = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\") ||
      path.posix.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value))
    fail("MANIFEST_INVALID", `${label} must be a non-empty POSIX relative path`);
  const parts = value.split("/");
  if (parts.includes("") || parts.includes(".") || parts.includes("..") ||
      (singleSegment && parts.length !== 1))
    fail("MANIFEST_INVALID", `${label} contains an unsafe path: ${value}`);
  return value;
}

function safeUrl(label, value, { download = false } = {}) {
  let parsed;
  try { parsed = new URL(value); }
  catch { fail("MANIFEST_INVALID", `${label} must be an absolute URL`); }
  if (parsed.username || parsed.password)
    fail("MANIFEST_INVALID", `${label} must not contain credentials`);
  const loopbackHttp = parsed.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && (!download || !loopbackHttp))
    fail("MANIFEST_INVALID", `${label} must use HTTPS${download ? " (loopback HTTP is test-only)" : ""}`);
  return parsed.toString();
}

function expandHome(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    fail("MANIFEST_INVALID", "source.defaultArchive must be a non-empty path");
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (value.startsWith("~"))
    fail("MANIFEST_INVALID", "source.defaultArchive only supports the ~/ home abbreviation");
  if (!path.isAbsolute(value))
    fail("MANIFEST_INVALID", "source.defaultArchive must be absolute or start with ~/");
  return path.resolve(value);
}

function readJsonWithRaw(file, code, label) {
  let raw;
  try { raw = fs.readFileSync(file); }
  catch (error) { fail(code, `cannot read ${label}: ${file}`, { file, causeCode: error.code }, error); }
  let value;
  try { value = JSON.parse(raw.toString("utf8")); }
  catch (error) { fail(code, `${label} is not valid JSON: ${file}`, { file }, error); }
  return { value, raw };
}

function validateCatalog(catalog, entries) {
  if (catalog === undefined) return;
  if (!Array.isArray(catalog) || catalog.length !== entries.length)
    fail("MANIFEST_INVALID", "catalog must contain one item per content.entryFiles item");
  const ids = new Set();
  const paths = new Set();
  for (const [index, item] of catalog.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(item.id) || ids.has(item.id))
      fail("MANIFEST_INVALID", `catalog[${index}].id must be a unique stable slug`);
    safeRelativePath(`catalog[${index}].path`, item.path);
    if (!entries.includes(item.path) || paths.has(item.path))
      fail("MANIFEST_INVALID", `catalog[${index}].path must uniquely match content.entryFiles`);
    if (typeof item.name !== "string" || typeof item.family !== "string" ||
        typeof item.articulation !== "string" || typeof item.label !== "string" ||
        typeof item.source !== "string" || typeof item.drum !== "boolean")
      fail("MANIFEST_INVALID", `catalog[${index}] is missing display metadata`);
    if (!item.gm || !Number.isInteger(item.gm.bank) || !Number.isInteger(item.gm.program) ||
        item.gm.bank < 0 || item.gm.bank > 16383 || item.gm.program < 0 || item.gm.program > 127)
      fail("MANIFEST_INVALID", `catalog[${index}].gm must contain zero-based bank/program numbers`);

    assertNonNegativeNumber(`catalog[${index}].release`, item.release);
    if (item.maxSampleDurationSec !== undefined)
      assertPositiveNumber(`catalog[${index}].maxSampleDurationSec`, item.maxSampleDurationSec);
    if (item.durationSec !== undefined)
      assertPositiveNumber(`catalog[${index}].durationSec`, item.durationSec);
    if (item.tailHintSec !== undefined)
      assertNonNegativeNumber(`catalog[${index}].tailHintSec`, item.tailHintSec);

    if (!item.drum && item.durationSec !== undefined)
      fail("MANIFEST_INVALID", `catalog[${index}].durationSec is only valid for recorded or one-shot drum entries`);
    if (item.kind === "clip") {
      if (!item.drum)
        fail("MANIFEST_INVALID", `catalog[${index}] kind=clip requires a drum entry`);
      assertPositiveNumber(`catalog[${index}].durationSec`, item.durationSec);
      assertNonNegativeNumber(`catalog[${index}].tailHintSec`, item.tailHintSec);
    }
    if (item.drum) {
      if (!Array.isArray(item.pieces) || item.pieces.length === 0)
        fail("MANIFEST_INVALID", `catalog[${index}].pieces must be a non-empty array for a drum entry`);
      assertNonNegativeNumber(`catalog[${index}].tailHintSec`, item.tailHintSec);
      const pieceIds = new Set();
      const pieceTriggers = new Set();
      for (const [pieceIndex, piece] of item.pieces.entries()) {
        if (!piece || typeof piece.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(piece.id) ||
            pieceIds.has(piece.id))
          fail("MANIFEST_INVALID", `catalog[${index}].pieces[${pieceIndex}].id must be a unique stable slug`);
        if (!Number.isInteger(piece.key) || piece.key < 0 || piece.key > 127)
          fail("MANIFEST_INVALID", `catalog[${index}].pieces[${pieceIndex}].key must be a MIDI key`);
        assertPositiveNumber(`catalog[${index}].pieces[${pieceIndex}].durationSec`, piece.durationSec);
        const controls = piece.cc ?? [];
        if (!Array.isArray(controls))
          fail("MANIFEST_INVALID", `catalog[${index}].pieces[${pieceIndex}].cc must be an array`);
        const controllers = new Set();
        for (const [controlIndex, control] of controls.entries()) {
          if (!Number.isInteger(control?.controller) || control.controller < 0 || control.controller > 127 ||
              !Number.isInteger(control?.value) || control.value < 0 || control.value > 127 ||
              controllers.has(control.controller))
            fail("MANIFEST_INVALID", `catalog[${index}].pieces[${pieceIndex}].cc[${controlIndex}] is invalid or duplicated`);
          controllers.add(control.controller);
        }
        const trigger = `${piece.key}|${controls.slice().sort((a, b) => a.controller - b.controller)
          .map(control => `${control.controller}:${control.value}`).join(",")}`;
        if (pieceTriggers.has(trigger))
          fail("MANIFEST_INVALID", `catalog[${index}].pieces[${pieceIndex}] duplicates a key+CC trigger`);
        if (typeof piece.name !== "string" || typeof piece.label !== "string" ||
            typeof piece.sampleStem !== "string" || piece.sampleStem.length === 0)
          fail("MANIFEST_INVALID", `catalog[${index}].pieces[${pieceIndex}] is missing display or sample metadata`);
        pieceIds.add(piece.id);
        pieceTriggers.add(trigger);
      }
      if (item.kind === "clip") {
        if (item.pieces.length !== 1)
          fail("MANIFEST_INVALID", `catalog[${index}] kind=clip must contain exactly one play piece`);
        if (item.pieces[0].durationSec !== item.durationSec)
          fail("MANIFEST_INVALID", `catalog[${index}] clip piece durationSec must equal the recorded durationSec`);
      }
    } else if (item.pieces !== undefined) {
      fail("MANIFEST_INVALID", `catalog[${index}].pieces requires a drum entry`);
    }
    ids.add(item.id);
    paths.add(item.path);
  }
}

export function loadPreparedManifest(file) {
  const { value: manifest, raw } = readJsonWithRaw(file, "MANIFEST_INVALID", "pack manifest");
  if (manifest.schemaVersion !== 1) fail("MANIFEST_INVALID", "unsupported pack manifest schemaVersion");
  if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id))
    fail("MANIFEST_INVALID", "pack id must use lowercase letters, numbers, dots, underscores, or hyphens");
  if (typeof manifest.name !== "string" || manifest.name.length === 0)
    fail("MANIFEST_INVALID", "pack name must be a non-empty string");
  if (manifest.format !== "sfz") fail("MANIFEST_INVALID", "prepared pack installer requires format=sfz");
  safeRelativePath("installDir", manifest.installDir, { singleSegment: true });

  const source = manifest.source;
  if (!source || source.type !== "prepared-archive")
    fail("MANIFEST_INVALID", "source.type must be prepared-archive");
  safeUrl("source.repositoryUrl", source.repositoryUrl);
  if (source.projectUrl !== undefined) safeUrl("source.projectUrl", source.projectUrl);
  if (source.releaseUrl !== undefined) safeUrl("source.releaseUrl", source.releaseUrl);
  if (source.branch !== null)
    fail("MANIFEST_INVALID", "prepared-archive source.branch must be null");
  assertSha256("source.commit", source.commit);
  assertSha256("source.tree", source.tree);
  assertSha256("source.archiveSha256", source.archiveSha256);
  if (source.commit !== source.archiveSha256)
    fail("MANIFEST_INVALID", "source.commit must equal source.archiveSha256 for strict runtime identity");
  safeRelativePath("source.prepareScript", source.prepareScript);
  const prepareScript = path.resolve(ROOT, ...source.prepareScript.split("/"));
  const relativeScript = path.relative(ROOT, prepareScript);
  if (relativeScript.startsWith(`..${path.sep}`) || relativeScript === ".." || path.isAbsolute(relativeScript))
    fail("MANIFEST_INVALID", "source.prepareScript escapes the Aria repository");
  const prepareArgs = source.prepareArgs ?? [];
  if (!Array.isArray(prepareArgs) || prepareArgs.some(argument => typeof argument !== "string" || argument.includes("\0")))
    fail("MANIFEST_INVALID", "source.prepareArgs must be an array of strings");
  if (prepareArgs.some(argument => argument === "--archive" || argument === "--output"))
    fail("MANIFEST_INVALID", "source.prepareArgs must not override --archive or --output");
  const defaultArchive = expandHome(source.defaultArchive);
  const downloadUrl = source.downloadUrl === undefined ? null : safeUrl("source.downloadUrl", source.downloadUrl, { download: true });

  const license = manifest.license;
  if (!license || typeof license.spdx !== "string" || license.spdx.length === 0 ||
      typeof license.url !== "string" || license.url.length === 0)
    fail("MANIFEST_INVALID", "license must provide spdx and url");
  safeUrl("license.url", license.url);
  safeRelativePath("license.file", license.file);
  assertSha256("license.sha256", license.sha256);

  const content = manifest.content;
  if (!content || !Array.isArray(content.entryFiles) || content.entryFiles.length === 0)
    fail("MANIFEST_INVALID", "content.entryFiles must be a non-empty array");
  safeRelativePath("content.checksumsFile", content.checksumsFile);
  if (content.checksumsFile === PREPARED_MANIFEST_NAME || content.checksumsFile === METADATA_NAME)
    fail("MANIFEST_INVALID", "content.checksumsFile conflicts with a reserved metadata file");
  const entries = content.entryFiles.map((entry, index) => {
    safeRelativePath(`content.entryFiles[${index}]`, entry);
    if (path.posix.extname(entry).toLowerCase() !== ".sfz")
      fail("MANIFEST_INVALID", `content.entryFiles[${index}] is not SFZ: ${entry}`);
    return entry;
  });
  if (new Set(entries).size !== entries.length)
    fail("MANIFEST_INVALID", "content.entryFiles contains duplicates");
  if (!Array.isArray(content.audioExtensions) || content.audioExtensions.length === 0)
    fail("MANIFEST_INVALID", "content.audioExtensions must be a non-empty array");
  const audioExtensions = content.audioExtensions.map((extension, index) => {
    if (typeof extension !== "string" || !/^\.[a-z0-9]+$/.test(extension))
      fail("MANIFEST_INVALID", `content.audioExtensions[${index}] is invalid`);
    return extension;
  });
  if (new Set(audioExtensions).size !== audioExtensions.length)
    fail("MANIFEST_INVALID", "content.audioExtensions contains duplicates");
  assertPositiveInteger("content.expectedPayloadFiles", content.expectedPayloadFiles);
  assertNonNegativeInteger("content.expectedAudioFiles", content.expectedAudioFiles);
  validateCatalog(manifest.catalog, entries);

  return {
    file: path.resolve(file),
    raw,
    sha256: sha256Buffer(raw),
    manifest,
    entries,
    audioExtensions: new Set(audioExtensions),
    prepareScript,
    prepareArgs,
    defaultArchive,
    downloadUrl
  };
}

function atomicWriteJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function createStatusReporter(statusFile, packId, target) {
  const startedAt = new Date().toISOString();
  return (state, message, details = {}) => {
    const status = {
      schemaVersion: 1,
      packId,
      state,
      message,
      target,
      startedAt,
      updatedAt: new Date().toISOString(),
      ...details
    };
    atomicWriteJson(statusFile, status);
    if (details.quiet !== true) console.log(`[${packId}] ${message}`);
    return status;
  };
}

function bytewiseSort(values) {
  return values.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toPosix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function assertDirectoryRoot(root) {
  let stat;
  try { stat = fs.lstatSync(root); }
  catch (error) { fail("PREPARED_SOURCE_MISSING", `prepared pack directory is missing: ${root}`, { root }, error); }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("PACK_SYMLINK", `prepared pack root must be a real directory, not a symlink: ${root}`);
}

function listFilesNoLinks(root) {
  assertDirectoryRoot(root);
  const records = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail("PACK_SYMLINK", `symbolic links are forbidden in prepared packs: ${relative}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) records.push({ path: relative, size: stat.size, absolute });
      else fail("PACK_SPECIAL_FILE", `unsupported filesystem entry in prepared pack: ${relative}`);
    }
  }
  visit(root);
  // 디렉터리별 DFS 순서는 `sfz/foo`와 `sfz-clips/foo` 같은 형제 경로에서
  // 전체 경로의 바이트 정렬과 다를 수 있다. 체크섬 inventory와 publication
  // snapshot은 모두 전체 상대경로 기준으로 비교하므로 여기서 한 번 정규화한다.
  return records.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

function checksumInventoryDigest(files) {
  const digest = crypto.createHash(HASH_ALGORITHM);
  for (const file of files)
    digest.update(file.path).update("\0").update(String(file.size)).update("\0").update(file.sha256).update("\n");
  return digest.digest("hex");
}

async function hashRecords(records, report, phase) {
  const files = [];
  const totalBytes = records.reduce((sum, record) => sum + record.size, 0);
  let completedBytes = 0;
  let lastReport = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const sha256 = await sha256File(record.absolute);
    files.push({ path: record.path, size: record.size, sha256 });
    completedBytes += record.size;
    const now = Date.now();
    if (report && (index === records.length - 1 || now - lastReport >= 500)) {
      report(phase, `파일 무결성 확인 ${index + 1}/${records.length}`, {
        quiet: true,
        progress: { unit: "files", current: index + 1, total: records.length, completedBytes, totalBytes }
      });
      lastReport = now;
    }
  }
  return { files, totalBytes, sha256: checksumInventoryDigest(files) };
}

function validatePreparedPackManifest(pack, config) {
  const manifest = config.manifest;
  if (pack?.format !== 1 || pack.id !== manifest.id || pack.name !== manifest.name)
    fail("PREPARED_IDENTITY_MISMATCH", "prepared pack.json format/id/name does not match the repository manifest");
  if (pack.source?.url !== manifest.source.repositoryUrl ||
      pack.source?.sha256 !== manifest.source.archiveSha256)
    fail("PREPARED_SOURCE_MISMATCH", "prepared pack.json source URL/archive checksum does not match the pinned source");
  if (typeof pack.source?.archive !== "string" || pack.source.archive.length === 0 ||
      path.basename(pack.source.archive) !== pack.source.archive)
    fail("PREPARED_SOURCE_MISMATCH", "prepared pack.json source.archive must be a plain archive filename");
  if (pack.checksums?.file !== manifest.content.checksumsFile ||
      pack.checksums?.sha256 !== manifest.source.tree)
    fail("PREPARED_TREE_MISMATCH", "prepared pack.json checksum identity does not match the repository manifest");
}

function parseChecksumInventory(value, config) {
  if (!Array.isArray(value) || value.length === 0)
    fail("CHECKSUM_INVENTORY_INVALID", "catalog/checksums.json must be a non-empty array");
  const files = [];
  const paths = new Set();
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      fail("CHECKSUM_INVENTORY_INVALID", `checksum record ${index} must be an object`);
    safeRelativePath(`checksums[${index}].file`, item.file);
    if (item.file === PREPARED_MANIFEST_NAME || item.file === config.manifest.content.checksumsFile ||
        item.file === METADATA_NAME)
      fail("CHECKSUM_INVENTORY_INVALID", `checksum record ${index} names a reserved metadata file`);
    if (paths.has(item.file))
      fail("CHECKSUM_INVENTORY_INVALID", `duplicate checksum path: ${item.file}`);
    assertNonNegativeInteger(`checksums[${index}].bytes`, item.bytes);
    assertSha256(`checksums[${index}].sha256`, item.sha256);
    paths.add(item.file);
    files.push({ path: item.file, size: item.bytes, sha256: item.sha256 });
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (files.length !== config.manifest.content.expectedPayloadFiles)
    fail("PACK_COUNT_MISMATCH",
      `expected ${config.manifest.content.expectedPayloadFiles} payload files, found ${files.length}`);
  return files;
}

export async function verifyPreparedPack(root, config, { allowMetadata = false, report = null, phase = "verifying-source" } = {}) {
  root = path.resolve(root);
  const allRecords = listFilesNoLinks(root);
  const allByPath = new Map(allRecords.map(record => [record.path, record]));
  const metadataRecord = allByPath.get(METADATA_NAME);
  if (!allowMetadata && metadataRecord)
    fail("PREPARED_METADATA_PRESENT", `${METADATA_NAME} must not be supplied by a preparation script`);
  if (allowMetadata && (!metadataRecord || !fs.lstatSync(metadataRecord.absolute).isFile()))
    fail("PACK_METADATA_MISSING", `managed pack metadata is missing: ${METADATA_NAME}`);

  const packRecord = allByPath.get(PREPARED_MANIFEST_NAME);
  const checksumRecord = allByPath.get(config.manifest.content.checksumsFile);
  if (!packRecord) fail("PREPARED_MANIFEST_MISSING", `prepared pack is missing ${PREPARED_MANIFEST_NAME}`);
  if (!checksumRecord)
    fail("CHECKSUM_INVENTORY_MISSING", `prepared pack is missing ${config.manifest.content.checksumsFile}`);

  const { value: pack, raw: packRaw } = readJsonWithRaw(packRecord.absolute,
    "PREPARED_MANIFEST_INVALID", "prepared pack.json");
  validatePreparedPackManifest(pack, config);
  const { value: checksums, raw: checksumRaw } = readJsonWithRaw(checksumRecord.absolute,
    "CHECKSUM_INVENTORY_INVALID", "prepared checksum inventory");
  const checksumSha256 = sha256Buffer(checksumRaw);
  if (checksumSha256 !== config.manifest.source.tree || checksumSha256 !== pack.checksums.sha256)
    fail("PREPARED_TREE_MISMATCH", `checksum inventory SHA-256 does not match source.tree: ${checksumSha256}`);
  const expected = parseChecksumInventory(checksums, config);
  const expectedPaths = expected.map(file => file.path);
  const reserved = new Set([PREPARED_MANIFEST_NAME, config.manifest.content.checksumsFile]);
  if (allowMetadata) reserved.add(METADATA_NAME);
  const payloadRecords = allRecords.filter(record => !reserved.has(record.path));
  const actualPaths = payloadRecords.map(record => record.path);
  if (!sameStringArray(actualPaths, expectedPaths)) {
    const expectedSet = new Set(expectedPaths);
    const actualSet = new Set(actualPaths);
    fail("PAYLOAD_LAYOUT_MISMATCH", "prepared payload files do not exactly match catalog/checksums.json", {
      missing: expectedPaths.filter(file => !actualSet.has(file)),
      extra: actualPaths.filter(file => !expectedSet.has(file))
    });
  }

  const hashed = await hashRecords(payloadRecords, report, phase);
  for (let index = 0; index < expected.length; index++) {
    const wanted = expected[index];
    const actual = hashed.files[index];
    if (actual.size !== wanted.size || actual.sha256 !== wanted.sha256)
      fail("PAYLOAD_CHECKSUM_MISMATCH", `prepared payload checksum mismatch: ${wanted.path}`, {
        path: wanted.path,
        expectedSize: wanted.size,
        actualSize: actual.size,
        expectedSha256: wanted.sha256,
        actualSha256: actual.sha256
      });
  }

  const byPath = new Map(hashed.files.map(file => [file.path, file]));
  const license = byPath.get(config.manifest.license.file);
  if (!license) fail("LICENSE_MISSING", `required license evidence is missing: ${config.manifest.license.file}`);
  if (license.sha256 !== config.manifest.license.sha256)
    fail("LICENSE_CHECKSUM_MISMATCH", `license checksum mismatch: ${config.manifest.license.file}`);
  const entries = config.entries.map(entry => {
    const record = byPath.get(entry);
    if (!record) fail("PACK_ENTRY_MISSING", `registered SFZ entry is missing from the checksum inventory: ${entry}`);
    return record;
  });
  const audioFiles = hashed.files.filter(file =>
    config.audioExtensions.has(path.posix.extname(file.path).toLowerCase())).length;
  if (audioFiles !== config.manifest.content.expectedAudioFiles)
    fail("PACK_COUNT_MISMATCH",
      `expected ${config.manifest.content.expectedAudioFiles} audio files, found ${audioFiles}`);

  return {
    root,
    pack,
    packSha256: sha256Buffer(packRaw),
    checksumsSha256: checksumSha256,
    files: hashed.files,
    entries,
    totalBytes: hashed.totalBytes,
    inventorySha256: hashed.sha256,
    audioFiles
  };
}

function metadataFor(config, verification, mode) {
  const manifest = config.manifest;
  return {
    schemaVersion: 1,
    packId: manifest.id,
    name: manifest.name,
    format: manifest.format,
    installDir: manifest.installDir,
    manifestSha256: config.sha256,
    source: {
      type: manifest.source.type,
      repositoryUrl: manifest.source.repositoryUrl,
      projectUrl: manifest.source.projectUrl,
      releaseUrl: manifest.source.releaseUrl,
      branch: manifest.source.branch,
      commit: manifest.source.commit,
      tree: manifest.source.tree,
      archiveSha256: manifest.source.archiveSha256,
      downloadUrl: manifest.source.downloadUrl
    },
    license: {
      spdx: manifest.license.spdx,
      name: manifest.license.name,
      file: manifest.license.file,
      url: manifest.license.url,
      sha256: manifest.license.sha256
    },
    prepared: {
      manifestFile: PREPARED_MANIFEST_NAME,
      manifestSha256: verification.packSha256,
      checksumsFile: manifest.content.checksumsFile,
      checksumsSha256: verification.checksumsSha256
    },
    verification: {
      trackedFiles: verification.files.length,
      totalBytes: verification.totalBytes,
      audioFiles: verification.audioFiles,
      entryFiles: verification.entries.length
    },
    entries: verification.entries,
    inventorySha256: verification.inventorySha256,
    files: verification.files,
    installMode: mode,
    installedAt: new Date().toISOString()
  };
}

function metadataIdentityMatches(metadata, config) {
  const manifest = config.manifest;
  return metadata?.schemaVersion === 1 && metadata.packId === manifest.id &&
    metadata.name === manifest.name && metadata.format === manifest.format &&
    metadata.installDir === manifest.installDir && metadata.manifestSha256 === config.sha256 &&
    metadata.source?.type === manifest.source.type &&
    metadata.source?.repositoryUrl === manifest.source.repositoryUrl &&
    metadata.source?.branch === manifest.source.branch &&
    metadata.source?.commit === manifest.source.commit && metadata.source?.tree === manifest.source.tree &&
    metadata.source?.archiveSha256 === manifest.source.archiveSha256 &&
    metadata.license?.spdx === manifest.license.spdx && metadata.license?.file === manifest.license.file &&
    metadata.license?.sha256 === manifest.license.sha256 &&
    metadata.prepared?.checksumsFile === manifest.content.checksumsFile &&
    metadata.prepared?.checksumsSha256 === manifest.source.tree;
}

async function validateManaged(root, config, report = null) {
  try {
    const metadataFile = path.join(root, METADATA_NAME);
    const stat = fs.lstatSync(metadataFile);
    if (!stat.isFile() || stat.isSymbolicLink())
      return { valid: false, reason: `${METADATA_NAME} is not a regular file` };
    const metadata = readJsonWithRaw(metadataFile, "PACK_METADATA_INVALID", "managed pack metadata").value;
    if (!metadataIdentityMatches(metadata, config))
      return { valid: false, reason: "installed metadata does not match the pinned manifest" };
    const verification = await verifyPreparedPack(root, config, {
      allowMetadata: true,
      report,
      phase: "checking-cache"
    });
    if (metadata.prepared.manifestSha256 !== verification.packSha256)
      return { valid: false, reason: "prepared pack.json checksum changed" };
    if (metadata.inventorySha256 !== verification.inventorySha256 ||
        JSON.stringify(metadata.files) !== JSON.stringify(verification.files) ||
        JSON.stringify(metadata.entries) !== JSON.stringify(verification.entries))
      return { valid: false, reason: "installed payload checksums changed" };
    return { valid: true, metadata, verification };
  } catch (error) {
    return { valid: false, reason: error.message, error };
  }
}

// The payload was fully hashed immediately before publication. An atomic rename on
// the same filesystem cannot rewrite those bytes, so staging/publication checks only
// need to prove that the exact verified snapshot and metadata moved together. Cache
// reuse still re-hashes every payload file in validateManaged().
function assertManagedSnapshot(root, config, metadata, verification) {
  const allRecords = listFilesNoLinks(root);
  const byPath = new Map(allRecords.map(record => [record.path, record]));
  const metadataRecord = byPath.get(METADATA_NAME);
  if (!metadataRecord)
    fail("PACK_METADATA_MISSING", `managed pack metadata is missing: ${METADATA_NAME}`);
  const installed = readJsonWithRaw(metadataRecord.absolute, "PACK_METADATA_INVALID", "managed pack metadata").value;
  if (!metadataIdentityMatches(installed, config) || JSON.stringify(installed) !== JSON.stringify(metadata))
    fail("PACK_METADATA_INVALID", "managed pack metadata changed during publication");
  const packRecord = byPath.get(PREPARED_MANIFEST_NAME);
  const checksumsRecord = byPath.get(config.manifest.content.checksumsFile);
  if (!packRecord || !checksumsRecord ||
      sha256Buffer(fs.readFileSync(packRecord.absolute)) !== verification.packSha256 ||
      sha256Buffer(fs.readFileSync(checksumsRecord.absolute)) !== verification.checksumsSha256)
    fail("PREPARED_TREE_MISMATCH", "prepared pack identity changed during publication");
  const reserved = new Set([METADATA_NAME, PREPARED_MANIFEST_NAME, config.manifest.content.checksumsFile]);
  const payload = allRecords.filter(record => !reserved.has(record.path));
  if (payload.length !== verification.files.length)
    fail("PAYLOAD_LAYOUT_MISMATCH", "prepared payload file count changed during publication");
  for (let index = 0; index < payload.length; index++) {
    if (payload[index].path !== verification.files[index].path || payload[index].size !== verification.files[index].size)
      fail("PAYLOAD_LAYOUT_MISMATCH", `prepared payload layout changed during publication: ${payload[index].path}`);
  }
}

function copyTreeNoLinks(source, destination) {
  assertDirectoryRoot(source);
  if (fs.existsSync(destination)) fail("STAGE_EXISTS", `staging directory already exists: ${destination}`);
  fs.mkdirSync(destination, { recursive: false, mode: 0o755 });
  function copyDirectory(from, to) {
    const entries = fs.readdirSync(from, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const sourceFile = path.join(from, entry.name);
      const targetFile = path.join(to, entry.name);
      const stat = fs.lstatSync(sourceFile);
      if (stat.isSymbolicLink()) fail("PACK_SYMLINK", `symbolic links are forbidden while adopting: ${toPosix(source, sourceFile)}`);
      if (stat.isDirectory()) {
        fs.mkdirSync(targetFile, { mode: 0o755 });
        copyDirectory(sourceFile, targetFile);
      } else if (stat.isFile()) {
        // APFS and other capable filesystems can make this a copy-on-write clone;
        // Node transparently falls back to a normal copy where cloning is unavailable.
        fs.copyFileSync(sourceFile, targetFile,
          fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        fs.chmodSync(targetFile, 0o644);
      } else {
        fail("PACK_SPECIAL_FILE", `unsupported filesystem entry while adopting: ${toPosix(source, sourceFile)}`);
      }
    }
  }
  copyDirectory(source, destination);
}

function validateDownloadUrl(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch { fail("DOWNLOAD_URL_INVALID", `download URL is invalid: ${value}`); }
  const loopbackHttp = parsed.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname);
  if (parsed.username || parsed.password || (parsed.protocol !== "https:" && !loopbackHttp))
    fail("DOWNLOAD_URL_INVALID", `download URL must use HTTPS without credentials: ${value}`);
  return parsed;
}

async function assertArchive(file, expectedSha256) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { fail("ARCHIVE_MISSING", `official archive is missing: ${file}`, { file }, error); }
  if (!stat.isFile() || stat.isSymbolicLink())
    fail("ARCHIVE_INVALID", `official archive must be a regular file, not a symlink: ${file}`);
  const actual = await sha256File(file);
  if (actual !== expectedSha256)
    fail("ARCHIVE_CHECKSUM_MISMATCH", `official archive checksum mismatch: ${file}`, {
      file, expectedSha256, actualSha256: actual
    });
  return { file: path.resolve(file), size: stat.size, sha256: actual };
}

async function downloadArchive(url, destination, expectedSha256, report) {
  validateDownloadUrl(url);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination),
    `.${path.basename(destination)}.download-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  let handle;
  try {
    report("downloading", "공식 archive를 다운로드합니다", { source: url, archive: destination });
    const response = await fetch(url, { redirect: "follow" });
    validateDownloadUrl(response.url);
    if (!response.ok || !response.body)
      fail("DOWNLOAD_FAILED", `archive download failed with HTTP ${response.status}`, { url, status: response.status });
    handle = fs.openSync(temporary, "wx", 0o600);
    const hash = crypto.createHash(HASH_ALGORITHM);
    const contentLength = response.headers.get("content-length");
    const expectedBytes = contentLength === null ? null : Number(contentLength);
    let receivedBytes = 0;
    let lastReport = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      fs.writeSync(handle, buffer);
      hash.update(buffer);
      receivedBytes += buffer.length;
      const now = Date.now();
      if (now - lastReport >= 500) {
        report("downloading", "공식 archive를 다운로드합니다", {
          quiet: true,
          source: url,
          archive: destination,
          progress: {
            unit: "bytes",
            current: receivedBytes,
            total: Number.isSafeInteger(expectedBytes) && expectedBytes >= 0 ? expectedBytes : null
          }
        });
        lastReport = now;
      }
    }
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== expectedSha256)
      fail("ARCHIVE_CHECKSUM_MISMATCH", "downloaded archive checksum does not match the pinned manifest", {
        source: url, expectedSha256, actualSha256, receivedBytes
      });
    if (fs.existsSync(destination)) return await assertArchive(destination, expectedSha256);
    fs.renameSync(temporary, destination);
    return await assertArchive(destination, expectedSha256);
  } catch (error) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* already closed */ }
    }
    throw error;
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

async function selectArchive(config, override, report) {
  const archive = path.resolve(override ?? config.defaultArchive);
  if (fs.existsSync(archive)) {
    report("verifying-archive", "cached official archive의 checksum을 확인합니다", { archive });
    return await assertArchive(archive, config.manifest.source.archiveSha256);
  }
  if (override)
    fail("ARCHIVE_MISSING", `explicit archive is missing: ${archive}`);
  if (!config.downloadUrl)
    fail("ARCHIVE_MISSING", `cached official archive is missing and no source.downloadUrl is declared: ${archive}`);
  return await downloadArchive(config.downloadUrl, archive, config.manifest.source.archiveSha256, report);
}

function runPreparation(config, archive, output, report) {
  let stat;
  try { stat = fs.lstatSync(config.prepareScript); }
  catch (error) { fail("PREPARE_SCRIPT_MISSING", `preparation script is missing: ${config.prepareScript}`, undefined, error); }
  if (!stat.isFile() || stat.isSymbolicLink())
    fail("PREPARE_SCRIPT_INVALID", `preparation script must be a regular repository file: ${config.prepareScript}`);
  if (fs.existsSync(output)) fail("STAGE_EXISTS", `preparation output already exists: ${output}`);
  report("preparing", "공식 archive에서 검증 가능한 SFZ pack을 준비합니다", {
    archive: archive.file,
    prepareScript: config.manifest.source.prepareScript
  });
  try {
    execFileSync(process.execPath, [
      config.prepareScript,
      ...config.prepareArgs,
      "--archive", archive.file,
      "--output", output
    ], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: "inherit"
    });
  } catch (error) {
    fail("PREPARE_FAILED", `pack preparation failed: ${error.message}`, { status: error.status, signal: error.signal }, error);
  }
}

export async function atomicPublishPrepared(stage, target, validate) {
  const parent = path.dirname(target);
  const previous = path.join(parent,
    `.${path.basename(target)}.previous-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  let previousMoved = false;
  let stageMoved = false;
  try {
    if (fs.existsSync(target)) {
      fs.renameSync(target, previous);
      previousMoved = true;
    }
    fs.renameSync(stage, target);
    stageMoved = true;
    await validate(target);
  } catch (error) {
    let rollbackError;
    try {
      if (stageMoved && fs.existsSync(target) && !fs.existsSync(stage)) fs.renameSync(target, stage);
      if (previousMoved && fs.existsSync(previous) && !fs.existsSync(target)) fs.renameSync(previous, target);
    } catch (failure) {
      rollbackError = failure;
    }
    if (rollbackError)
      fail("PUBLISH_ROLLBACK_FAILED", `pack publish failed and the previous target could not be restored: ${rollbackError.message}`, {
        target, previous, originalError: error.message
      }, rollbackError);
    throw error;
  }
  if (previousMoved && fs.existsSync(previous)) {
    try { fs.rmSync(previous, { recursive: true, force: true }); }
    catch (error) { console.warn(`New pack is active, but the previous directory could not be removed: ${error.message}`); }
  }
}

export async function installPreparedPack(options) {
  const config = loadPreparedManifest(manifestPathFor(options.manifestRef));
  const packHome = path.resolve(process.env.ARIA_PACKS_DIR || process.env.ARIA_PACK_HOME ||
    path.join(os.homedir(), ".aria", "packs"));
  fs.mkdirSync(packHome, { recursive: true });
  const target = path.join(packHome, config.manifest.installDir);
  const statusFile = path.join(packHome, ".status", `${config.manifest.id}.json`);
  const report = createStatusReporter(statusFile, config.manifest.id, target);

  try {
    if (options.mode !== "verify") {
      report("checking-cache", "기존 설치의 무결성을 확인합니다");
      if (fs.existsSync(target)) {
        const cached = await validateManaged(target, config, report);
        if (cached.valid) {
          report("ready", "검증된 설치를 그대로 사용합니다", {
            fromCache: true,
            metadataFile: path.join(target, METADATA_NAME),
            verification: cached.metadata.verification
          });
          return { config, target, metadata: cached.metadata, fromCache: true };
        }
        report("cache-invalid", `기존 설치를 사용할 수 없습니다: ${cached.reason}`);
      }
    }

    if (options.mode === "verify") {
      const source = path.resolve(options.sourcePath);
      report("verifying-source", "준비된 pack을 읽기 전용으로 전수 검증합니다", { source });
      const verification = await verifyPreparedPack(source, config, { report });
      metadataFor(config, verification, "verify-only");
      report("verified", "준비된 pack이 고정 manifest와 정확히 일치합니다", {
        source,
        verification: {
          trackedFiles: verification.files.length,
          totalBytes: verification.totalBytes,
          audioFiles: verification.audioFiles,
          entryFiles: verification.entries.length
        }
      });
      return { config, target, verification, fromCache: false };
    }

    const workspace = fs.mkdtempSync(path.join(packHome, `.${config.manifest.id}.prepared-install-`));
    const stage = path.join(workspace, "prepared-pack");
    try {
      if (options.mode === "adopt") {
        const source = path.resolve(options.sourcePath);
        report("staging", "기존 준비 결과를 링크 없이 안전한 설치 stage로 복사합니다", { source });
        copyTreeNoLinks(source, stage);
      } else {
        const archive = await selectArchive(config, options.archivePath, report);
        runPreparation(config, archive, stage, report);
      }

      report("verifying-stage", "설치 stage의 모든 checksum과 경로를 다시 확인합니다");
      const verification = await verifyPreparedPack(stage, config, { report, phase: "verifying-stage" });
      const metadata = metadataFor(config, verification, options.mode === "adopt" ? "adopt" : "prepare");
      atomicWriteJson(path.join(stage, METADATA_NAME), metadata);
      assertManagedSnapshot(stage, config, metadata, verification);

      report("publishing", "검증된 pack을 최종 위치에 공개합니다");
      await atomicPublishPrepared(stage, target, async publishedTarget =>
        assertManagedSnapshot(publishedTarget, config, metadata, verification));
      report("ready", "sample pack 준비·설치·검증을 마쳤습니다", {
        fromCache: false,
        installMode: metadata.installMode,
        metadataFile: path.join(target, METADATA_NAME),
        verification: metadata.verification
      });
      return { config, target, metadata, fromCache: false };
    } finally {
      if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
    }
  } catch (error) {
    const code = error.code || "PREPARED_PACK_INSTALL_FAILED";
    try {
      report("error", error.message, { error: { code, name: error.name, message: error.message } });
    } catch (statusError) {
      console.error(`Could not write pack status: ${statusError.message}`);
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.exit !== undefined) {
    process.exitCode = options.exit;
    return;
  }
  await installPreparedPack(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`${error.code || "PREPARED_PACK_INSTALL_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  });
}

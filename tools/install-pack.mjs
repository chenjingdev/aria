#!/usr/bin/env node
// Install a pinned sample pack without silently substituting another source or pack.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const METADATA_NAME = ".aria-pack.json";
const HASH_ALGORITHM = "sha256";

class PackInstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PackInstallError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PackInstallError(code, message);
}

function usage() {
  console.log(`Usage:
  node tools/install-pack.mjs <pack-id|manifest.json>
  node tools/install-pack.mjs <pack-id|manifest.json> --adopt [existing-clone]
  node tools/install-pack.mjs <pack-id|manifest.json> --verify-source <existing-clone>

Environment:
  ARIA_PACKS_DIR  Preferred sample-pack root override
  ARIA_PACK_HOME  Backward-compatible sample-pack root override`);
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const manifestRef = argv[0];
  let mode = "install";
  let sourcePath;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--adopt") {
      if (mode !== "install") fail("ARGUMENT_ERROR", "--adopt and --verify-source are mutually exclusive");
      mode = "adopt";
      if (argv[index + 1] && !argv[index + 1].startsWith("--")) sourcePath = argv[++index];
    } else if (argument === "--verify-source") {
      if (mode !== "install") fail("ARGUMENT_ERROR", "--adopt and --verify-source are mutually exclusive");
      mode = "verify";
      sourcePath = argv[++index];
      if (!sourcePath || sourcePath.startsWith("--"))
        fail("ARGUMENT_ERROR", "--verify-source requires an existing clone path");
    } else {
      fail("ARGUMENT_ERROR", `unknown argument: ${argument}`);
    }
  }
  return { manifestRef, mode, sourcePath };
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

function assertSha1(label, value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value))
    fail("MANIFEST_INVALID", `${label} must be a full lowercase 40-character Git hash`);
}

function assertSha256(label, value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    fail("MANIFEST_INVALID", `${label} must be a lowercase SHA-256 hash`);
}

function assertPositiveInteger(label, value) {
  if (!Number.isSafeInteger(value) || value < 1)
    fail("MANIFEST_INVALID", `${label} must be a positive integer`);
}

function assertSafeRelativePath(label, value, { singleSegment = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      path.posix.isAbsolute(value.replaceAll("\\", "/")) || /^[a-zA-Z]:[\\/]/.test(value))
    fail("MANIFEST_INVALID", `${label} must be a non-empty relative path`);
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.includes("") || parts.includes(".") || parts.includes("..") ||
      (singleSegment && parts.length !== 1))
    fail("MANIFEST_INVALID", `${label} contains an unsafe path: ${value}`);
}

function bytewiseSort(values) {
  return values.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function loadManifest(file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (error) {
    fail("MANIFEST_NOT_FOUND", `cannot read pack manifest ${file}: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    fail("MANIFEST_INVALID", `invalid JSON in ${file}: ${error.message}`);
  }

  if (manifest.schemaVersion !== 1) fail("MANIFEST_INVALID", "unsupported pack manifest schemaVersion");
  if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id))
    fail("MANIFEST_INVALID", "pack id must use lowercase letters, numbers, and hyphens");
  if (typeof manifest.name !== "string" || manifest.name.length === 0)
    fail("MANIFEST_INVALID", "pack name must be a non-empty string");
  if (manifest.format !== "sfz") fail("MANIFEST_INVALID", "this installer currently supports format=sfz");
  assertSafeRelativePath("installDir", manifest.installDir, { singleSegment: true });
  if (manifest.source?.type !== "git" || typeof manifest.source.repositoryUrl !== "string" ||
      manifest.source.repositoryUrl.length === 0 || typeof manifest.source.branch !== "string" ||
      manifest.source.branch.length === 0)
    fail("MANIFEST_INVALID", "source must provide type=git, repositoryUrl, and branch");
  assertSha1("source.commit", manifest.source.commit);
  assertSha1("source.tree", manifest.source.tree);
  if (typeof manifest.license?.spdx !== "string" || typeof manifest.license?.url !== "string")
    fail("MANIFEST_INVALID", "license must provide spdx and official url");
  assertSafeRelativePath("license.file", manifest.license.file);
  assertSha256("license.sha256", manifest.license.sha256);

  const content = manifest.content;
  if (!content || !Array.isArray(content.entryFiles) || content.entryFiles.length === 0)
    fail("MANIFEST_INVALID", "content.entryFiles must be a non-empty array");
  const entries = content.entryFiles.map((entry, index) => {
    assertSafeRelativePath(`content.entryFiles[${index}]`, entry);
    if (path.posix.extname(entry).toLowerCase() !== ".sfz")
      fail("MANIFEST_INVALID", `entry file is not SFZ: ${entry}`);
    return entry.replaceAll("\\", "/");
  });
  if (new Set(entries).size !== entries.length)
    fail("MANIFEST_INVALID", "content.entryFiles contains duplicates");
  assertPositiveInteger("content.expectedTrackedFiles", content.expectedTrackedFiles);
  assertPositiveInteger("content.expectedAudioFiles", content.expectedAudioFiles);
  assertPositiveInteger("content.expectedSampleReferences", content.expectedSampleReferences);
  if (!Array.isArray(content.audioExtensions) || content.audioExtensions.length === 0)
    fail("MANIFEST_INVALID", "content.audioExtensions must not be empty");
  const audioExtensions = content.audioExtensions.map((extension, index) => {
    if (typeof extension !== "string" || !/^\.[a-z0-9]+$/.test(extension))
      fail("MANIFEST_INVALID", `invalid content.audioExtensions[${index}]`);
    return extension;
  });

  if (manifest.catalog !== undefined) {
    if (!Array.isArray(manifest.catalog) || manifest.catalog.length !== entries.length)
      fail("MANIFEST_INVALID", "catalog must contain one item per entry file");
    const ids = new Set();
    const paths = new Set();
    for (const [index, item] of manifest.catalog.entries()) {
      if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(item.id) || ids.has(item.id))
        fail("MANIFEST_INVALID", `catalog[${index}].id must be a unique stable slug`);
      assertSafeRelativePath(`catalog[${index}].path`, item.path);
      if (!entries.includes(item.path) || paths.has(item.path))
        fail("MANIFEST_INVALID", `catalog[${index}].path must uniquely match an entry file`);
      if (typeof item.name !== "string" || typeof item.family !== "string" ||
          typeof item.articulation !== "string" || typeof item.label !== "string" ||
          typeof item.source !== "string" || typeof item.drum !== "boolean")
        fail("MANIFEST_INVALID", `catalog[${index}] is missing display metadata`);
      if (!item.gm || !Number.isInteger(item.gm.bank) || !Number.isInteger(item.gm.program) ||
          item.gm.bank < 0 || item.gm.bank > 16383 || item.gm.program < 0 || item.gm.program > 127)
        fail("MANIFEST_INVALID", `catalog[${index}].gm must contain zero-based bank/program numbers`);
      if (item.pieces !== undefined) {
        if (!item.drum || !Array.isArray(item.pieces) || item.pieces.length === 0)
          fail("MANIFEST_INVALID", `catalog[${index}].pieces requires a drum entry and a non-empty array`);
        const pieceIds = new Set();
        const pieceTriggers = new Set();
        for (const [pieceIndex, piece] of item.pieces.entries()) {
          if (typeof piece.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(piece.id) || pieceIds.has(piece.id))
            fail("MANIFEST_INVALID", `catalog[${index}].pieces[${pieceIndex}].id must be a unique stable slug`);
          if (!Number.isInteger(piece.key) || piece.key < 0 || piece.key > 127)
            fail("MANIFEST_INVALID", `catalog[${index}].pieces[${pieceIndex}].key must be a MIDI key`);
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
      }
      ids.add(item.id);
      paths.add(item.path);
    }
  }

  return {
    file,
    raw,
    sha256: sha256Buffer(raw),
    manifest,
    entries,
    audioExtensions: new Set(audioExtensions)
  };
}

function atomicWriteJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function createStatusReporter(statusFile, packId, target) {
  const startedAt = new Date().toISOString();
  let last;
  return (state, message, details = {}) => {
    last = {
      schemaVersion: 1,
      packId,
      state,
      message,
      target,
      startedAt,
      updatedAt: new Date().toISOString(),
      ...details
    };
    atomicWriteJson(statusFile, last);
    if (details.quiet !== true) console.log(`[${packId}] ${message}`);
    return last;
  };
}

const gitEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
function run(program, args, cwd = ROOT, stdio = "inherit") {
  return execFileSync(program, args, { cwd, env: gitEnvironment, stdio });
}

function capture(program, args, cwd = ROOT) {
  return execFileSync(program, args, {
    cwd,
    env: gitEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024
  }).trim();
}

function captureBuffer(program, args, cwd = ROOT) {
  return execFileSync(program, args, {
    cwd,
    env: gitEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024
  });
}

function toPosix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function listPackFiles(root) {
  const records = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && (entry.name === ".git" || entry.name === METADATA_NAME)) continue;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail("PACK_INVALID", `symbolic links are not allowed in a managed pack: ${toPosix(root, absolute)}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) records.push({ path: toPosix(root, absolute), size: stat.size, absolute });
      else fail("PACK_INVALID", `unsupported filesystem entry in pack: ${toPosix(root, absolute)}`);
    }
  }
  visit(root);
  return records.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stripSfzValue(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1);
  return trimmed;
}

function resolveSfzReference(entryPath, defaultPath, samplePath) {
  const base = path.posix.dirname(entryPath);
  const normalizedDefault = defaultPath.replaceAll("\\", "/");
  const normalizedSample = samplePath.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalizedDefault) || path.posix.isAbsolute(normalizedSample) ||
      /^[a-zA-Z]:[\\/]/.test(defaultPath) || /^[a-zA-Z]:[\\/]/.test(samplePath))
    fail("SFZ_PATH_ESCAPE", `${entryPath} contains an absolute sample path`);
  const resolved = path.posix.normalize(path.posix.join(base, normalizedDefault, normalizedSample));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved))
    fail("SFZ_PATH_ESCAPE", `${entryPath} sample escapes the pack root: ${samplePath}`);
  return resolved;
}

function verifySfzReferences(root, config, availablePaths) {
  const referenced = [];
  for (const entryPath of config.entries) {
    const absoluteEntry = path.join(root, ...entryPath.split("/"));
    let defaultPath = "";
    const lines = fs.readFileSync(absoluteEntry, "utf8").split(/\r?\n/);
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = lines[lineNumber].replace(/\/\/.*$/, "").trim();
      if (!line) continue;
      if (/\bdefault_path\s*=/i.test(line)) {
        const match = line.match(/^default_path\s*=\s*(.*?)\s*$/i);
        if (!match) fail("SFZ_PARSE_ERROR", `${entryPath}:${lineNumber + 1} has an ambiguous default_path opcode`);
        defaultPath = stripSfzValue(match[1]);
        continue;
      }
      if (/\bsample\s*=/i.test(line)) {
        const match = line.match(/^sample\s*=\s*(.*?)\s*$/i);
        if (!match) fail("SFZ_PARSE_ERROR", `${entryPath}:${lineNumber + 1} has an ambiguous sample opcode`);
        const sample = stripSfzValue(match[1]);
        if (sample.startsWith("*")) continue;
        const resolved = resolveSfzReference(entryPath, defaultPath, sample);
        if (!config.audioExtensions.has(path.posix.extname(resolved).toLowerCase()))
          fail("SFZ_SAMPLE_TYPE", `${entryPath}:${lineNumber + 1} references an undeclared sample type: ${resolved}`);
        if (!availablePaths.has(resolved))
          fail("SFZ_SAMPLE_MISSING", `${entryPath}:${lineNumber + 1} references a missing or case-mismatched sample: ${resolved}`);
        referenced.push(resolved);
      }
    }
  }
  if (referenced.length !== config.manifest.content.expectedSampleReferences)
    fail("PACK_COUNT_MISMATCH", `expected ${config.manifest.content.expectedSampleReferences} SFZ sample references, found ${referenced.length}`);
  return { count: referenced.length, unique: new Set(referenced).size };
}

function verifyDrumPieceMaps(root, config) {
  if (!Array.isArray(config.manifest.catalog)) return;
  for (const item of config.manifest.catalog.filter(entry => entry.drum && Array.isArray(entry.pieces))) {
    const text = fs.readFileSync(path.join(root, ...item.path.split("/")), "utf8");
    const mapped = new Map();
    for (const block of text.split(/<region>/i).slice(1)) {
      const sample = block.match(/(?:^|\r?\n)\s*sample\s*=\s*([^\r\n]+)/i)?.[1].trim();
      const exact = block.match(/(?:^|\r?\n)\s*key\s*=\s*(\d+)/i)?.[1];
      const low = block.match(/(?:^|\r?\n)\s*lokey\s*=\s*(\d+)/i)?.[1];
      const high = block.match(/(?:^|\r?\n)\s*hikey\s*=\s*(\d+)/i)?.[1];
      const first = exact === undefined ? Number(low) : Number(exact);
      const last = exact === undefined ? Number(high ?? low) : Number(exact);
      if (!sample || !Number.isInteger(first) || !Number.isInteger(last) || first > last)
        fail("SFZ_DRUM_MAP_ERROR", `${item.path} contains a region without a verifiable sample/key mapping`);
      for (let key = first; key <= last; key++) {
        if (!mapped.has(key)) mapped.set(key, []);
        mapped.get(key).push(sample);
      }
    }
    const declaredKeys = item.pieces.map(piece => piece.key).sort((left, right) => left - right);
    const mappedKeys = [...mapped.keys()].sort((left, right) => left - right);
    if (!sameStringArray(declaredKeys.map(String), mappedKeys.map(String)))
      fail("SFZ_DRUM_MAP_MISMATCH", `${item.path} mapped keys do not match catalog pieces`);
    for (const piece of item.pieces) {
      const stem = piece.sampleStem.toLocaleLowerCase("en-US");
      if (!mapped.get(piece.key).some(sample => path.posix.basename(sample.replaceAll("\\", "/")).toLocaleLowerCase("en-US").includes(stem)))
        fail("SFZ_DRUM_MAP_MISMATCH", `${item.path} key ${piece.key} does not match sampleStem ${piece.sampleStem}`);
    }
  }
}

function verifyFileLayout(root, config, records, expectedPaths) {
  const manifest = config.manifest;
  const paths = records.map(record => record.path);
  const pathSet = new Set(paths);
  if (expectedPaths && !sameStringArray(paths, expectedPaths))
    fail("SOURCE_DIRTY", "working tree files do not exactly match the pinned Git tree");
  if (records.length !== manifest.content.expectedTrackedFiles)
    fail("PACK_COUNT_MISMATCH", `expected ${manifest.content.expectedTrackedFiles} pack files, found ${records.length}`);
  const actualEntries = bytewiseSort(paths.filter(file => path.posix.dirname(file) === "." && path.posix.extname(file).toLowerCase() === ".sfz"));
  const expectedEntries = bytewiseSort([...config.entries]);
  if (!sameStringArray(actualEntries, expectedEntries))
    fail("PACK_ENTRY_MISMATCH", "root SFZ entry files do not exactly match content.entryFiles");
  const audioFiles = paths.filter(file => config.audioExtensions.has(path.posix.extname(file).toLowerCase()));
  if (audioFiles.length !== manifest.content.expectedAudioFiles)
    fail("PACK_COUNT_MISMATCH", `expected ${manifest.content.expectedAudioFiles} audio files, found ${audioFiles.length}`);
  if (!pathSet.has(manifest.license.file))
    fail("LICENSE_MISSING", `required license file is missing: ${manifest.license.file}`);
  const references = verifySfzReferences(root, config, pathSet);
  verifyDrumPieceMaps(root, config);
  return { pathSet, audioFiles: audioFiles.length, references };
}

function verifyGitSource(source, config) {
  if (!fs.existsSync(path.join(source, ".git")))
    fail("SOURCE_NOT_GIT", `adopt/verify source is not a Git working tree: ${source}`);
  const commit = capture("git", ["rev-parse", "HEAD"], source);
  const tree = capture("git", ["rev-parse", "HEAD^{tree}"], source);
  if (commit !== config.manifest.source.commit)
    fail("SOURCE_COMMIT_MISMATCH", `expected commit ${config.manifest.source.commit}, found ${commit}`);
  if (tree !== config.manifest.source.tree)
    fail("SOURCE_TREE_MISMATCH", `expected tree ${config.manifest.source.tree}, found ${tree}`);
  const status = capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], source);
  if (status) fail("SOURCE_DIRTY", `source clone has modified or untracked files:\n${status}`);
  const tracked = captureBuffer("git", ["ls-files", "-z"], source).toString("utf8").split("\0").filter(Boolean);
  const expectedPaths = bytewiseSort(tracked.map(file => file.split(path.sep).join("/")));
  const records = listPackFiles(source);
  const layout = verifyFileLayout(source, config, records, expectedPaths);
  return { commit, tree, records, ...layout };
}

async function hashInventory(root, records, report, phase) {
  const files = [];
  let completedBytes = 0;
  const totalBytes = records.reduce((total, record) => total + record.size, 0);
  let lastReport = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const hash = await sha256File(record.absolute ?? path.join(root, ...record.path.split("/")));
    files.push({ path: record.path, size: record.size, sha256: hash });
    completedBytes += record.size;
    const now = Date.now();
    if (index === records.length - 1 || now - lastReport >= 500) {
      report(phase, `파일 무결성 확인 ${index + 1}/${records.length}`, {
        quiet: true,
        progress: {
          unit: "files",
          current: index + 1,
          total: records.length,
          completedBytes,
          totalBytes
        }
      });
      lastReport = now;
    }
  }
  const inventory = crypto.createHash(HASH_ALGORITHM);
  for (const file of files)
    inventory.update(file.path).update("\0").update(String(file.size)).update("\0").update(file.sha256).update("\n");
  return { files, sha256: inventory.digest("hex"), totalBytes };
}

function metadataFor(config, verification, inventory, mode) {
  const byPath = new Map(inventory.files.map(file => [file.path, file]));
  const licenseRecord = byPath.get(config.manifest.license.file);
  if (licenseRecord.sha256 !== config.manifest.license.sha256)
    fail("LICENSE_CHECKSUM_MISMATCH", `license checksum mismatch: ${config.manifest.license.file}`);
  return {
    schemaVersion: 1,
    packId: config.manifest.id,
    name: config.manifest.name,
    format: config.manifest.format,
    installDir: config.manifest.installDir,
    manifestSha256: config.sha256,
    source: {
      type: config.manifest.source.type,
      repositoryUrl: config.manifest.source.repositoryUrl,
      projectUrl: config.manifest.source.projectUrl,
      releaseUrl: config.manifest.source.releaseUrl,
      branch: config.manifest.source.branch,
      commit: config.manifest.source.commit,
      tree: config.manifest.source.tree
    },
    license: {
      spdx: config.manifest.license.spdx,
      name: config.manifest.license.name,
      file: config.manifest.license.file,
      url: config.manifest.license.url,
      sha256: licenseRecord.sha256
    },
    verification: {
      trackedFiles: inventory.files.length,
      totalBytes: inventory.totalBytes,
      audioFiles: verification.audioFiles,
      entryFiles: config.entries.length,
      sampleReferences: verification.references.count,
      uniqueReferencedSamples: verification.references.unique
    },
    entries: config.entries.map(entryPath => byPath.get(entryPath)),
    inventorySha256: inventory.sha256,
    files: inventory.files,
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
    metadata.license?.spdx === manifest.license.spdx && metadata.license?.file === manifest.license.file &&
    metadata.license?.sha256 === manifest.license.sha256;
}

async function validateManaged(root, config, report) {
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { valid: false, reason: "target is not a regular directory" };
    if (fs.existsSync(path.join(root, ".git"))) return { valid: false, reason: "managed target still contains .git" };
    const metadataFile = path.join(root, METADATA_NAME);
    const metadataStat = fs.lstatSync(metadataFile);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) return { valid: false, reason: `${METADATA_NAME} is not a regular file` };
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    if (!metadataIdentityMatches(metadata, config)) return { valid: false, reason: "installed metadata does not match the manifest" };
    if (!Array.isArray(metadata.files) || metadata.files.length !== config.manifest.content.expectedTrackedFiles)
      return { valid: false, reason: "installed file inventory is incomplete" };
    const records = listPackFiles(root);
    const expectedPaths = metadata.files.map(file => file.path);
    const layout = verifyFileLayout(root, config, records, expectedPaths);
    for (let index = 0; index < records.length; index++) {
      if (records[index].size !== metadata.files[index]?.size)
        return { valid: false, reason: `file size changed: ${records[index].path}` };
    }
    const inventory = await hashInventory(root, records, report, "checking-cache");
    if (inventory.sha256 !== metadata.inventorySha256)
      return { valid: false, reason: "installed file checksums changed" };
    for (let index = 0; index < inventory.files.length; index++) {
      if (inventory.files[index].sha256 !== metadata.files[index]?.sha256)
        return { valid: false, reason: `file checksum changed: ${inventory.files[index].path}` };
    }
    const expectedEntries = config.entries.map(entryPath => inventory.files.find(file => file.path === entryPath));
    if (JSON.stringify(metadata.entries) !== JSON.stringify(expectedEntries))
      return { valid: false, reason: "entry-file checksums changed" };
    if (metadata.license.sha256 !== config.manifest.license.sha256)
      return { valid: false, reason: "license checksum changed" };
    return { valid: true, metadata, layout };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

function sourceUrlMatches(actual, expected) {
  const normalize = value => value.replace(/\/$/, "").replace(/\.git$/, "");
  if (normalize(actual) === normalize(expected)) return true;
  try {
    return fs.realpathSync(actual) === fs.realpathSync(expected);
  } catch {
    return false;
  }
}

function assertAdoptSource(source, target, config) {
  let sourceReal;
  let targetReal;
  try {
    sourceReal = fs.realpathSync(source);
    targetReal = fs.realpathSync(target);
  } catch (error) {
    fail("ADOPT_SOURCE_MISSING", `cannot resolve adopt source: ${error.message}`);
  }
  if (sourceReal !== targetReal)
    fail("ADOPT_PATH_MISMATCH", `adopt is in-place only; source must be the manifest target ${target}`);
  const origin = capture("git", ["remote", "get-url", "origin"], source);
  if (!sourceUrlMatches(origin, config.manifest.source.repositoryUrl))
    fail("SOURCE_REMOTE_MISMATCH", `origin does not match manifest source: ${origin}`);
}

function recoverInterruptedAdoption(statusFile, target, packHome, report) {
  if (!fs.existsSync(statusFile) || fs.existsSync(path.join(target, ".git"))) return;
  try {
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    if (status.state !== "adopting" || typeof status.recoveryGitDir !== "string") return undefined;
    const relative = path.relative(packHome, status.recoveryGitDir);
    if (relative.startsWith("..") || path.isAbsolute(relative) ||
        !path.basename(status.recoveryGitDir).startsWith(".adopt-git-")) return undefined;
    if (!fs.existsSync(status.recoveryGitDir)) return undefined;
    if (fs.existsSync(path.join(target, METADATA_NAME))) return status.recoveryGitDir;
    fs.renameSync(status.recoveryGitDir, path.join(target, ".git"));
    report("recovered", "중단된 adopt 작업의 Git 메타데이터를 복구했습니다");
  } catch {
    // A malformed status file is handled by the normal source validation below.
  }
  return undefined;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = loadManifest(manifestPathFor(options.manifestRef));
  const packHome = path.resolve(process.env.ARIA_PACKS_DIR || process.env.ARIA_PACK_HOME || path.join(os.homedir(), ".aria", "packs"));
  const target = path.join(packHome, config.manifest.installDir);
  const statusFile = path.join(packHome, ".status", `${config.manifest.id}.json`);
  const report = createStatusReporter(statusFile, config.manifest.id, target);
  fs.mkdirSync(packHome, { recursive: true });

  try {
    const pendingAdoptCleanup = options.mode === "adopt"
      ? recoverInterruptedAdoption(statusFile, target, packHome, report)
      : undefined;
    if (options.mode !== "verify") {
      report("checking-cache", "기존 설치의 무결성을 확인합니다");
      if (fs.existsSync(target)) {
        const cacheReport = pendingAdoptCleanup
          ? (_state, message, details = {}) => report("adopting", message, {
              ...details,
              source: target,
              recoveryGitDir: pendingAdoptCleanup
            })
          : report;
        const cached = await validateManaged(target, config, cacheReport);
        if (cached.valid) {
          if (pendingAdoptCleanup) fs.rmSync(pendingAdoptCleanup, { recursive: true, force: true });
          report("ready", "검증된 설치를 그대로 사용합니다", {
            fromCache: true,
            metadataFile: path.join(target, METADATA_NAME),
            verification: cached.metadata.verification
          });
          return;
        }
        report("cache-invalid", `기존 설치를 사용할 수 없습니다: ${cached.reason}`);
      }
    }

    if (options.mode === "verify") {
      const source = path.resolve(options.sourcePath);
      report("verifying-source", "기존 Git 소스를 읽기 전용으로 검증합니다", { source });
      const verification = verifyGitSource(source, config);
      const inventory = await hashInventory(source, verification.records, report, "verifying-source");
      metadataFor(config, verification, inventory, "verify-only");
      report("verified", "소스가 manifest와 정확히 일치합니다", {
        source,
        verification: {
          trackedFiles: verification.records.length,
          totalBytes: inventory.totalBytes,
          audioFiles: verification.audioFiles,
          entryFiles: config.entries.length,
          sampleReferences: verification.references.count,
          uniqueReferencedSamples: verification.references.unique
        }
      });
      return;
    }

    if (options.mode === "adopt") {
      const source = path.resolve(options.sourcePath || target);
      assertAdoptSource(source, target, config);
      report("verifying-source", "기존 clone을 다시 받지 않고 검증합니다", { source });
      const verification = verifyGitSource(source, config);
      const inventory = await hashInventory(source, verification.records, report, "verifying-source");
      const metadata = metadataFor(config, verification, inventory, "adopt");
      const gitDir = path.join(source, ".git");
      const recoveryGitDir = path.join(packHome, `.adopt-git-${config.manifest.id}-${process.pid}-${Date.now()}`);
      report("adopting", "검증된 working tree를 managed pack으로 전환합니다", { source, recoveryGitDir });
      fs.renameSync(gitDir, recoveryGitDir);
      try {
        atomicWriteJson(path.join(target, METADATA_NAME), metadata);
        const adoptionReport = (_state, message, details = {}) =>
          report("adopting", message, { ...details, source, recoveryGitDir });
        const adopted = await validateManaged(target, config, adoptionReport);
        if (!adopted.valid) fail("ADOPT_VALIDATION_FAILED", adopted.reason);
      } catch (error) {
        if (fs.existsSync(path.join(target, METADATA_NAME))) fs.rmSync(path.join(target, METADATA_NAME), { force: true });
        if (!fs.existsSync(gitDir) && fs.existsSync(recoveryGitDir)) fs.renameSync(recoveryGitDir, gitDir);
        throw error;
      }
      fs.rmSync(recoveryGitDir, { recursive: true, force: true });
      report("ready", "기존 clone을 다시 다운로드하지 않고 관리형 pack으로 전환했습니다", {
        fromCache: false,
        installMode: "adopt",
        metadataFile: path.join(target, METADATA_NAME),
        verification: metadata.verification
      });
      return;
    }

    const workspace = fs.mkdtempSync(path.join(packHome, `.${config.manifest.id}.install-`));
    const source = path.join(workspace, "working-tree");
    let published = false;
    try {
      report("fetching", `고정 commit ${config.manifest.source.commit.slice(0, 12)}을 얕게 받습니다`, {
        source: config.manifest.source.repositoryUrl
      });
      run("git", ["init", "--quiet", source]);
      run("git", ["remote", "add", "origin", config.manifest.source.repositoryUrl], source);
      run("git", ["fetch", "--depth", "1", "--no-tags", "origin", config.manifest.source.commit], source);
      run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], source);
      if (capture("git", ["rev-parse", "--is-shallow-repository"], source) !== "true")
        fail("SOURCE_NOT_SHALLOW", "downloaded source is not a shallow checkout");

      report("verifying-source", "SFZ 진입 파일·샘플 참조·라이선스를 확인합니다");
      const verification = verifyGitSource(source, config);
      const inventory = await hashInventory(source, verification.records, report, "verifying-source");
      const metadata = metadataFor(config, verification, inventory, "download");

      report("staging", "Git 객체를 제외하고 설치를 준비합니다");
      fs.rmSync(path.join(source, ".git"), { recursive: true, force: true });
      if (fs.existsSync(path.join(source, ".git"))) fail("STAGE_INVALID", ".git was not removed from staged pack");
      atomicWriteJson(path.join(source, METADATA_NAME), metadata);

      report("publishing", "검증된 pack을 최종 위치에 공개합니다");
      let previous;
      if (fs.existsSync(target)) {
        previous = path.join(packHome, `.${config.manifest.installDir}.previous-${process.pid}-${Date.now()}`);
        fs.renameSync(target, previous);
      }
      try {
        fs.renameSync(source, target);
        published = true;
      } catch (error) {
        if (previous && !fs.existsSync(target)) fs.renameSync(previous, target);
        throw error;
      }
      if (previous) {
        try {
          fs.rmSync(previous, { recursive: true, force: true });
        } catch (error) {
          console.warn(`New pack is active, but the previous directory could not be removed: ${error.message}`);
        }
      }
      report("ready", "sample pack 설치와 검증을 마쳤습니다", {
        fromCache: false,
        installMode: "download",
        metadataFile: path.join(target, METADATA_NAME),
        verification: metadata.verification
      });
    } finally {
      if (!published && fs.existsSync(source)) fs.rmSync(source, { recursive: true, force: true });
      if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
    }
  } catch (error) {
    const code = error.code || "PACK_INSTALL_FAILED";
    try {
      report("error", error.message, { error: { code, name: error.name, message: error.message } });
    } catch (statusError) {
      console.error(`Could not write pack status: ${statusError.message}`);
    }
    throw error;
  }
}

main().catch(error => {
  console.error(`${error.code || "PACK_INSTALL_FAILED"}: ${error.message}`);
  process.exitCode = 1;
});

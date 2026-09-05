// aria — sample pack 목록·설치 상태와 비동기 설치 실행.
//
// 실제 다운로드·검증·원자적 공개는 source 종류별 installer가 담당한다. 이 모듈은
// 웹 UI가 그 상태를 읽고 설치를 시작할 수 있게 하는 얇은 경계일 뿐이며, 다른 팩이나
// 비슷한 이름의 디렉터리를 자동으로 대신 고르지 않는다.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_DIR = path.join(ROOT, "packs");
const INSTALLERS = Object.freeze({
  git: path.join(ROOT, "tools", "install-pack.mjs"),
  "prepared-archive": path.join(ROOT, "tools", "install-prepared-pack.mjs")
});
export const PACK_HOME = path.resolve(process.env.ARIA_PACKS_DIR || process.env.ARIA_PACK_HOME ||
  path.join(os.homedir(), ".aria", "packs"));

const running = new Map();
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");

function safeId(id) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(id))
    throw new Error("음원 팩 ID가 올바르지 않습니다");
  return id;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function loadManifestRecord(id) {
  safeId(id);
  const file = path.join(MANIFEST_DIR, `${id}.json`);
  let raw;
  try { raw = fs.readFileSync(file); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`등록되지 않은 음원 팩입니다: ${id}`);
    throw error;
  }
  let manifest;
  try { manifest = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error(`음원 팩 manifest가 손상됐습니다: ${id}`); }
  if (manifest?.id !== id || typeof manifest.installDir !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.installDir))
    throw new Error(`음원 팩 manifest의 ID 또는 설치 경로가 올바르지 않습니다: ${id}`);
  return { manifest, raw, file };
}

function manifestRecords() {
  let names = [];
  try { names = fs.readdirSync(MANIFEST_DIR).filter(name => /^[a-z0-9][a-z0-9._-]*\.json$/.test(name)); }
  catch { return []; }
  return names.sort().map(name => loadManifestRecord(name.slice(0, -5)));
}

export function installerForPackManifest(manifest) {
  const installer = INSTALLERS[manifest?.source?.type];
  if (!installer)
    throw new Error(`지원하지 않는 음원 팩 source 형식입니다: ${manifest?.source?.type ?? "(없음)"}`);
  return installer;
}

function metadataMatches(record, metadata) {
  const { manifest, raw } = record;
  return metadata?.schemaVersion === 1 && metadata.packId === manifest.id &&
    metadata.name === manifest.name && metadata.format === manifest.format &&
    metadata.installDir === manifest.installDir &&
    metadata.manifestSha256 === sha256(raw) &&
    metadata.source?.type === manifest.source?.type &&
    metadata.source?.repositoryUrl === manifest.source?.repositoryUrl &&
    metadata.source?.branch === manifest.source?.branch &&
    metadata.source?.commit === manifest.source?.commit &&
    metadata.source?.tree === manifest.source?.tree &&
    metadata.license?.spdx === manifest.license?.spdx &&
    metadata.license?.file === manifest.license?.file &&
    metadata.license?.sha256 === manifest.license?.sha256;
}

function packView(record) {
  const { manifest } = record;
  const target = path.join(PACK_HOME, manifest.installDir);
  const metadata = readJson(path.join(target, ".aria-pack.json"));
  const status = readJson(path.join(PACK_HOME, ".status", `${manifest.id}.json`));
  let managed = false, hasDirectory = false, hasGit = false;
  try {
    const stat = fs.lstatSync(target);
    hasDirectory = stat.isDirectory() && !stat.isSymbolicLink();
    hasGit = hasDirectory && fs.existsSync(path.join(target, ".git"));
    managed = hasDirectory && !hasGit && metadataMatches(record, metadata);
  } catch { /* 미설치 */ }

  const active = running.get(manifest.id);
  let state = managed ? "ready" : hasGit ? "unmanaged" : hasDirectory ? "invalid" : "missing";
  let message = managed ? "설치됨" : hasGit ? "검증 전 원본 폴더" : hasDirectory ?
    "설치 정보가 맞지 않음" : "미설치";
  if (active) {
    state = status?.state ?? "starting";
    message = status?.message ?? "설치를 시작합니다";
  } else if (!managed && status?.state === "error") {
    state = "error";
    message = status.message ?? status.error?.message ?? "설치 실패";
  }

  return {
    id: manifest.id,
    name: manifest.name,
    format: manifest.format,
    state,
    message,
    installed: managed,
    installing: Boolean(active),
    target,
    sourceUrl: manifest.source?.projectUrl ?? manifest.source?.repositoryUrl ?? null,
    releaseUrl: manifest.source?.releaseUrl ?? null,
    archiveUrl: manifest.source?.downloadUrl ?? null,
    license: manifest.license ? {
      spdx: manifest.license.spdx ?? null,
      name: manifest.license.name ?? null,
      url: manifest.license.url ?? null
    } : null,
    entries: manifest.content?.entryFiles?.length ?? manifest.catalog?.length ?? 0,
    audioFiles: manifest.content?.expectedAudioFiles ?? null,
    installedBytes: managed ? metadata.verification?.totalBytes ?? null : null,
    status: active || status ? {
      state: status?.state ?? state,
      message: status?.message ?? message,
      updatedAt: status?.updatedAt ?? null,
      error: status?.error ?? null
    } : null
  };
}

export function listPacks() { return manifestRecords().map(packView); }

export function startPackInstall(id, { archive } = {}) {
  const record = loadManifestRecord(safeId(id));
  const installer = installerForPackManifest(record.manifest);
  if (archive !== undefined && (record.manifest.source.type !== "prepared-archive" ||
      typeof archive !== "string" || !path.isAbsolute(archive) || !fs.statSync(archive).isFile()))
    throw new Error("공식 사이트에서 받은 음원 압축파일을 선택해 주세요");
  const current = packView(record);
  if (current.installed || current.installing) return current;
  if (current.state === "unmanaged")
    throw new Error("이 팩은 원본 Git 폴더로 이미 존재합니다. 먼저 관리형 팩으로 검증·전환해야 합니다");

  fs.mkdirSync(path.join(PACK_HOME, ".logs"), { recursive: true });
  const logFile = path.join(PACK_HOME, ".logs", `${id}.log`);
  const fd = fs.openSync(logFile, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [installer, id, ...(archive ? ["--archive", archive] : [])], {
      cwd: ROOT,
      env: { ...process.env, ARIA_PACKS_DIR: PACK_HOME },
      stdio: ["ignore", fd, fd]
    });
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  const run = { pid: child.pid, startedAt: Date.now(), logFile };
  running.set(id, run);
  child.once("error", () => {
    if (running.get(id) === run) running.delete(id);
    try { fs.closeSync(fd); } catch { /* 이미 닫힘 */ }
  });
  child.once("exit", () => {
    if (running.get(id) === run) running.delete(id);
    try { fs.closeSync(fd); } catch { /* 이미 닫힘 */ }
  });
  child.unref();
  return { ...packView(record), installing: true, state: "starting", message: "설치를 시작합니다" };
}

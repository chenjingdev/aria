// aria — 실행 중인 GUI를 MCP 브리지가 찾기 위한 런타임 정보
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = process.env.ARIA_DATA_DIR || path.join(os.homedir(), ".aria");

export const RUNTIME_FILE = process.env.ARIA_RUNTIME_FILE || path.join(DATA_DIR, "runtime.json");
export const PREFERRED_PORT = (() => {
  const n = Number(process.env.ARIA_PORT ?? 7788);
  return Number.isInteger(n) && n >= 1024 && n <= 65515 ? n : 7788;
})();
export const PORT_ATTEMPTS = 21;

function loopbackUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return null;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

export function readRuntime(file = RUNTIME_FILE) {
  const data = readJson(file);
  const baseUrl = loopbackUrl(data?.baseUrl);
  if (data?.schema !== 1 || data?.app !== "aria" || !baseUrl || typeof data.instanceId !== "string") return null;
  return {
    schema: 1,
    app: "aria",
    pid: Number(data.pid),
    instanceId: data.instanceId,
    baseUrl,
    startedAt: data.startedAt,
    bridgeToken: typeof data.bridgeToken === "string" ? data.bridgeToken : null
  };
}

export function createRuntimeIdentity() {
  return {
    schema: 1,
    app: "aria",
    pid: process.pid,
    instanceId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    bridgeToken: crypto.randomBytes(32).toString("hex")
  };
}

export function publishRuntime(info, file = RUNTIME_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 일부 파일시스템은 chmod를 지원하지 않는다 */ }
}

async function fetchJson(url, timeoutMs = 400) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) return { kind: "http", status: response.status };
    try { return { kind: "ok", value: await response.json() }; }
    catch { return { kind: "invalid-json" }; }
  } catch (error) {
    return { kind: error.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

async function probeAriaStatus(baseUrl, { legacy = true } = {}) {
  const safeUrl = loopbackUrl(baseUrl);
  if (!safeUrl) return { kind: "invalid-url" };

  const health = await fetchJson(`${safeUrl}/api/health`);
  if (health.kind === "ok" && health.value?.app === "aria" && health.value?.schema === 1
    && typeof health.value.instanceId === "string") {
    return { kind: "aria", value: {
      schema: 1,
      app: "aria",
      pid: Number(health.value.pid),
      instanceId: health.value.instanceId,
      baseUrl: safeUrl,
      startedAt: health.value.startedAt,
      legacy: false
    } };
  }
  if (health.kind === "timeout" || health.kind === "network") return health;

  // 이 패치 이전부터 떠 있던 Aria도 재시작 없이 이어서 쓸 수 있게 한시적으로 식별한다.
  if (legacy) {
    const meta = await fetchJson(`${safeUrl}/api/meta`);
    if (meta.kind === "ok" && meta.value?.presets && meta.value?.drumKits && meta.value?.templates) {
      return { kind: "aria", value: { app: "aria", baseUrl: safeUrl, legacy: true } };
    }
    if (meta.kind === "timeout" || meta.kind === "network") return meta;
  }
  return { kind: "not-aria" };
}

export async function probeAria(baseUrl, options = {}) {
  const status = await probeAriaStatus(baseUrl, options);
  return status.kind === "aria" ? status.value : null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

export async function discoverAria({ scan = process.env.ARIA_SCAN !== "0", runtimeFile = RUNTIME_FILE } = {}) {
  const descriptor = readRuntime(runtimeFile);
  const explicit = process.env.ARIA_BASE_URL || process.env.ARIA_URL;
  if (explicit) {
    const status = await probeAriaStatus(explicit);
    if (status.kind === "aria") {
      const live = status.value;
      const sameDescriptor = descriptor
        && live.baseUrl === descriptor.baseUrl
        && live.instanceId === descriptor.instanceId
        && live.pid === descriptor.pid;
      return sameDescriptor ? { ...live, bridgeToken: descriptor.bridgeToken } : live;
    }
    if (status.kind === "timeout" || status.kind === "network") {
      const baseUrl = loopbackUrl(explicit);
      if (baseUrl) return { app: "aria", baseUrl, temporarilyUnverified: true };
    }
  }

  if (descriptor) {
    const status = await probeAriaStatus(descriptor.baseUrl, { legacy: false });
    const live = status.kind === "aria" ? status.value : null;
    if (live && live.instanceId === descriptor.instanceId && live.pid === descriptor.pid) {
      return { ...live, bridgeToken: descriptor.bridgeToken };
    }
    if (status.kind === "timeout" && pidAlive(descriptor.pid)) {
      // play/export처럼 동기 렌더가 도는 동안에는 GUI 이벤트 루프가 health 응답을 잠시 못 한다.
      // 살아 있는 본체를 죽었다고 오판해 두 번째 GUI를 띄우는 것보다 기존 요청을 기다리는 편이 안전하다.
      return { ...descriptor, legacy: false, temporarilyUnverified: true };
    }
    if (live) return live;
  }

  if (!scan) return null;
  const candidates = Array.from({ length: PORT_ATTEMPTS }, (_, i) => `http://127.0.0.1:${PREFERRED_PORT + i}`);
  const found = await Promise.all(candidates.map(url => probeAria(url)));
  return found.find(Boolean) ?? null;
}

export async function waitForAria(timeoutMs = 8000, options = {}) {
  const until = Date.now() + timeoutMs;
  do {
    const live = await discoverAria(options);
    if (live) return live;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  return null;
}

const START_LOCK = `${RUNTIME_FILE}.start-lock`;

function inspectLegacyLock(file) {
  try {
    const owner = readJson(file);
    const ownerPid = Number(owner?.pid);
    const validOwner = Number.isInteger(ownerPid) && ownerPid > 0;
    const age = Date.now() - fs.statSync(file).mtimeMs;
    return {
      missing: false,
      abandoned: validOwner ? !pidAlive(ownerPid) : age > 15000
    };
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true, abandoned: false };
    throw error;
  }
}

function removeUniqueFile(file) {
  try { fs.unlinkSync(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function cleanupLegacyLocks(file) {
  const dir = path.dirname(file);
  const reclaimPrefix = `${path.basename(file)}.reclaim.`;
  const partialPrefix = ".aria-lock-candidate-";
  let liveRecovery = false;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(reclaimPrefix) && !name.startsWith(partialPrefix)) continue;
    const candidate = path.join(dir, name);
    try {
      const owner = readJson(candidate);
      const ownerPid = Number(owner?.pid ?? name.slice(partialPrefix.length).split("-")[0]);
      const age = Date.now() - fs.statSync(candidate).mtimeMs;
      const validPid = Number.isInteger(ownerPid) && ownerPid > 0;
      const alive = validPid && pidAlive(ownerPid);
      if (alive && name.startsWith(reclaimPrefix)) liveRecovery = true;
      else if (!alive && (validPid || age > 15000)) removeUniqueFile(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return liveRecovery;
}

function ownerPrefix(file) {
  return `${path.basename(file)}.owner.`;
}

function parseOwnerName(file, name) {
  const prefix = ownerPrefix(file);
  if (!name.startsWith(prefix)) return null;
  const suffix = name.slice(prefix.length);
  const split = suffix.indexOf(".");
  if (split < 1) return null;
  const pid = Number(suffix.slice(0, split));
  const token = suffix.slice(split + 1);
  if (!Number.isInteger(pid) || pid <= 0 || !token) return null;
  return { pid, token };
}

function liveOwners(file) {
  const dir = path.dirname(file);
  const owners = [];
  for (const name of fs.readdirSync(dir)) {
    const parsed = parseOwnerName(file, name);
    if (!parsed) continue;
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate, { bigint: true });
      if (!pidAlive(parsed.pid)) {
        // UUID 경로는 다시 쓰이지 않으므로 죽은 후보만 정확히 지운다.
        removeUniqueFile(candidate);
        continue;
      }
      owners.push({ file: candidate, ...parsed, born: stat.birthtimeNs, ino: stat.ino });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return owners.sort((a, b) => {
    if (a.born !== b.born) return a.born < b.born ? -1 : 1;
    if (a.ino !== b.ino) return a.ino < b.ino ? -1 : 1;
    return a.file.localeCompare(b.file);
  });
}

function createOwnerCandidate(file, token) {
  const candidate = `${file}.owner.${process.pid}.${token}`;
  // 경로가 생긴 시점이 곧 선거 순서다. 다른 프로세스가 쓰기 중 파일을 보더라도
  // PID와 토큰은 파일명에 있어 안전하게 대기하며, 작성자는 선거 확인 뒤에만 성공한다.
  fs.writeFileSync(candidate, JSON.stringify({ pid: process.pid, token, at: Date.now() }), {
    flag: "wx",
    mode: 0o600
  });
  return { file: candidate, token, lockBase: file };
}

export function acquireStartLock(file = START_LOCK) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacy = inspectLegacyLock(file);
  if (!legacy.missing) {
    if (!legacy.abandoned) return null;
    // 새 구현은 이 중앙 경로를 다시 만들지 않는다. 이전 버전의 죽은 잠금만 한 번 회수한다.
    removeUniqueFile(file);
  }
  if (cleanupLegacyLocks(file)) return null;

  const lock = createOwnerCandidate(file, crypto.randomUUID());
  const winner = liveOwners(file)[0];
  if (winner?.file === lock.file) return lock;
  removeUniqueFile(lock.file);
  return null;
}

export function releaseStartLock(lock) {
  if (!lock) return;
  const current = readJson(lock.file);
  if (current?.token !== lock.token) return;
  removeUniqueFile(lock.file);
}

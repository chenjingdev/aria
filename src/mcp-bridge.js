#!/usr/bin/env node
// aria — 상태를 갖지 않는 stdio MCP 브리지. 실행 중인 GUI의 HTTP API만 전달한다.
import "./session-data-dir.js"; // ARIA_DATA_DIR_PER_SESSION — 다른 import 보다 먼저 env 를 손본다
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMcp, TOOL_NAMES } from "./mcp.js";
import {
  discoverAria,
  waitForAria
} from "./runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUI_ENTRY = path.join(__dirname, "index.js");

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = value => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopCandidate(child) {
  if (!child || exited(child)) return;
  try { child.kill("SIGTERM"); } catch { return; }
  if (!await waitForExit(child, 800) && !exited(child)) {
    try { child.kill("SIGKILL"); } catch { return; }
    await waitForExit(child, 500);
  }
}

async function ensureAria() {
  const running = await discoverAria();
  if (running) return running;

  if (process.env.ARIA_AUTOSTART === "0") {
    throw new Error("실행 중인 Aria 앱을 찾지 못했습니다. Aria에서 npm start를 먼저 실행해 주세요.");
  }

  // 브리지가 GUI 대신 잠금을 들면 spawn 직후 브리지 사망 시 보호가 끊긴다.
  // GUI 후보가 직접 시작 잠금을 얻도록 하고, 동시에 여러 후보가 생겨도 하나만 본체가 된다.
  const child = spawn(process.execPath, [GUI_ENTRY], {
    cwd: path.dirname(__dirname),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ARIA_AUTOSTART: "0" }
  });
  const spawnFailure = new Promise((_, reject) => child.once("error", reject));

  let started;
  try {
    started = await Promise.race([waitForAria(10000), spawnFailure]);
    if (!started) throw new Error("Aria 앱을 자동으로 시작했지만 연결되지 않았습니다. npm start로 직접 실행해 주세요.");

    // 동시에 뜬 다른 후보가 본체가 됐다면 이 브리지가 만든 후보는 반드시 정리한다.
    // 늦게 스케줄된 후보가 브리지 종료 뒤 다시 살아나는 고아 프로세스를 막는다.
    if (!Number.isInteger(started.pid) || started.pid !== child.pid) {
      await stopCandidate(child);
    }
    return started;
  } catch (error) {
    await stopCandidate(child);
    throw error;
  } finally {
    child.unref();
  }
}

async function callGui(name, args) {
  const target = await ensureAria();
  if (name === "export" && args?.path && !target.bridgeToken) {
    throw new Error("지정 경로 내보내기는 최신 Aria 앱 연결이 필요합니다. Aria를 한 번 재시작해 주세요.");
  }
  const headers = { "Content-Type": "application/json" };
  if (target.bridgeToken) headers.Authorization = `Bearer ${target.bridgeToken}`;

  let response;
  try {
    response = await fetch(`${target.baseUrl}/api/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool: name, args })
    });
  } catch (error) {
    // 변경 요청은 서버에서 적용된 뒤 응답만 끊겼을 수도 있으므로 자동 재시도하지 않는다.
    throw new Error(`Aria 앱 연결이 끊겼습니다 (${target.baseUrl}): ${error.message}`);
  }

  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); }
  catch { throw new Error(`Aria 앱이 올바르지 않은 응답을 보냈습니다 (HTTP ${response.status})`); }

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `Aria 앱 요청 실패 (HTTP ${response.status})`);
  }
  return payload.result;
}

// ARIA_HIDE_TOOLS: 이 브리지가 노출하지 않을 도구 이름(쉼표·공백 구분). 벤치 프로필처럼 사람과의 협업 루프가
// 없는 자리에서 쓴다. 앱의 능력은 그대로고, 도구 목록과 안내문에서만 함께 사라진다.
function hiddenTools() {
  const names = (process.env.ARIA_HIDE_TOOLS ?? "").split(/[\s,]+/).filter(Boolean);
  const unknown = names.filter(name => !TOOL_NAMES.includes(name));
  if (unknown.length) {
    console.error(`[aria] ARIA_HIDE_TOOLS에 모르는 도구 이름이 있습니다: ${unknown.join(", ")}`);
    console.error(`[aria] 도구 이름: ${TOOL_NAMES.join(", ")}`);
    process.exit(1);
  }
  return names;
}

const { server } = await startMcp(callGui, { hide: hiddenTools() });
let closing = false;

async function shutdown(exit = false) {
  if (closing) return;
  closing = true;
  try { await server.close(); } catch { /* 이미 닫힌 transport */ }
  if (exit) process.exit(0);
}

process.stdin.once("end", () => { void shutdown(); });
process.stdin.once("close", () => { void shutdown(); });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void shutdown(true); });
}

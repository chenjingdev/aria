// aria — GUI 한 인스턴스와 stdio MCP 브리지가 같은 상태를 보는지 검증
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestSoundfonts } from "./soundfont-fixture.js";

const soundfonts = createTestSoundfonts("aria-mcp-sf2");
process.env.ARIA_SF2 = soundfonts.defaultPath;
const dataDir = path.join(os.tmpdir(), `aria-mcp-test-${process.pid}-${Date.now()}`);
const runtimeFile = path.join(dataDir, "runtime.json");
process.env.ARIA_DATA_DIR = dataDir;
process.env.ARIA_RUNTIME_FILE = runtimeFile;
process.env.ARIA_SCAN = "0";

const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
const close = server => new Promise(resolve => {
  if (!server?.listening) return resolve();
  server.close(() => resolve());
  server.closeAllConnections?.();
});

let blocker;
let busyServer;
let web;
let client;
let client2;
let autoGuiPid = null;
let raceChildren = [];
let occupiedPort = null;
let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed++; console.log(`  ✓ ${message}`); };

async function ariaInstances(startPort) {
  if (!Number.isInteger(startPort)) return [];
  const results = await Promise.all(Array.from({ length: 21 }, async (_, offset) => {
    const baseUrl = `http://127.0.0.1:${startPort + offset}`;
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(400) });
      const health = await response.json();
      return response.ok && health?.app === "aria" ? { ...health, baseUrl } : null;
    } catch { return null; }
  }));
  return results.filter(Boolean);
}

async function stopTestAriaInstances(startPort) {
  for (let round = 0; round < 5; round++) {
    const instances = (await ariaInstances(startPort)).filter(instance => instance.pid !== process.pid);
    if (!instances.length) return;
    for (const instance of instances) {
      try { process.kill(instance.pid, "SIGTERM"); } catch { /* 이미 종료됨 */ }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

console.log("aria MCP 브리지 테스트");

try {
  // 선호 포트를 다른 앱이 차지한 상황을 만든다.
  blocker = http.createServer((_req, res) => { res.writeHead(200); res.end("다른 앱"); });
  await listen(blocker);
  occupiedPort = blocker.address().port;
  assert.ok(occupiedPort <= 65515, `테스트 포트가 너무 높음: ${occupiedPort}`);
  process.env.ARIA_PORT = String(occupiedPort);

  const runtime = await import("../src/runtime.js");
  const { state } = await import("../src/core.js");
  const { startWeb } = await import("../src/web.js");
  web = await startWeb();

  ok(web.port !== occupiedPort, "7788 역할의 선호 포트가 겹치면 다음 빈 포트로 이동");
  const descriptor = runtime.readRuntime();
  ok(descriptor?.baseUrl === web.url && descriptor?.instanceId === web.instanceId,
    "실제 동적 포트와 인스턴스 ID를 runtime.json에 기록");

  const health = await fetch(`${web.url}/api/health`).then(r => r.json());
  ok(health.app === "aria" && health.instanceId === descriptor.instanceId,
    "health 응답으로 오래된 runtime.json과 현재 앱을 구분");

  const bridgePath = path.resolve("src/mcp-bridge.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgePath],
    cwd: path.resolve("."),
    stderr: "pipe",
    env: {
      ARIA_DATA_DIR: dataDir,
      ARIA_RUNTIME_FILE: runtimeFile,
      ARIA_AUTOSTART: "0",
      ARIA_SCAN: "0",
      ARIA_SF2: soundfonts.defaultPath
    }
  });
  client = new Client({ name: "aria-bridge-test", version: "1.0.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  ok(listed.tools.length === 45 && listed.tools.some(tool => tool.name === "new_song") &&
    listed.tools.some(tool => tool.name === "set_region_articulation"),
    "브리지가 구간 주법을 포함한 최신 MCP 도구 45개를 그대로 노출");

  // 벤치 프로필처럼 사람과의 협업 루프가 없는 자리: 브리지 env로 도구를 숨기면 목록·안내문에서 함께 빠져야 한다.
  const hiddenNames = ["list_feedback", "resolve_feedback", "add_feedback", "ab_save", "ab_load", "list_songs", "load_song", "import_midi"];
  const hiddenTransport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgePath],
    cwd: path.resolve("."),
    stderr: "pipe",
    env: {
      ARIA_DATA_DIR: dataDir,
      ARIA_RUNTIME_FILE: runtimeFile,
      ARIA_AUTOSTART: "0",
      ARIA_SCAN: "0",
      ARIA_SF2: soundfonts.defaultPath,
      ARIA_HIDE_TOOLS: hiddenNames.join(",")
    }
  });
  const hiddenClient = new Client({ name: "aria-bridge-hide-test", version: "1.0.0" });
  await hiddenClient.connect(hiddenTransport);
  const hiddenList = await hiddenClient.listTools();
  const hiddenInstructions = hiddenClient.getInstructions() ?? "";
  const mentionsTool = (text, name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);
  ok(hiddenList.tools.length === 45 - hiddenNames.length
    && hiddenList.tools.every(tool => !hiddenNames.includes(tool.name))
    && hiddenNames.every(name => !mentionsTool(hiddenInstructions, name))
    && hiddenInstructions.includes("save_song"),
    "ARIA_HIDE_TOOLS로 숨긴 도구는 브리지의 도구 목록과 안내문에서 함께 빠짐");
  const hiddenCall = await hiddenClient.callTool({ name: "list_feedback", arguments: {} })
    .catch(error => ({ isError: true, message: error.message }));
  ok(hiddenCall.isError, "숨긴 도구는 브리지를 통해 호출할 수 없음");
  await hiddenClient.close();

  const badBridge = spawn(process.execPath, [bridgePath], {
    cwd: path.resolve("."),
    env: { ...process.env, ARIA_AUTOSTART: "0", ARIA_HIDE_TOOLS: "list_feedback nope_tool" },
    stdio: ["pipe", "ignore", "pipe"]
  });
  let badStderr = "";
  badBridge.stderr.on("data", chunk => { badStderr += chunk; });
  const badExit = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 8000);
    badBridge.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  if (badExit === null) try { badBridge.kill("SIGKILL"); } catch { /* noop */ }
  // 첫 줄은 모르는 이름만 나열해야 한다(list_feedback은 실제 도구라 거기 없어야 함). 둘째 줄의 전체 도구 목록은 무관.
  ok(badExit === 1 && /모르는 도구 이름이 있습니다: nope_tool$/m.test(badStderr),
    "ARIA_HIDE_TOOLS에 모르는 도구 이름이 있으면 브리지가 그 이름을 알리고 종료");

  const created = await client.callTool({
    name: "new_song",
    arguments: { title: "브리지 공유 상태", bpm: 101, template: "citypop" }
  });
  ok(!created.isError && state.song?.title === "브리지 공유 상태" && state.song?.bpm === 101,
    "MCP 편집이 별도 상태가 아니라 GUI 본체 상태를 변경");

  const direct = await fetch(`${web.url}/api/rpc`, {
    method: "POST",
    body: JSON.stringify({ tool: "get_song", args: {} })
  }).then(r => r.json());
  const throughMcp = await client.callTool({ name: "get_song", arguments: {} });
  ok(direct.ok && throughMcp.content?.[0]?.text === direct.result,
    "GUI HTTP와 MCP가 같은 곡 및 같은 GUI 주소를 조회");
  ok(state.log.some(entry => entry.source === "mcp" && entry.text.includes("new_song")),
    "인증된 브리지 요청을 GUI 요청과 구분해 기록");

  const exportBase = path.join(dataDir, "bridge-export");
  const noteAdded = await client.callTool({
    name: "add_notes",
    arguments: { track: "Drums", notes: [{ bar: 1, beat: 0, pitch: "kick", dur: 0.25, vel: 100 }] }
  });
  assert.ok(!noteAdded.isError, "내보내기 검증용 노트 추가 실패");
  const exported = await client.callTool({
    name: "export",
    arguments: { format: "midi", path: exportBase }
  });
  ok(!exported.isError && fs.existsSync(`${exportBase}.mid`),
    "인증된 MCP 브리지는 지정한 내보내기 경로 권한을 유지");
  const mp3Base = path.join(dataDir, "bridge-mp3");
  const mp3 = await client.callTool({
    name: "export",
    arguments: { format: "mp3", path: mp3Base, from_bar: 1, to_bar: 1 }
  });
  ok(!mp3.isError && fs.statSync(`${mp3Base}.mp3`).size > 1000 && !fs.existsSync(`${mp3Base}.mid`),
    "MCP가 MP3 형식과 구간을 전달하고 MP3 파일만 내보냄");

  const badAuth = await fetch(`${web.url}/api/rpc`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token" },
    body: JSON.stringify({ tool: "get_song", args: {} })
  });
  ok(badAuth.status === 401, "잘못된 MCP 브리지 토큰을 거부");

  const failed = await client.callTool({
    name: "set_track",
    arguments: { track: "없는 트랙", volume: 0.5 }
  });
  ok(failed.isError === true && failed.content?.[0]?.text.includes("오류:"),
    "GUI 연산 오류를 MCP 오류 결과로 전달");

  const raceFile = path.join(dataDir, "runtime-race.json");
  const a = { ...descriptor, instanceId: "A", bridgeToken: "a" };
  const b = { ...descriptor, instanceId: "B", bridgeToken: "b" };
  runtime.publishRuntime(a, raceFile);
  runtime.publishRuntime(b, raceFile);
  ok(runtime.readRuntime(raceFile)?.instanceId === "B",
    "새 인스턴스가 runtime.json을 원자적으로 교체");
  fs.unlinkSync(raceFile);

  busyServer = http.createServer((_req, _res) => { /* 긴 동기 렌더처럼 health 응답이 늦는 상황 */ });
  await listen(busyServer);
  const busyFile = path.join(dataDir, "runtime-busy.json");
  const busyDescriptor = {
    ...descriptor,
    pid: process.pid,
    instanceId: "busy",
    baseUrl: `http://127.0.0.1:${busyServer.address().port}`
  };
  runtime.publishRuntime(busyDescriptor, busyFile);
  const busyResult = await runtime.discoverAria({ scan: false, runtimeFile: busyFile });
  ok(busyResult?.instanceId === "busy" && fs.existsSync(busyFile),
    "렌더링 중 health 지연을 앱 종료로 오판해 새 GUI를 만들지 않음");
  fs.unlinkSync(busyFile);
  await close(busyServer);
  busyServer = null;

  const lockFile = path.join(dataDir, "live.start-lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "live" }), { mode: 0o600 });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile, old, old);
  ok(runtime.acquireStartLock(lockFile) === null && fs.existsSync(lockFile),
    "오래 걸려도 소유 프로세스가 살아 있는 시작 잠금은 빼앗지 않음");
  fs.unlinkSync(lockFile);

  fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999999, token: "dead" }), { mode: 0o600 });
  const recoveredLock = runtime.acquireStartLock(lockFile);
  const recoveredData = JSON.parse(fs.readFileSync(recoveredLock.file, "utf8"));
  const ownerFiles = fs.readdirSync(dataDir)
    .filter(name => name.startsWith(`${path.basename(lockFile)}.owner.`));
  ok(Boolean(recoveredLock) && recoveredData.pid === process.pid && ownerFiles.length === 1
    && !fs.existsSync(lockFile),
  "종료된 중앙 잠금은 고유한 생존 후보 선거로 안전하게 회수");
  runtime.releaseStartLock(recoveredLock);

  const bridgePid = transport.pid;
  const closeStarted = Date.now();
  await client.close();
  client = null;
  ok(Date.now() - closeStarted < 1500, "MCP 연결 종료 시 브리지 프로세스가 즉시 종료");
  if (bridgePid) {
    let alive = true;
    try { process.kill(bridgePid, 0); } catch { alive = false; }
    ok(!alive, "닫힌 MCP 브리지가 잔류 프로세스로 남지 않음");
  }

  await close(web.server);
  web = null;
  const stoppedWeb = await runtime.discoverAria({ scan: false, runtimeFile });
  ok(fs.existsSync(runtimeFile) && stoppedWeb === null,
    "GUI 종료 뒤 남은 실행정보는 삭제 경쟁 없이 stale로 판별");

  // 앱이 아예 없을 때는 브리지가 GUI 본체를 별도 상주 프로세스로 한 번만 시작한다.
  await close(blocker);
  blocker = null;
  const autoRuntimeFile = path.join(dataDir, "auto-runtime.json");
  const autoTransport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgePath],
    cwd: path.resolve("."),
    stderr: "pipe",
    env: {
      ARIA_DATA_DIR: path.join(dataDir, "auto-data"),
      ARIA_RUNTIME_FILE: autoRuntimeFile,
      ARIA_PORT: String(occupiedPort),
      ARIA_SCAN: "0",
      ARIA_SF2: soundfonts.defaultPath
    }
  });
  const autoTransport2 = new StdioClientTransport({
    command: process.execPath,
    args: [bridgePath],
    cwd: path.resolve("."),
    stderr: "pipe",
    env: {
      ARIA_DATA_DIR: path.join(dataDir, "auto-data"),
      ARIA_RUNTIME_FILE: autoRuntimeFile,
      ARIA_PORT: String(occupiedPort),
      ARIA_SCAN: "0",
      ARIA_SF2: soundfonts.defaultPath
    }
  });
  client = new Client({ name: "aria-autostart-test", version: "1.0.0" });
  client2 = new Client({ name: "aria-autostart-test-2", version: "1.0.0" });
  await Promise.all([client.connect(autoTransport), client2.connect(autoTransport2)]);
  const [history, history2] = await Promise.all([
    client.callTool({ name: "edit_history", arguments: {} }),
    client2.callTool({ name: "edit_history", arguments: {} })
  ]);
  const autoDescriptor = runtime.readRuntime(autoRuntimeFile);
  autoGuiPid = autoDescriptor?.pid;
  const autoInstances = await ariaInstances(occupiedPort);
  ok(!history.isError && !history2.isError && autoInstances.length === 1
    && autoInstances[0].pid === autoDescriptor?.pid
    && autoDescriptor?.baseUrl === `http://127.0.0.1:${occupiedPort}`,
  "두 브리지가 동시에 자동 시작해도 GUI가 자기 잠금으로 본체 하나만 만듦");

  await Promise.all([client.close(), client2.close()]);
  client = null;
  client2 = null;
  const stillHealthy = await fetch(`${autoDescriptor.baseUrl}/api/health`).then(r => r.ok).catch(() => false);
  ok(stillHealthy, "MCP 연결이 닫혀도 GUI 본체와 곡 상태는 계속 유지");

  process.kill(autoGuiPid, "SIGTERM");
  for (let i = 0; i < 40; i++) {
    try { process.kill(autoGuiPid, 0); await new Promise(resolve => setTimeout(resolve, 50)); }
    catch { autoGuiPid = null; break; }
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  const stoppedAuto = await runtime.discoverAria({ scan: false, runtimeFile: autoRuntimeFile });
  const revivedInstances = await ariaInstances(occupiedPort);
  ok(autoGuiPid === null && fs.existsSync(autoRuntimeFile) && stoppedAuto === null && revivedInstances.length === 0,
    "자동 시작한 GUI 종료 뒤 지연 후보가 되살아나지 않고 stale 실행정보를 무시");

  const singletonRuntime = path.join(dataDir, "singleton-runtime.json");
  const singletonEnv = {
    ...process.env,
    ARIA_DATA_DIR: path.join(dataDir, "singleton-data"),
    ARIA_RUNTIME_FILE: singletonRuntime,
    ARIA_PORT: String(occupiedPort),
    ARIA_SCAN: "0",
    ARIA_AUTOSTART: "0"
  };
  const indexPath = path.resolve("src/index.js");
  const launchGui = () => spawn(process.execPath, [indexPath], {
    cwd: path.resolve("."), env: singletonEnv, stdio: "ignore"
  });
  fs.writeFileSync(`${singletonRuntime}.start-lock`, JSON.stringify({ pid: 99999999, token: "dead-race" }), { mode: 0o600 });
  fs.writeFileSync(`${singletonRuntime}.start-lock.reclaim.99999999.crashed`,
    JSON.stringify({ pid: 99999999, token: "dead-reclaimer" }), { mode: 0o600 });
  raceChildren = [launchGui(), launchGui()];

  let singletonDescriptor = null;
  for (let i = 0; i < 80; i++) {
    singletonDescriptor = runtime.readRuntime(singletonRuntime);
    if (singletonDescriptor) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  const raceSurvivors = raceChildren.filter(child => child.exitCode === null);
  ok(singletonDescriptor && raceSurvivors.length === 1 && raceSurvivors[0].pid === singletonDescriptor.pid,
    "죽은 잠금 회수와 GUI 동시 시작이 겹쳐도 본체 하나만 남김");

  for (const child of raceSurvivors) child.kill("SIGTERM");
  for (let i = 0; i < 40 && raceChildren.some(child => child.exitCode === null); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const leftoverRecovery = fs.readdirSync(dataDir).some(name => name.startsWith("singleton-runtime.json.start-lock.reclaim."));
  const stoppedSingleton = await runtime.discoverAria({ scan: false, runtimeFile: singletonRuntime });
  ok(raceChildren.every(child => child.exitCode !== null) && stoppedSingleton === null && !leftoverRecovery,
    "중단된 잠금 회수 흔적을 정리하고 종료된 GUI 실행정보를 무시");
  raceChildren = [];
} finally {
  try { await client?.close(); } catch { /* noop */ }
  try { await client2?.close(); } catch { /* noop */ }
  await close(busyServer);
  await close(web?.server);
  await close(blocker);
  if (autoGuiPid) {
    try { process.kill(autoGuiPid, "SIGTERM"); } catch { /* noop */ }
  }
  await stopTestAriaInstances(occupiedPort);
  for (const child of raceChildren) {
    if (child.exitCode === null) try { child.kill("SIGTERM"); } catch { /* noop */ }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  soundfonts.cleanup();
}

console.log(`통과 ${passed}건 — MCP 브리지 문제 없음`);

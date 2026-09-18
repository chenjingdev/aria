// A fresh install, a real stdio MCP bridge, and a separate HTTP app process.
// Only the native picker is substituted; parsing, installing, RPC, and audio
// rendering run normally. Generated CC0 fixtures never enter the user's data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestSoundfonts } from "./soundfont-fixture.js";

const testPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(testPath), "..");
const bridgePath = path.join(root, "src", "mcp-bridge.js");
const hidden = ["list_feedback", "resolve_feedback", "add_feedback", "ab_save", "ab_load", "list_songs", "load_song", "import_midi"];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes("--app-runner")) {
  assert.ok(process.send, "The app runner is a test-only IPC child");
  const { loadAutosave, flushAutosave } = await import("../src/core.js");
  const { startWeb } = await import("../src/web.js");
  loadAutosave();
  const app = await startWeb({ chooseSoundFile: async () => process.env.ARIA_TEST_PICKED_SF2 });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    flushAutosave();
    await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections?.(); });
    process.exit(0);
  };
  for (const event of ["SIGTERM", "SIGINT", "disconnect"]) process.once(event, () => { void shutdown(); });
  process.send({ type: "ready", url: app.url, instanceId: app.instanceId });
} else {
  await run();
}

async function run() {
  const fixture = createTestSoundfonts("aria-release-onboarding");
  const dataDir = path.join(fixture.root, "fresh-user-data");
  const soundDir = path.join(fixture.root, "fresh-soundfonts");
  const runtimeFile = path.join(dataDir, "runtime.json");
  const onboardingFile = path.join(dataDir, "onboarding.json");
  fs.mkdirSync(soundDir);
  // Preserve HOME/CODEX_HOME, but remove inherited Aria routing/profile settings
  // so even a developer shell cannot direct this test to a real running app.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ARIA_")));
  Object.assign(env, {
    ARIA_DATA_DIR: dataDir,
    ARIA_RUNTIME_FILE: runtimeFile,
    ARIA_SF2: path.join(soundDir, "default.sf2"),
    ARIA_PACKS_DIR: path.join(fixture.root, "fresh-packs"),
    ARIA_PACK_HOME: path.join(fixture.root, "fresh-packs"),
    ARIA_SFIZZ_ENGINE_HOME: path.join(fixture.root, "fresh-engine"),
    ARIA_SCAN: "0",
    ARIA_AUTOSTART: "0",
    ARIA_TEST_PICKED_SF2: fixture.defaultPath
  });
  const children = new Set();
  const bridges = new Set();
  let passed = 0;
  const ok = (condition, message) => { assert.ok(condition, message); passed++; console.log(`  ✓ ${message}`); };
  const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const stopChild = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await delay(25);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise(resolve => child.once("exit", resolve));
    }
  };

  const startApp = async () => {
    const child = spawn(process.execPath, [testPath, "--app-runner"], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    children.add(child);
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-20000); });
    const ready = await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.off("error", error); };
      const message = value => { if (value?.type === "ready") { cleanup(); resolve(value); } };
      const exit = code => { cleanup(); reject(new Error(`Test app exited ${code}: ${output}`)); };
      const error = err => { cleanup(); reject(err); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Test app startup timed out: ${output}`)); }, 15000);
      child.on("message", message); child.once("exit", exit); child.once("error", error);
    });
    return { child, ...ready };
  };

  const connect = async (extra = {}) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [bridgePath], cwd: root, stderr: "pipe", env: { ...env, ...extra } });
    const client = new Client({ name: "aria-release-onboarding-test", version: "1.0.0" });
    const connection = { client, transport, pid: null };
    bridges.add(connection);
    await client.connect(transport);
    connection.pid = transport.pid;
    return connection;
  };
  const disconnect = async connection => {
    await connection.client.close();
    for (let i = 0; i < 40 && connection.pid && isAlive(connection.pid); i++) await delay(25);
    assert.ok(!connection.pid || !isAlive(connection.pid), `MCP child ${connection.pid} did not exit`);
    bridges.delete(connection);
  };
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
    return result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  };
  const setup = async app => {
    const response = await fetch(`${app.url}/api/setup`, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const guiCall = async (app, tool, args = {}, headers = {}) => {
    const response = await fetch(`${app.url}/api/rpc`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ tool, args }), signal: AbortSignal.timeout(10000)
    });
    return { status: response.status, ...(await response.json()) };
  };
  const songFrom = text => JSON.parse(text.slice(text.indexOf("\n\n{") + 2));

  console.log("aria 공개 버전 첫 실행 통합 테스트");
  try {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    assert.ok(port >= 1024 && port <= 65515, `Cannot use test port ${port}`);
    env.ARIA_PORT = String(port);

    let app = await startApp();
    const initial = await setup(app);
    const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    ok(initial.version === version && initial.platform === process.platform && initial.ai.lastSeenAt === null,
      "새 앱은 버전·플랫폼과 아직 연결되지 않은 AI 상태를 표시");
    ok(initial.onboarding.completed === false && initial.onboarding.completedAt === null
      && !fs.existsSync(onboardingFile),
    "첫 실행의 안내 완료 상태는 음원·AI 상태와 별개로 미완료이며 완료 기록이 없음");
    const viewedAgain = await setup(app);
    ok(viewedAgain.onboarding.completed === false && viewedAgain.onboarding.completedAt === null
      && !fs.existsSync(onboardingFile),
    "시작 안내를 반복 조회해도 완료 처리하거나 기록을 만들지 않음");
    ok(initial.basic.available === 0 && initial.basic.ready === false && initial.basic.total > 0 && initial.sfizz.ready === false,
      "사용자 음원을 참조하지 않는 빈 환경에서 기본·추가 음원 미설치를 감지");
    ok(fs.realpathSync(initial.mcpConfig.mcpServers.aria.command) === fs.realpathSync(process.execPath)
      && initial.mcpConfig.mcpServers.aria.args.includes(bridgePath)
      && initial.commands.claude.includes(bridgePath) && initial.commands.codex.includes(bridgePath)
      && initial.firstPrompt.length > 0 && initial.verificationPrompt.includes("get_song"),
    "설치 위치에 맞는 Claude·Codex 연결 명령, MCP 설정과 첫 요청을 제공");
    ok(typeof initial.agentPrompt === "string" && initial.agentPrompt.includes(JSON.stringify(root))
      && initial.agentPrompt.includes(initial.commands.claude) && initial.agentPrompt.includes(initial.commands.codex)
      && initial.agentPrompt.includes(JSON.stringify(initial.mcpConfig, null, 2))
      && initial.agentPrompt.includes(initial.verificationPrompt),
    "AI에 넘길 연결 요청은 실제 설치 경로·클라이언트별 정확한 명령·MCP 설정·확인 요청을 포함");
    const guiEmpty = await guiCall(app, "get_song");
    ok(guiEmpty.ok && guiEmpty.result.includes(app.url) && (await setup(app)).ai.lastSeenAt === null,
      "곡 없는 첫 실행에서도 GUI의 get_song은 성공하며 AI 연결로 오인하지 않음");
    const badAuth = await guiCall(app, "get_song", {}, { Authorization: "Bearer not-the-test-token" });
    ok(badAuth.status === 401 && (await setup(app)).ai.lastSeenAt === null,
      "인증에 실패한 요청은 AI 연결 상태를 바꾸지 않음");

    const previewBefore = await fetch(`${app.url}/api/sound-setup/preview`, { method: "POST" });
    ok(previewBefore.status === 400, "음원 설치 전 미리듣기는 무음 파일 대신 설치 필요 오류를 반환");
    const importedResponse = await fetch(`${app.url}/api/sound-setup/import`, { method: "POST" });
    const imported = await importedResponse.json();
    ok(importedResponse.ok && imported.setup.basic.ready === true
      && fs.readFileSync(env.ARIA_SF2).equals(fs.readFileSync(fixture.defaultPath))
      && fs.readdirSync(soundDir).join(",") === "default.sf2",
    "파일 선택 뒤 원본 SF2를 실제로 검사·설치하고 추가 음원은 설치하지 않음");
    const installedSetup = await setup(app);
    ok(installedSetup.basic.ready && installedSetup.basic.available === installedSetup.basic.total && !installedSetup.sfizz.ready,
      "추가 엔진 없이 기본 음원만으로 시작 준비 완료");
    ok(installedSetup.onboarding.completed === false && installedSetup.onboarding.completedAt === null
      && !fs.existsSync(onboardingFile),
    "기본 음원 설치만으로 시작 안내를 완료 처리하지 않음");
    const previewResponse = await fetch(`${app.url}/api/sound-setup/preview`, { method: "POST" });
    const preview = Buffer.from(await previewResponse.arrayBuffer());
    assertAudibleWav(preview);
    ok(previewResponse.ok && previewResponse.headers.get("content-type") === "audio/wav",
      "설치 확인 버튼이 실제 음성 샘플이 있는 WAV를 반환");
    ok((await guiCall(app, "get_song")).result === guiEmpty.result,
      "설치와 피아노 미리듣기가 현재 곡을 만들거나 변경하지 않음");

    for (const headers of [
      { Origin: "https://example.com" },
      { Origin: app.url, "Sec-Fetch-Site": "cross-site" }
    ]) {
      const blocked = await fetch(`${app.url}/api/setup/complete`, {
        method: "POST", headers, signal: AbortSignal.timeout(10000)
      });
      assert.equal(blocked.status, 403);
    }
    ok((await setup(app)).onboarding.completed === false && !fs.existsSync(onboardingFile),
      "다른 출처의 안내 완료 요청은 Origin·브라우저 출처 헤더 모두에서 차단되고 기록을 남기지 않음");
    const completeGet = await fetch(`${app.url}/api/setup/complete`, { signal: AbortSignal.timeout(10000) });
    ok(completeGet.status === 404 && (await setup(app)).onboarding.completed === false && !fs.existsSync(onboardingFile),
      "완료 주소를 GET으로 조회해도 안내를 완료하지 않음");
    const completionResponse = await fetch(`${app.url}/api/setup/complete`, {
      method: "POST", headers: { Origin: app.url, "Sec-Fetch-Site": "same-origin" },
      signal: AbortSignal.timeout(10000)
    });
    const completion = await completionResponse.json();
    const completedSetup = await setup(app);
    const completionRecord = fs.readFileSync(onboardingFile, "utf8");
    const completionMtime = fs.statSync(onboardingFile).mtimeMs;
    ok(completionResponse.status === 200 && completion.ok && completion.onboarding.completed === true
      && Number.isFinite(Date.parse(completion.onboarding.completedAt))
      && completedSetup.onboarding.completedAt === completion.onboarding.completedAt
      && JSON.parse(completionRecord).completedAt === completion.onboarding.completedAt
      && completedSetup.ai.lastSeenAt === null,
    "같은 출처의 명시적 완료 요청은 영구 기록을 저장하며 아직 연결하지 않은 AI 상태는 그대로 유지");
    await delay(20);
    const repeatedResponse = await fetch(`${app.url}/api/setup/complete`, { method: "POST", signal: AbortSignal.timeout(10000) });
    const repeated = await repeatedResponse.json();
    assert.deepEqual(repeated.onboarding, completion.onboarding);
    ok(repeatedResponse.status === 200 && repeated.ok && fs.readFileSync(onboardingFile, "utf8") === completionRecord
      && fs.statSync(onboardingFile).mtimeMs === completionMtime && (await setup(app)).ai.lastSeenAt === null,
    "완료 요청을 반복해도 최초 완료 시각·파일·AI 상태를 바꾸지 않음");

    const release = await connect();
    const releaseList = (await release.client.listTools()).tools.map(tool => tool.name);
    ok(releaseList.length === 39 && hidden.every(name => !releaseList.includes(name))
      && release.client.getServerVersion().version === version,
    "기본 MCP 연결은 음원 선택을 포함한 39개 도구를 노출");
    const mcpEmpty = await call(release.client, "get_song");
    const linked = await setup(app);
    ok(mcpEmpty === guiEmpty.result && Number.isFinite(Date.parse(linked.ai.lastSeenAt)),
      "곡이 없어도 실제 MCP의 get_song 성공으로 AI 연결 확인을 완료");
    ok(linked.onboarding.completed === true && linked.onboarding.completedAt === completion.onboarding.completedAt
      && fs.readFileSync(onboardingFile, "utf8") === completionRecord,
    "실제 MCP 연결 성공은 AI 접속 상태만 갱신하고 안내 완료 기록은 유지");
    await guiCall(app, "get_song");
    ok((await setup(app)).ai.lastSeenAt === linked.ai.lastSeenAt,
      "연결 후 일반 GUI 조회는 마지막 AI 접속 시각을 갱신하지 않음");
    for (const name of hidden) {
      const result = await release.client.callTool({ name, arguments: {} }).catch(error => ({ isError: true, message: error.message }));
      assert.ok(result.isError, `Hidden tool ${name} was callable`);
    }
    ok((await guiCall(app, "get_song")).result === guiEmpty.result,
      "숨겨진 8개 도구의 실제 호출은 모두 거절되고 곡은 보존됨");

    await call(release.client, "new_song", { title: "Release onboarding", bpm: 120 });
    await call(release.client, "add_track", { name: "Piano", preset: "piano" });
    const notes = ["C4", "E4", "G4", "C5"].map((pitch, beat) => ({ bar: 1, beat, pitch, dur: 0.6, vel: 80 }));
    await call(release.client, "add_notes", { track: "Piano", notes });
    const song = songFrom(await call(release.client, "get_song"));
    ok(song.title === "Release onboarding" && song.tracks.length === 1
      && song.tracks[0].preset === "sf-piano-gm" && song.tracks[0].notes.length === notes.length,
    "AI가 새 곡·piano 별칭·노트 추가를 호출하면 설치된 GM 피아노로 곡이 완성됨");
    const guiSong = await guiCall(app, "get_song");
    assert.deepEqual(songFrom(guiSong.result), song);
    ok(guiSong.ok, "MCP가 만든 곡을 GUI에서도 동일하게 확인");
    await call(release.client, "save_song", { name: "Release onboarding saved" });
    const saved = fs.readdirSync(path.join(dataDir, "songs")).map(name =>
      JSON.parse(fs.readFileSync(path.join(dataDir, "songs", name), "utf8")));
    ok(saved.some(value => value.title === "Release onboarding saved" && value.tracks[0].notes.length === 4),
      "AI의 save_song이 격리된 라이브러리에 곡을 실제 보관");
    const exportBase = path.join(fixture.root, "exports", "first-song");
    await call(release.client, "export", { format: "wav", path: exportBase, from_bar: 1, to_bar: 1 });
    assertAudibleWav(fs.readFileSync(`${exportBase}.wav`));
    ok(fs.readdirSync(path.dirname(exportBase)).join(",") === "first-song.wav",
      "AI의 WAV 내보내기가 지정한 테스트 폴더에 소리가 있는 완성본을 생성");

    const full = await connect({ ARIA_TOOL_PROFILE: "full" });
    const fullList = (await full.client.listTools()).tools.map(tool => tool.name);
    ok(fullList.length === 47 && hidden.every(name => fullList.includes(name))
      && (await call(full.client, "list_songs")).includes("Release onboarding saved"),
    "명시적인 full 프로필은 47개 도구와 저장 곡 조회를 실제로 제공");
    await disconnect(full);
    const subset = await connect({ ARIA_HIDE_TOOLS: "get_song, list_feedback get_song" });
    const subsetList = (await subset.client.listTools()).tools.map(tool => tool.name);
    ok(subsetList.length === 38 && !subsetList.includes("get_song") && hidden.every(name => !subsetList.includes(name)),
      "ARIA_HIDE_TOOLS는 기본 프로필과 중복 없이 합쳐져 추가 도구를 숨김");
    await disconnect(subset);

    const invalid = spawn(process.execPath, [bridgePath], {
      cwd: root, env: { ...env, ARIA_TOOL_PROFILE: "invalid-profile" }, stdio: ["pipe", "ignore", "pipe"]
    });
    children.add(invalid);
    let invalidError = "";
    invalid.stderr.on("data", chunk => { invalidError += chunk; });
    const invalidExit = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 5000);
      invalid.once("exit", code => { clearTimeout(timer); resolve(code); });
    });
    ok(invalidExit !== null && invalidExit !== 0 && invalidError.includes("ARIA_TOOL_PROFILE") && invalidError.includes("invalid-profile"),
      "잘못된 프로필은 연결을 기다리지 않고 오류 설명과 함께 즉시 종료");

    await disconnect(release);
    const originalPid = app.child.pid;
    await stopChild(app.child);
    ok(!isAlive(originalPid), "테스트 앱과 MCP 브리지 종료 뒤 잔류 프로세스 없음");
    app = await startApp();
    const restoredSetup = await setup(app);
    const restored = await guiCall(app, "get_song");
    assert.deepEqual(songFrom(restored.result), song);
    ok(restoredSetup.basic.ready && restoredSetup.ai.lastSeenAt === null && app.child.pid !== originalPid,
      "앱 재시작 후 기본 음원과 곡이 유지되고 AI 연결은 새 세션 기준으로 표시");
    ok(restoredSetup.onboarding.completed === true
      && restoredSetup.onboarding.completedAt === completion.onboarding.completedAt
      && fs.readFileSync(onboardingFile, "utf8") === completionRecord,
    "앱 재시작 후 AI 접속 상태가 초기화돼도 안내 완료 여부와 최초 완료 시각은 유지");
    const duplicate = await fetch(`${app.url}/api/sound-setup/import`, { method: "POST" });
    ok(duplicate.status === 400 && fs.readFileSync(env.ARIA_SF2).equals(fs.readFileSync(fixture.defaultPath)),
      "재설치 시도는 기존 음원 파일을 덮어쓰지 않음");
  } finally {
    for (const connection of bridges) {
      try { await connection.client.close(); } catch { /* Cleanup after a failed assertion. */ }
      if (connection.pid && isAlive(connection.pid)) {
        try { process.kill(connection.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    }
    for (const child of children) await stopChild(child);
    fixture.cleanup();
  }
  console.log(`통과 ${passed}건 — 새 설치 → 기본 음원 → 실제 MCP 작곡·저장·WAV → 재시작. 테스트 파일·프로세스 정리 완료.`);
}

function assertAudibleWav(buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  assert.equal(buffer.readUInt16LE(20), 1, "PCM encoding");
  assert.equal(buffer.readUInt16LE(34), 16, "16-bit samples");
  assert.ok(buffer.length > 44);
  let peak = 0;
  for (let offset = 44; offset < buffer.length; offset += 2)
    peak = Math.max(peak, Math.abs(buffer.readInt16LE(offset)));
  assert.ok(peak > 100, `Expected audible test samples, got peak ${peak}`);
}

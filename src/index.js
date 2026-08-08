#!/usr/bin/env node
// aria — GUI 본체. 곡 상태와 HTTP API는 이 프로세스 하나만 소유한다.
import { loadAutosave, flushAutosave } from "./core.js";
import { startWeb } from "./web.js";
import { stopPlayback } from "./player.js";
import {
  acquireStartLock,
  discoverAria,
  releaseStartLock
} from "./runtime.js";

let startLock = null;
if (process.env.ARIA_ALLOW_MULTIPLE !== "1") {
  startLock = acquireStartLock();
  if (!startLock) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const startedElsewhere = await discoverAria();
      if (startedElsewhere) {
        console.error(`[aria] 이미 실행 중입니다: ${startedElsewhere.baseUrl}`);
        process.exit(0);
      }
      startLock = acquireStartLock();
      if (startLock) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!startLock) throw new Error("다른 Aria가 시작 중이지만 연결되지 않았습니다. 잠시 뒤 다시 실행해 주세요.");
  }
  const existing = await discoverAria();
  if (existing) {
    releaseStartLock(startLock);
    console.error(`[aria] 이미 실행 중입니다: ${existing.baseUrl}`);
    process.exit(0);
  }
}

const restored = loadAutosave();
let server, url;
try {
  ({ server, url } = await startWeb());
} catch (error) {
  releaseStartLock(startLock);
  throw error;
}
console.error(`[aria] 피아노롤 GUI: ${url}${restored ? " (이전 곡 복원됨)" : ""}`);

const { sf2Info, SF2_PATH } = await import("./sf2.js");
console.error(sf2Info()
  ? `[aria] 사운드폰트 로드: ${sf2Info()} — 샘플 프리셋(sf-*) 사용 가능`
  : `[aria] 사운드폰트 없음 (${SF2_PATH}) — 필요한 음원을 설치해야 악기를 재생할 수 있음`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  stopPlayback();
  flushAutosave();
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  releaseStartLock(startLock);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void shutdown(); });
}

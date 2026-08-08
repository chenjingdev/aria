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

const { samplerAssetStatus, samplerAssetName } = await import("./sampler-assets.js");
const { SF_PRESETS, SF_DRUM_KITS } = await import("./presets.js");
const specs = [...Object.values(SF_PRESETS), ...Object.values(SF_DRUM_KITS)];
const statuses = specs.map((spec, index) => ({ spec, status: samplerAssetStatus(spec, { shallow: true }), index }));
const available = statuses.filter(item => item.status.available).length;
const unavailableAssets = new Set(statuses.filter(item => !item.status.available)
  .map(item => samplerAssetName(item.spec, item.status)));
console.error(`[aria] 오픈소스 샘플 엔진: SpessaSynth(SoundFont) + sfizz(SFZ) — 사용 가능 ${available}/${specs.length}`
  + (unavailableAssets.size ? `, 설치·수정 필요 ${[...unavailableAssets].join(", ")}` : ""));

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

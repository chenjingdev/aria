#!/usr/bin/env node
// aria — GUI 본체. 곡 상태와 HTTP API는 이 프로세스 하나만 소유한다.
import { loadAutosave, flushAutosave } from "./core.js";
import { startWeb } from "./web.js";
import { stopPlayback } from "./player.js";
import { spawn } from "node:child_process";
import { APP_VERSION } from "./version.js";
import {
  acquireStartLock,
  discoverAria,
  releaseStartLock
} from "./runtime.js";

function openGui(url) {
  if (!process.argv.includes("--open") || process.platform !== "darwin") return;
  const child = spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" });
  child.once("error", () => console.error(`[aria] 브라우저에서 열어 주세요: ${url}`));
  child.unref();
}

let startLock = null;
if (process.env.ARIA_ALLOW_MULTIPLE !== "1") {
  startLock = acquireStartLock();
  if (!startLock) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const startedElsewhere = await discoverAria();
      if (startedElsewhere) {
        console.error(`[aria] 이미 실행 중입니다: ${startedElsewhere.baseUrl}`);
        openGui(startedElsewhere.baseUrl);
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
    openGui(existing.baseUrl);
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
console.error(`[aria ${APP_VERSION}] 브라우저에서 시작하기: ${url}${restored ? " (이전 곡 복원됨)" : ""}`);
openGui(url);

const { samplerAssetStatus } = await import("./sampler-assets.js");
const { SF_PRESETS, SF_DRUM_KITS } = await import("./presets.js");
const specs = [...Object.values(SF_PRESETS), ...Object.values(SF_DRUM_KITS)];
const statuses = specs.map((spec, index) => ({ spec, status: samplerAssetStatus(spec, { shallow: true }), index }));
const available = statuses.filter(item => item.status.available).length;
const unavailableAssets = new Set(statuses.filter(item => !item.status.available)
  .map(item => item.spec.pack ?? item.spec.font ?? "기본 음원"));
console.error(`[aria] 오픈소스 샘플 엔진: SpessaSynth(SoundFont) + sfizz(SFZ) — 사용 가능 ${available}/${specs.length}`
  + (unavailableAssets.size ? `, 미설치·확인 필요 음원 ${unavailableAssets.size}종 — 브라우저의 ‘시작 안내’를 따라 주세요.` : ""));

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

// aria — afplay 기반 재생: 구간을 WAV로 렌더해 재생, 루프는 재스폰
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderRange } from "./sampler-renderer.js";
import { wavBuffer } from "./renderer.js";
import { lufs } from "./master.js";

const MAX_LOOPS = 500;

let current = null; // { proc, stopped, loop, file, iteration }

export function isPlaying() { return !!current && !current.stopped; }

export function playInfo() {
  if (!isPlaying()) return null;
  const { fromBar, toBar, loop, duration, rangeSec, startedAt } = current;
  return { fromBar, toBar, loop, duration, rangeSec, startedAt };
}

// onEvent: {type:"play"|"stop", ...} — SSE 브로드캐스트용 콜백
// 렌더 결과를 LLM이 읽을 수 있는 수치로 — 마스터에 리미터가 없어 겹친 노트가 많으면 소프트 클리퍼가 물린다
export function levelReport(left, right) {
  let peak = 0, sumSq = 0, clipped = 0;
  const n = left.length;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(left[i]), b = Math.abs(right[i]);
    const m = a > b ? a : b;
    if (m > peak) peak = m;
    // softClip(1.0) = 0.8519 — 이 위는 이미 소프트 클리퍼가 물려 왜곡이 섞이는 구간이다.
    // 0.999로 재면 3차 셰이퍼 특성상 사실상 도달하지 않아 왜곡을 영원히 못 잡는다.
    if (m >= 0.8519) clipped++;
    sumSq += left[i] * left[i] + right[i] * right[i];
  }
  const rms = Math.sqrt(sumSq / (2 * n || 1));
  const dbfs = v => (v > 0 ? 20 * Math.log10(v) : -Infinity);
  return { peak, rms, clipped, clipPct: n ? (clipped / n) * 100 : 0, peakDb: dbfs(peak), rmsDb: dbfs(rms) };
}

export function startPlayback(song, { fromBar, toBar, loop = false }, onEvent) {
  if (process.platform !== "darwin")
    throw new Error("재생은 macOS(afplay)에서만 지원됩니다 — export로 WAV를 만들어 다른 플레이어로 들어보세요");
  // 실패할 수 있는 작업(렌더·파일 쓰기)을 먼저 끝낸 뒤에야 기존 재생을 멈춘다
  // 루프면 리버브 꼬리를 빼고 렌더해 반복 사이 공백을 없앤다
  const { left, right, sr, duration, rangeSec, master } = renderRange(song, fromBar, toBar, loop ? { tail: 0 } : {});
  // 마스터 단이 이미 재면서 지나갔다 — 같은 버퍼를 한 번 더 훑을 이유가 없다
  const level = master ?? levelReport(left, right);
  if (master) level.lufs = lufs(left, right, sr).integrated;
  const file = path.join(os.tmpdir(), `aria-play-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(file, wavBuffer(left, right, sr));
  stopPlayback(onEvent, true);
  const state = { stopped: false, loop, file, fromBar, toBar, duration, rangeSec, iteration: 0, proc: null, startedAt: null };
  current = state;
  const playOnce = () => {
    if (state.stopped || state.iteration >= MAX_LOOPS) return finish(state, onEvent);
    state.iteration++;
    state.startedAt = Date.now();
    state.proc = spawn("afplay", [file], { stdio: "ignore" });
    onEvent?.({ type: "play", fromBar, toBar, loop, duration, rangeSec, iteration: state.iteration, startedAt: state.startedAt });
    state.proc.on("error", () => finish(state, onEvent));
    state.proc.on("exit", () => {
      if (state.loop && !state.stopped) playOnce();
      else finish(state, onEvent);
    });
  };
  playOnce();
  return { duration, rangeSec, level };
}

function finish(state, onEvent) {
  if (current === state) {
    current = null;
    onEvent?.({ type: "stop" });
  }
  fs.promises.unlink(state.file).catch(() => {});
}

export function stopPlayback(onEvent, silent = false) {
  if (!current) return false;
  const state = current;
  state.stopped = true;
  current = null;
  try { state.proc?.kill(); } catch { /* 이미 종료됨 */ }
  fs.promises.unlink(state.file).catch(() => {});
  if (!silent) onEvent?.({ type: "stop" });
  return true;
}

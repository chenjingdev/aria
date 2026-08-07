// 필하모니아 샘플 빌드 공용 헬퍼 — build-phil.mjs(선율)·build-phil-perc.mjs(타악)가 공유
import fs from "node:fs";
import { spawn } from "node:child_process";

export const DYN = ["pianissimo", "piano", "mezzo-piano", "mezzo-forte", "forte", "fortissimo"];

export const noteToMidi = n => {
  const m = /^([A-G])(s?)(\d+)$/.exec(n);
  if (!m) return null;
  return { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] ? 1 : 0) + (+m[3] + 1) * 12;
};

// mp3 → wav (동시 8개)
export async function convertAll(jobs) {
  let done = 0, failed = 0;
  const run = job => new Promise(res => {
    const p = spawn("afconvert", ["-f", "WAVE", "-d", "LEI16", job.src, job.dst]);
    p.on("close", code => { if (code !== 0) failed++; done++; res(); });
    p.on("error", () => { failed++; done++; res(); });
  });
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) await run(queue.shift());
  }));
  return { done, failed };
}

export function readWavMono(fp) {
  const buf = fs.readFileSync(fp);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { ch: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === "data") { data = { start: off + 8, size }; break; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error(`WAV 형식 이상: ${fp}`);
  const n = Math.floor(data.size / 2 / fmt.ch);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) s += buf.readInt16LE(data.start + (i * fmt.ch + c) * 2);
    out[i] = Math.round(s / fmt.ch);
  }
  return { pcm: out, rate: fmt.rate };
}

// 트림 + 자동 루프 (oneShot이면 루프 없이 꼬리 트림만)
// 기준을 "어택 직후 지속 구간의 중앙값 RMS"로 잡는다 — 전역 최대(어택 피크) 기준은
// 현악처럼 어택이 큰 샘플에서 루프 실패(지속 끊김)·루프 내 감쇠(펌핑)를 낳았다 (리뷰 확정 결함).
export function processSample(pcm, sr, oneShot = false) {
  // 리드 무음 트림 (-44dB 문턱, 40샘플 여유, 32샘플 페이드인)
  const TH = 200;
  let s0 = 0;
  while (s0 < pcm.length && Math.abs(pcm[s0]) < TH) s0++;
  s0 = Math.max(0, s0 - 40);
  let out = pcm.slice(s0);
  for (let i = 0; i < 32 && i < out.length; i++) out[i] = (out[i] * i / 32) | 0;

  if (oneShot) {
    // 원샷(피치카토·타악): 루프 없이 자연 감쇠. 꼬리 룸노이즈만 잘라내고(-50dB, 0.15s 여유 + 30ms 페이드아웃) 끝.
    let sN = out.length - 1;
    while (sN > 0 && Math.abs(out[sN]) < TH * 0.5) sN--;
    const end = Math.min(out.length, sN + Math.floor(0.15 * sr));
    out = out.slice(0, end);
    const F = Math.min(Math.floor(0.03 * sr), out.length);
    for (let i = 0; i < F; i++) out[out.length - F + i] = Math.round(out[out.length - F + i] * (1 - i / F));
    return { pcm: out, loopStart: 0, loopEnd: out.length - 1, loop: false, soundingSec: sN / sr };
  }

  const W = 512;
  const nw = Math.floor(out.length / W);
  if (nw < 8) return { pcm: out, loopStart: 0, loopEnd: out.length - 1, loop: false, soundingSec: out.length / sr };
  const rms = new Float64Array(nw);
  let maxR = 0;
  for (let w = 0; w < nw; w++) {
    let s = 0;
    for (let i = w * W; i < (w + 1) * W; i++) s += out[i] * out[i];
    rms[w] = Math.sqrt(s / W);
    maxR = Math.max(maxR, rms[w]);
  }
  // 발음 구간(전역 최대의 25% 이상) — 스웰(메사 디 보체) 샘플에서 "최대 RMS=어택"이라는 가정은
  // 루프를 스웰 꼭대기·감쇠 꼬리에 박아버렸다. 시간축 기준으로 어택·릴리스를 잘라낸다.
  const sounding = w => rms[w] >= maxR * 0.25;
  let firstS = 0;
  while (firstS < nw && !sounding(firstS)) firstS++;
  let lastS = nw - 1;
  while (lastS > firstS && !sounding(lastS)) lastS--;
  const soundingSec = (lastS - firstS + 1) * W / sr;
  if (lastS - firstS < 4) return { pcm: out, loopStart: 0, loopEnd: out.length - 1, loop: false, soundingSec };
  const attackEnd = Math.min(lastS, firstS + Math.ceil(0.06 * sr / W));
  const span = [...rms.slice(attackEnd, lastS + 1)].sort((a, b) => a - b);
  const ref = span[span.length >> 1] || 0;
  if (!ref) return { pcm: out, loopStart: 0, loopEnd: out.length - 1, loop: false, soundingSec };

  // 지속 구간: 앞뒤에서 기준의 60% 미만(여린 도입·릴리스·감쇠)을 걷어낸다
  let lastGood = lastS;
  while (lastGood > attackEnd && rms[lastGood] < ref * 0.6) lastGood--;
  let firstGood = attackEnd;
  while (firstGood < lastGood && (rms[firstGood] < ref * 0.6 || rms[firstGood] > ref * 1.4)) firstGood++;

  const zc = idx => { // 상승 제로크로싱으로 스냅 (±600 탐색)
    for (let d = 0; d < 600; d++) {
      for (const j of [idx + d, idx - d])
        if (j > 1 && j < out.length - 1 && out[j - 1] < 0 && out[j] >= 0) return j;
    }
    return idx;
  };
  let loopEnd = zc(Math.min(lastGood * W, out.length - Math.floor(0.03 * sr)));
  // 루프 시작: 지속 구간의 앞 25% 지점 (진입 레벨이 기준 ±4dB 이내가 되도록 firstGood이 보정)
  const sustainStart = Math.max(firstGood * W, Math.floor(0.02 * sr));
  let loopStart = zc(Math.min(Math.floor(sustainStart + 0.25 * (loopEnd - sustainStart)),
    Math.max(sustainStart, loopEnd - Math.floor(0.08 * sr))));
  // 최소 루프: 보통 80ms, 발음이 0.6초 미만인 짧은 샘플(025 등)은 30ms 마이크로 루프까지 허용
  const minLoop = Math.floor((soundingSec >= 0.6 ? 0.08 : 0.03) * sr);
  let loop = loopEnd - loopStart >= minLoop && loopStart > 32;

  if (loop) {
    // 루프 구간 엔벨로프 평탄화 — 자연 감쇠를 안은 채 루프하면 주기적 펌핑이 되므로,
    // 진입 지점 레벨을 기준으로 구간 내 게인을 윈도우 보간으로 보정해 지속을 평평하게 만든다
    const wS = Math.ceil(loopStart / W), wE = Math.floor(loopEnd / W);
    if (wE - wS >= 2) {
      const target = rms[wS] || ref;
      const gainAt = w => Math.min(3, Math.max(0.33, target / (rms[Math.min(Math.max(w, 0), nw - 1)] || target)));
      const FADE = Math.floor(0.1 * sr); // 진입 후 100ms에 걸쳐 보정 도입(경계 연속성)
      for (let i = loopStart; i < loopEnd; i++) {
        const wf = i / W - 0.5;
        const w0 = Math.floor(wf), frac = wf - w0;
        const g = gainAt(w0) * (1 - frac) + gainAt(w0 + 1) * frac;
        const mix = Math.min(1, (i - loopStart) / FADE);
        out[i] = Math.max(-32768, Math.min(32767, Math.round(out[i] * (1 + (g - 1) * mix))));
      }
    }
    // 루프 경계 크로스페이드(50ms): loopEnd 직전이 loopStart 직전 내용으로 수렴 → 이음매 제거
    const F = Math.min(Math.floor(0.05 * sr), loopStart, Math.floor((loopEnd - loopStart) / 2));
    for (let i = 0; i < F; i++) {
      const w = i / F;
      out[loopEnd - F + i] = Math.round(out[loopEnd - F + i] * (1 - w) + out[loopStart - F + i] * w);
    }
  } else { loopStart = 0; loopEnd = out.length - 1; loop = false; }
  return { pcm: out, loopStart, loopEnd, loop, soundingSec };
}

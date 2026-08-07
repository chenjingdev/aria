// aria — 표현 데모: velRange 크레셴도 · release 레가토 · reverb 공간 · ramp 리타르단도 · 5/4 변박
// 실행 중인 서버의 HTTP API로 작곡한다 (LLM이 MCP로 하는 일과 같은 경로).

// 여러 인스턴스가 떠 있을 수 있다(MCP 클라이언트마다 하나) — ARIA_URL로 지정 가능
async function findServer() {
  if (process.env.ARIA_URL) return process.env.ARIA_URL.replace(/\/$/, "");
  for (let port = 7788; port <= 7808; port++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(400) });
      if (r.ok) return `http://127.0.0.1:${port}`;
    } catch { /* 다음 포트 */ }
  }
  throw new Error("aria 서버를 찾지 못했습니다 — 먼저 `npm start`");
}

const BASE = await findServer();
async function rpc(tool, args = {}) {
  const r = await fetch(`${BASE}/api/rpc`, { method: "POST", body: JSON.stringify({ tool, args }) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${tool}: ${j.error}`);
  console.log(`✓ ${tool}${args.track ? ` ${args.track}` : ""}`);
  return j.result;
}

const N = (bar, beat, pitch, dur, vel = 96) => ({ bar, beat, pitch, dur, vel });

// 5/4 · 16마디 · 서서히 부풀었다 마지막에 늘어지는 곡
await rpc("new_song", { title: "여백", template: "ballad", time_sig: [5, 4], bpm: 92 });

// 표현 파라미터 — 예전에는 프리셋 상수라 손댈 수 없던 것들
await rpc("set_track", { track: "Piano", velRange: 1, attack: 0.02, release: 1.4, reverb: 0.55 });
await rpc("set_track", { track: "Strings", velRange: 1, attack: 0.45, release: 2.6, reverb: 0.75, volume: 0.5 });
await rpc("set_track", { track: "Bass", velRange: 1, release: 0.5 });
await rpc("set_track", { track: "Drums", velRange: 1, volume: 0.55 });

// Am — F — C — G, 5/4라 마디당 5박
const CHORDS = [["A3", "C4", "E4"], ["F3", "A3", "C4"], ["C3", "E3", "G3"], ["G3", "B3", "D4"]];
const ROOTS = ["A1", "F1", "C2", "G1"];

const piano = [], strings = [], bass = [], drums = [];
for (let bar = 1; bar <= 16; bar++) {
  const c = CHORDS[(bar - 1) % 4], root = ROOTS[(bar - 1) % 4];
  // 크레셴도를 velocity만으로 — 16마디에 걸쳐 28 → 118
  const vel = Math.round(28 + (118 - 28) * ((bar - 1) / 15));
  const soft = v => Math.max(1, Math.round(v * 0.75));

  // 피아노 아르페지오 — release 1.4초라 음끼리 겹쳐 흐른다
  for (let i = 0; i < 5; i++) piano.push(N(bar, i, c[i % 3], 0.9, soft(vel)));
  // 스트링 패드 — 마디 전체를 덮는다
  for (const p of c) strings.push(N(bar, 0, p, 5, soft(vel)));
  bass.push(N(bar, 0, root, 2.5, vel), N(bar, 3, root, 1.5, soft(vel)));
  // 드럼은 5박을 3+2로 쪼갠다
  drums.push(N(bar, 0, "kick", 0.25, vel), N(bar, 3, "kick", 0.25, soft(vel)));
  if (bar > 4) drums.push(N(bar, 2, "snare", 0.25, soft(vel)));
  for (let i = 0; i < 5; i++) drums.push(N(bar, i + 0.5, "hhc", 0.25, Math.round(vel * 0.5)));
}
await rpc("add_notes", { track: "Piano", notes: piano });
await rpc("add_notes", { track: "Strings", notes: strings });
await rpc("add_notes", { track: "Bass", notes: bass });
await rpc("add_notes", { track: "Drums", notes: drums });

// 리타르단도 — 13마디까지는 그대로 두고(앵커), 거기서 16마디까지 92 → 58bpm으로 서서히
await rpc("set_tempo", { bpm: 92, from_bar: 13 });
await rpc("set_tempo", { bpm: 58, from_bar: 16, ramp: true });

console.log("\n" + await rpc("get_song").then(s => s.split("\n").slice(0, 4).join("\n")));
console.log("\n" + await rpc("play", { from_bar: 1, to_bar: 16 }));

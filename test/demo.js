// aria — 데모: 실행 중인 서버의 HTTP API로 시티팝 8마디를 작곡해 재생
// (LLM이 MCP로 하는 일과 동일한 경로 — GUI를 열어두면 실시간으로 그려진다)

async function findServer() {
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

await rpc("new_song", { template: "citypop", title: "야간비행" });

// 드럼 — 8비트 시티팝 그루브
const drums = [];
for (let bar = 1; bar <= 8; bar++) {
  drums.push(N(bar, 0, "kick", 0.25, 112), N(bar, 2.5, "kick", 0.25, 104));
  drums.push(N(bar, 1, "snare", 0.25, 102), N(bar, 3, "snare", 0.25, 106));
  for (let e = 0; e < 8; e++) {
    if (bar % 2 === 0 && e === 7) drums.push(N(bar, 3.5, "hho", 0.4, 78));
    else drums.push(N(bar, e * 0.5, "hhc", 0.2, e % 2 ? 58 : 72));
  }
  if (bar % 4 === 0) drums.push(N(bar, 3.75, "kick", 0.25, 90));
}
drums.push(N(8, 3.5, "crash", 1, 80));
await rpc("add_notes", { track: "Drums", notes: drums });

// 베이스 — 루트·옥타브 바운스 (Fmaj7 E7 Am7 C7 | Fmaj7 E7 Am7 Dm7-G7)
const roots = [["F2"], ["E2"], ["A2"], ["C2"], ["F2"], ["E2"], ["A2"], ["D2", "G2"]];
const up = { F2: "F3", E2: "E3", A2: "A3", C2: "C3", D2: "D3", G2: "G3" };
const bass = [];
roots.forEach((r, i) => {
  const bar = i + 1;
  if (r.length === 1) {
    bass.push(N(bar, 0, r[0], 0.75, 104), N(bar, 1.5, up[r[0]], 0.5, 88),
      N(bar, 2.5, r[0], 0.75, 100), N(bar, 3.5, up[r[0]], 0.5, 84));
  } else {
    bass.push(N(bar, 0, r[0], 0.75, 104), N(bar, 1, up[r[0]], 0.5, 88),
      N(bar, 2, r[1], 0.75, 102), N(bar, 3, up[r[1]], 0.5, 86));
  }
});
await rpc("add_notes", { track: "Bass", notes: bass });

// 전기피아노 — 보이싱 + 오프비트 푸시
const chords = [
  ["F3", "A3", "C4", "E4"], ["E3", "G#3", "B3", "D4"], ["A3", "C4", "E4", "G4"], ["G3", "Bb3", "C4", "E4"],
  ["F3", "A3", "C4", "E4"], ["E3", "G#3", "B3", "D4"], ["A3", "C4", "E4", "G4"], ["D3", "F3", "A3", "C4"]
];
const ep = [];
chords.forEach((c, i) => {
  const bar = i + 1;
  for (const p of c) ep.push(N(bar, 0, p, 1.75, 82));
  for (const p of c) ep.push(N(bar, 2.5, p, 1.0, 74));
  if (bar === 8) for (const p of ["G3", "B3", "D4", "F4"]) ep.push(N(bar, 3, p, 1, 78)); // G7 턴어라운드
});
await rpc("add_notes", { track: "E.Piano", notes: ep });

// 리드 — 뒷 4마디 멜로디
await rpc("add_notes", { track: "Lead", notes: [
  N(5, 0, "A4", 1, 96), N(5, 1, "C5", 0.5, 92), N(5, 1.5, "B4", 0.5, 90), N(5, 2, "G4", 1.5, 94),
  N(6, 0, "E4", 1.5, 88), N(6, 2, "G#4", 1, 92), N(6, 3, "B4", 1, 94),
  N(7, 0, "A4", 2, 96), N(7, 2.5, "E5", 1.5, 98),
  N(8, 0, "D5", 1, 96), N(8, 1, "C5", 0.5, 92), N(8, 1.5, "B4", 0.5, 90), N(8, 2, "A4", 2, 94)
]});

console.log("\n" + await rpc("play", { from_bar: 1, to_bar: 8 }));
console.log(`GUI에서 실시간으로 확인: ${BASE}`);

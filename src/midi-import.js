// aria — 표준 MIDI 파일(SMF) 가져오기, 순수 JS. midi.js(내보내기)의 반대 방향이다.
// 드럼 노트 매핑·GM 번호는 내보내기와 같은 표(DRUM_PIECES, preset.gm)를 쓴다 — 왕복이 어긋나면 안 된다.
import { PRESETS, SF_PRESETS, DRUM_PIECES } from "./presets.js";
import { validateSong, beatsPerBar, MAX_TEMPO_POINTS } from "./song.js";

const err = m => { throw new Error(m); };

// validateSong이 걸어 둔 상한과 같은 값이어야 한다 — 여기서 미리 잘라야 "조용히 실패" 대신 리포트가 남는다
const MAX_TRACKS = 32;
const MAX_NOTES = 10000;
const MAX_BAR = 999;
const MAX_DUR = 64;
const DEFAULT_BPM = 120; // 템포 메타가 없는 SMF의 규격 기본값(500000µs/4분음표)
const DRUM_CH = 9;       // GM에서 채널 10(0-based 9)은 언제나 타악기
const MIN_DUR = 0.001;   // 반올림·격자 스냅으로 길이가 0이 된 노트에 주는 최소 길이
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// GM 퍼커션 노트 → aria 피스 이름.
// DRUM_PIECES의 역매핑이 우선이고(내보낸 파일을 다시 읽으면 그대로 돌아와야 한다),
// 나머지 GM 노트는 소리가 가장 가까운 피스로 접는다. 대응이 없는 것(카우벨·봉고·클라베스 등)은
// 아무 피스에나 붙이면 리듬이 뭉개지므로 버리고 개수를 리포트에 적는다.
const GM_DRUM = {
  35: "kick", 40: "snare", 41: "tom-l", 44: "hhc", 45: "tom-l", 48: "tom-h",
  52: "crash", 53: "ride", 54: "shaker", 55: "crash", 57: "crash", 59: "ride",
  69: "shaker", 82: "shaker",
  ...Object.fromEntries(Object.entries(DRUM_PIECES).map(([piece, note]) => [note, piece]))
};

const r3 = v => Math.round(v * 1000) / 1000;
const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const tag = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

function midiToName(key) {
  if (!Number.isInteger(key) || key < 0 || key > 127) return null;
  return `${NOTE_NAMES[key % 12]}${Math.floor(key / 12) - 1}`;
}

// 트랙 이름·제목용 텍스트 메타. 인코딩 선언이 없는 규격이라 UTF-8로 읽고,
// 제어문자만 털어낸다(Shift-JIS 등으로 쓰인 파일은 글자가 깨질 수 있다 — 리포트에 경고).
function metaText(body) {
  return Buffer.from(body).toString("utf8").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data; // Buffer도 Uint8Array다
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  err("MIDI 데이터는 Buffer 또는 Uint8Array여야 합니다 — fs.readFileSync(경로)로 읽은 값을 그대로 넘기세요");
}

function readQuantize(v) {
  if (v === undefined || v === null || v === 0 || v === false) return null;
  const q = Number(v);
  if (!Number.isFinite(q) || q <= 0 || q > 4)
    err(`quantize는 0보다 크고 4 이하인 박 단위 격자여야 합니다 (0.25=16분음표, 0.5=8분음표) — 받은 값: ${JSON.stringify(v)}`);
  return q;
}

// ---------- 청크 ----------
function readSmf(b) {
  if (b.length < 14 || tag(b, 0) !== "MThd")
    err(`MIDI 파일이 아닙니다 — 앞 4바이트가 "MThd"여야 하는데 ${JSON.stringify(b.length >= 4 ? tag(b, 0) : "(너무 짧음)")}입니다`);
  const headLen = u32(b, 4);
  if (headLen < 6) err(`MThd 헤더 길이가 ${headLen}바이트로 규격(6 이상)에 못 미칩니다 — 파일이 손상됐습니다`);
  const format = u16(b, 8), ntrks = u16(b, 10), division = u16(b, 12);
  if (format === 2)
    err("SMF format 2는 지원하지 않습니다 — 트랙마다 독립된 곡(패턴 묶음)이라 하나의 aria 곡으로 합칠 수 없습니다. DAW에서 format 0이나 1로 다시 저장해 주세요");
  if (format !== 0 && format !== 1)
    err(`알 수 없는 SMF format ${format}입니다 — aria는 format 0(단일 트랙)과 1(다중 트랙)만 읽습니다`);

  const chunks = [];
  let pos = 8 + headLen; // 헤더는 보통 6바이트지만 확장된 파일도 있다 — 선언된 길이를 따른다
  while (pos + 8 <= b.length) {
    const id = tag(b, pos), len = u32(b, pos + 4);
    const start = pos + 8, end = start + len;
    if (end > b.length) { // 마지막 청크가 잘린 파일 — 있는 데까지만 읽는다
      if (id === "MTrk") chunks.push({ data: b.subarray(start), truncated: true });
      break;
    }
    if (id === "MTrk") chunks.push({ data: b.subarray(start, end), truncated: false });
    pos = end; // MTrk가 아닌 청크(제조사 확장 등)는 규격대로 건너뛴다
  }
  return { format, ntrks, division, chunks };
}

// 트랙 청크 하나를 절대 틱이 붙은 이벤트 배열로. tolerant면 잘린 꼬리에서 조용히 멈춘다.
function parseTrack(data, no, tolerant) {
  const ev = [];
  let pos = 0, tick = 0, status = 0;
  const need = n => { if (pos + n > data.length) err(`${no}번 트랙(MTrk)이 이벤트 중간에서 끊겼습니다 — 파일이 손상됐습니다`); };
  const vlq = () => {
    let v = 0, byte, n = 0;
    do {
      need(1); byte = data[pos++];
      v = v * 128 + (byte & 0x7f); // 시프트 대신 곱셈 — 4바이트 VLQ는 32비트 부호 경계를 넘는다
      if (++n > 4) err(`${no}번 트랙: 가변길이 수가 4바이트를 넘습니다 — 파일이 손상됐습니다`);
    } while (byte & 0x80);
    return v;
  };
  try {
    while (pos < data.length) {
      tick += vlq();
      need(1);
      let st = data[pos];
      // 러닝 스테이터스: 상태 바이트가 생략되면 직전 채널 이벤트의 것을 쓴다(데이터 바이트는 그대로 둔다)
      if (st < 0x80) {
        if (!status) err(`${no}번 트랙 ${pos}바이트: 상태 바이트 없이 이벤트가 시작합니다 — 파일이 손상됐습니다`);
        st = status;
      } else pos++;

      if (st === 0xff) {
        status = 0; // 메타·시스템 이벤트는 러닝 스테이터스를 끊는다
        need(1);
        const type = data[pos++];
        const len = vlq();
        need(len);
        const body = data.subarray(pos, pos + len);
        pos += len;
        if (type === 0x2f) break; // end of track — 뒤에 패딩이 있어도 여기서 멈춘다
        ev.push({ tick, meta: type, body });
      } else if (st === 0xf0 || st === 0xf7) {
        status = 0;
        const len = vlq();
        need(len);
        pos += len; // 시스엑스에는 aria가 쓸 정보가 없다
      } else {
        status = st;
        const hi = st & 0xf0, ch = st & 0x0f;
        const n = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
        need(n);
        const a = data[pos++];
        const b = n === 2 ? data[pos++] : 0;
        ev.push({ tick, hi, ch, a, b });
      }
    }
  } catch (e) {
    if (!tolerant) throw e;
  }
  return ev;
}

// ---------- 프리셋 추정 ----------
// GM 악기군(8개 묶음)마다 정해 둔 대타 — 후보 중에 같은 군이 하나도 없을 때 쓴다.
// 번호 거리만으로 고르면 군을 넘어가 버린다(나일론 기타 24 → 오르간 16).
// 여기 값은 언제나 소리가 나는 합성 프리셋이다 — 사운드폰트가 없어도 곡이 벙어리가 되면 안 된다.
const GM_GROUP = [
  "soft-piano",  // 0~7 피아노
  "music-box",   // 8~15 크로매틱 타악
  "organ",       // 16~23 오르간
  "pluck",       // 24~31 기타
  "finger-bass", // 32~39 베이스
  "strings",     // 40~47 독주 현악
  "strings",     // 48~55 앙상블·합창
  "saw-lead",    // 56~63 금관
  "square-lead", // 64~71 리드(색소폰·목관)
  "airy-synth",  // 72~79 파이프(플루트 계열)
  "saw-lead",    // 80~87 신스 리드
  "airy-synth",  // 88~95 신스 패드
  "dx-lush",     // 96~103 신스 효과음
  "pluck",       // 104~111 민속 악기
  "music-box",   // 112~119 타악기 계열
  "airy-synth"   // 120~127 효과음
];

// GM 프로그램 번호 → aria 프리셋.
// gm이 정확히 같은 프리셋이 최우선이라야 내보내기와의 왕복에서 음색이 보존된다.
export function guessPreset(gm, preferSamples = false) {
  // preferSamples일 때만 sf-를 후보에 넣고, 목록 앞에 둬서 동점이면 샘플이 이기게 한다
  const cands = preferSamples
    ? [...Object.entries(SF_PRESETS), ...Object.entries(PRESETS)]
    : Object.entries(PRESETS);
  const exact = cands.find(([, p]) => p.gm === gm);
  if (exact) return exact[0];
  let best = null, bestDist = Infinity;
  for (const [id, p] of cands) {
    if (Math.floor(p.gm / 8) !== Math.floor(gm / 8)) continue; // 같은 악기군 안에서만 이웃을 찾는다
    const d = Math.abs(p.gm - gm);
    if (d < bestDist) { bestDist = d; best = id; }
  }
  // 같은 군이라도 번호가 반 군(4) 넘게 떨어졌으면 이웃보다 군 대표가 낫다 —
  // 바이올린(40)의 같은 군 이웃은 피치카토 자리의 pluck(45)뿐이지만 실제로 가까운 소리는 strings다.
  if (best !== null && bestDist <= 4) return best;
  return GM_GROUP[Math.min(GM_GROUP.length - 1, Math.max(0, Math.floor(gm / 8)))];
}

// ---------- 노트 짝짓기 ----------
// 반환: 채널별 파트 목록. 같은 MIDI 트랙 안에서도 채널이 다르면 다른 aria 트랙이 된다
// (format 0은 트랙이 하나뿐이라 채널로 갈라야 편성이 살아난다).
function collectParts(events, stats) {
  const chans = new Map(); // ch → {program, vol, pan, notes, open}
  const get = ch => {
    let c = chans.get(ch);
    if (!c) chans.set(ch, c = { ch, program: null, vol: null, pan: null, notes: [], open: new Map() });
    return c;
  };
  let name = "";
  for (const e of events) {
    if (e.meta === 0x03) { if (!name) name = metaText(e.body); continue; }
    if (e.hi === undefined) continue;
    const c = get(e.ch);
    if (e.hi === 0xc0) { if (c.program === null) c.program = e.a; continue; } // 첫 프로그램만 쓴다
    if (e.hi === 0xb0) {
      if (e.a === 7 && c.vol === null) c.vol = e.b;   // CC7 채널 볼륨
      else if (e.a === 10 && c.pan === null) c.pan = e.b; // CC10 팬
      continue;
    }
    const on = e.hi === 0x90 && e.b > 0;
    const off = e.hi === 0x80 || (e.hi === 0x90 && e.b === 0); // velocity 0인 note on = note off
    if (!on && !off) continue;
    let q = c.open.get(e.a);
    if (!q) c.open.set(e.a, q = []);
    if (on) {
      if (q.length) stats.overlaps++; // 같은 음이 끝나기 전에 다시 시작 — 아래 FIFO 규칙으로 짝짓는다
      q.push({ tick: e.tick, vel: e.b });
      continue;
    }
    // 겹친 같은 음은 먼저 시작한 것을 먼저 끝낸다(FIFO). 나중 것을 먼저 끊는 LIFO를 쓰면
    // 페달로 이어 밟은 음이 앞 음의 길이를 훔쳐 가 리듬이 어긋난다.
    const started = q.shift();
    if (!started) { stats.orphanOffs++; continue; }
    c.notes.push({ on: started.tick, off: e.tick, key: e.a, vel: started.vel });
  }
  const parts = [];
  for (const c of chans.values()) {
    // 짝이 없는 note on — 버리지 않고 곡 끝까지 울리게 둔다(off는 나중에 채운다)
    for (const [key, q] of c.open)
      for (const started of q) { stats.hanging++; c.notes.push({ on: started.tick, off: null, key, vel: started.vel }); }
    if (c.notes.length) parts.push({ ...c, name, open: undefined });
  }
  parts.sort((a, b) => a.ch - b.ch);
  return parts;
}

function uniqueName(base, used) {
  // 자른 뒤 반드시 trim한다 — validateSong은 트림한 이름으로 중복을 보는데
  // 여기서 공백으로 끝나는 이름을 넣으면 "안 겹친다"고 판단해 놓고 검증에서 중복으로 걸린다
  const head = (base || "트랙").slice(0, 60).trim() || "트랙";
  let name = head;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${head.slice(0, 54).trim() || "트랙"} ${n}`;
  used.add(name.toLowerCase());
  return name;
}

/**
 * SMF(표준 MIDI 파일)를 aria 곡으로 가져온다.
 * @param {Buffer|Uint8Array} buffer SMF 파일 내용
 * @param {{quantize?: number, preferSamples?: boolean, title?: string}} opts
 * @returns {{song: object, report: string}} song은 validateSong을 통과한 곡, report는 한국어 요약
 */
export function importMidi(buffer, opts = {}) {
  const bytes = toBytes(buffer);
  const quantize = readQuantize(opts.quantize);
  const preferSamples = opts.preferSamples === true;
  const warn = [], drop = [];
  const { format, ntrks, division, chunks } = readSmf(bytes);
  if (!chunks.length) err("MTrk(트랙) 청크가 하나도 없습니다 — 내용이 빈 MIDI 파일입니다");
  if (chunks.length !== ntrks)
    warn.push(`헤더는 트랙 ${ntrks}개라 했는데 실제 MTrk는 ${chunks.length}개입니다 — 있는 것만 읽었습니다`);
  if (chunks.some(c => c.truncated))
    warn.push("마지막 트랙이 파일 끝에서 잘려 있습니다 — 읽을 수 있는 데까지만 가져왔습니다");

  const trackEvents = chunks.map((c, i) => parseTrack(c.data, i + 1, c.truncated));

  // ---------- 곡 전체에 걸리는 메타 (템포·박자표) ----------
  // format 0은 유일한 트랙에, format 1은 보통 첫 트랙에 들어 있지만 규격이 강제하지는 않아 전 트랙에서 모은다.
  const tempos = [], timeSigs = [];
  let endTick = 0;
  for (const events of trackEvents)
    for (const e of events) {
      if (e.tick > endTick) endTick = e.tick;
      if (e.meta === 0x51 && e.body.length >= 3) tempos.push({ tick: e.tick, us: (e.body[0] << 16) | (e.body[1] << 8) | e.body[2] });
      else if (e.meta === 0x58 && e.body.length >= 2) timeSigs.push({ tick: e.tick, num: e.body[0], dd: e.body[1] });
    }
  tempos.sort((a, b) => a.tick - b.tick);
  timeSigs.sort((a, b) => a.tick - b.tick);

  let timeSig = [4, 4];
  if (!timeSigs.length) warn.push("박자표 메타(FF 58)가 없어 4/4로 가정했습니다");
  else {
    const den = timeSigs[0].dd <= 8 ? 2 ** timeSigs[0].dd : 0; // 2**255는 Infinity — 미리 막는다
    if (timeSigs[0].num >= 1 && timeSigs[0].num <= 16 && [2, 4, 8, 16].includes(den)) timeSig = [timeSigs[0].num, den];
    else warn.push(`박자표 ${timeSigs[0].num}/${den || `2^${timeSigs[0].dd}`}는 aria 범위(박자수 1~16, 단위 2·4·8·16) 밖이라 4/4로 대체했습니다`);
    if (timeSigs.length > 1)
      warn.push(`곡 도중 박자표가 ${timeSigs.length - 1}번 더 바뀌지만 aria는 곡 하나에 박자표 하나만 쓰므로 첫 번째(${timeSig[0]}/${timeSig[1]})만 적용했습니다 — 이후 마디 위치가 원곡과 어긋납니다`);
  }
  const bpb = beatsPerBar({ timeSig });

  // ---------- 템포 ----------
  const usToBpm = us => (us > 0 ? 60_000_000 / us : DEFAULT_BPM);
  let bpmClamped = 0;
  const clampBpm = v => {
    const c = Math.min(300, Math.max(20, v));
    if (c !== v) bpmClamped++; // 여러 번 걸려도 경고는 마지막에 한 줄로 모은다
    return r3(c);
  };
  let bpm = tempos.length ? clampBpm(r3(usToBpm(tempos[0].us))) : DEFAULT_BPM;
  if (!tempos.length) warn.push(`템포 메타(FF 51)가 없어 규격 기본값 ${DEFAULT_BPM}bpm으로 읽었습니다`);
  else if (tempos[0].tick > 0) warn.push("첫 템포 메타가 0틱이 아니라 그 앞 구간도 같은 템포로 간주했습니다");

  // ---------- 틱 → 박 ----------
  let ticksPerBeat, divisionLabel;
  if (division & 0x8000) {
    // SMPTE 타임코드: 틱이 절대 시간을 가리킨다. 박 격자가 없으므로 초를 기준 템포로 나눠 박으로 옮기고,
    // 이후 템포 변화는 타임코드와 무관하므로 무시한다(그대로 반영하면 시간이 두 번 굽는다).
    const fps = 256 - (division >> 8); // -24/-25/-29/-30이 2의 보수로 들어 있다
    const tpf = division & 0xff;
    if (![24, 25, 29, 30].includes(fps) || tpf < 1)
      err(`헤더 division(0x${division.toString(16).padStart(4, "0")})을 해석할 수 없습니다 — SMPTE는 24·25·29·30fps에 프레임당 틱 1 이상만 지원합니다`);
    const ticksPerSec = (fps === 29 ? 29.97 : fps) * tpf; // 29는 29.97 드롭프레임의 관례 표기
    ticksPerBeat = (ticksPerSec * 60) / bpm;
    divisionLabel = `SMPTE ${fps === 29 ? "29.97" : fps}fps × ${tpf}틱`;
    warn.push(`SMPTE 타임코드 파일이라 ${bpm}bpm 기준으로 시간을 박으로 환산했습니다 — 마디선이 원곡 의도와 다를 수 있습니다`);
    if (tempos.length > 1) warn.push(`SMPTE에서는 템포 메타가 재생 시간에 영향을 주지 않으므로 이후 템포 변화 ${tempos.length - 1}개를 무시했습니다`);
  } else {
    if (division < 1) err("헤더 division이 0입니다 — 4분음표당 틱 수를 알 수 없어 시간을 계산할 수 없습니다");
    ticksPerBeat = division;
    divisionLabel = `${division} 틱/4분음표`;
  }

  const snap = quantize ? b => Math.round(b / quantize) * quantize : b => b;
  const toBeat = tick => r3(snap(tick / ticksPerBeat));

  const tempoMap = [];
  if (!(division & 0x8000) && tempos.length > 1) {
    // aria의 템포 변화는 마디 단위다 — 마디 중간의 변화점은 가장 가까운 마디로 옮긴다
    const byBar = new Map();
    let offBar = 0, outOfRange = 0;
    for (const t of tempos.slice(1)) {
      // 마디 위치는 격자 스냅을 타면 안 되므로 toBeat이 아니라 원래 틱으로 계산한다
      const exact = t.tick / ticksPerBeat / bpb + 1;
      const bar = Math.round(exact);
      if (Math.abs(exact - bar) > 1e-6) offBar++;
      if (bar < 2 || bar > MAX_BAR) { outOfRange++; continue; }
      byBar.set(bar, clampBpm(r3(usToBpm(t.us)))); // 같은 마디에 여러 개면 마지막 것이 남는다
    }
    let prev = bpm;
    let points = [...byBar.entries()].sort((a, b) => a[0] - b[0])
      .filter(([, v]) => { if (Math.abs(v - prev) < 1e-3) return false; prev = v; return true; })
      .map(([bar, v]) => ({ bar, bpm: v }));
    if (points.length > MAX_TEMPO_POINTS) {
      // 앞에서부터 자르면 곡 뒷부분이 통째로 첫 템포로 남는다 — 곡선 모양이 남도록 균등하게 솎아낸다
      const step = (points.length - 1) / (MAX_TEMPO_POINTS - 1);
      const kept = [];
      for (let i = 0; i < MAX_TEMPO_POINTS; i++) kept.push(points[Math.round(i * step)]);
      drop.push(`템포 변화점 ${points.length}개 → aria 상한 ${MAX_TEMPO_POINTS}개로 균등하게 솎아냄(모양은 유지, 계단 해상도만 낮아짐)`);
      points = kept.filter((p, i) => i === 0 || p.bar !== kept[i - 1].bar);
    }
    tempoMap.push(...points);
    if (offBar) warn.push(`마디 경계가 아닌 곳의 템포 변화 ${offBar}개를 가장 가까운 마디로 옮겼습니다`);
    if (outOfRange) drop.push(`1마디 안이거나 ${MAX_BAR}마디를 넘는 템포 변화 ${outOfRange}개 — aria의 템포 변화는 2~${MAX_BAR}마디만 가능`);
  }

  // ---------- 파트 → aria 트랙 ----------
  const stats = { overlaps: 0, orphanOffs: 0, hanging: 0 };
  const parts = [];
  trackEvents.forEach((events, ti) => {
    const found = collectParts(events, stats);
    const multi = found.length > 1; // 한 MIDI 트랙이 여러 채널을 쓰면 이름만으로는 구분이 안 된다
    for (const p of found) {
      const base = p.name || `트랙 ${ti + 1}`; // 트랙 이름 메타가 없을 때의 이름
      parts.push({ ...p, midiTrack: ti, label: base + (multi ? ` ch${p.ch + 1}` : "") });
    }
  });
  // format 1의 첫 트랙 이름은 관례상 곡 제목이다 — 그 트랙에 노트가 없을 때만 제목으로 쓴다
  const conductor = !parts.some(p => p.midiTrack === 0) ? trackEvents[0]?.find(e => e.meta === 0x03) : null;
  const title = (typeof opts.title === "string" && opts.title.trim())
    || (conductor ? metaText(conductor.body) : "") || "가져온 MIDI";

  if (parts.length > MAX_TRACKS) {
    const cut = parts.splice(MAX_TRACKS);
    drop.push(`트랙 ${cut.length}개(노트 ${cut.reduce((s, p) => s + p.notes.length, 0)}개) — aria는 트랙 ${MAX_TRACKS}개가 상한: ${cut.map(p => p.label || `ch${p.ch + 1}`).join(", ")}`);
  }

  const unmapped = new Map(); // GM 드럼 노트 → 버린 개수
  let overBar = 0, clampedDur = 0, tooShort = 0, cutNotes = 0, emptyTracks = 0;
  const used = new Set();
  const tracks = [];
  const presetLines = [];
  for (const p of parts) {
    const drum = p.ch === DRUM_CH;
    // 샘플 프리셋은 사운드폰트가 있어야 소리가 난다 — 기본은 언제나 울리는 합성 프리셋으로 고른다
    const preset = drum ? (preferSamples ? "sf-kit" : "acoustic-kit") : guessPreset(p.program ?? 0, preferSamples);
    const notes = [];
    for (const raw of p.notes) {
      let pitch;
      if (drum) {
        pitch = GM_DRUM[raw.key];
        if (!pitch) { unmapped.set(raw.key, (unmapped.get(raw.key) ?? 0) + 1); continue; }
      } else {
        pitch = midiToName(raw.key);
        if (!pitch) continue;
      }
      const start = toBeat(raw.on);
      const end = toBeat(raw.off === null ? Math.max(endTick, raw.on + 1) : raw.off);
      let dur = r3(end - start);
      if (dur <= 0) { dur = quantize ?? MIN_DUR; tooShort++; }
      if (dur > MAX_DUR) { dur = MAX_DUR; clampedDur++; }
      const bar = Math.floor(start / bpb) + 1;
      if (bar > MAX_BAR) { overBar++; continue; }
      notes.push({ bar, beat: r3(start - (bar - 1) * bpb), pitch, dur, vel: Math.min(127, Math.max(1, raw.vel | 0)) });
    }
    if (!notes.length) { emptyTracks++; continue; }
    notes.sort((a, b) => (a.bar - b.bar) || (a.beat - b.beat));
    if (notes.length > MAX_NOTES) { cutNotes += notes.length - MAX_NOTES; notes.length = MAX_NOTES; }
    const name = uniqueName(p.label.trim() || `트랙 ${tracks.length + 1}`, used);
    tracks.push({
      name, preset, notes,
      // CC7·CC10은 0~127이다. 팬은 64를 정중앙으로 보는 관례를 따른다(내보내기의 (pan+1)*63.5와 짝).
      volume: p.vol === null ? 0.8 : Math.round((p.vol / 127) * 100) / 100,
      pan: p.pan === null ? 0 : Math.round(Math.min(1, Math.max(-1, (p.pan - 64) / 63)) * 100) / 100
    });
    presetLines.push(`  ${name} → ${preset}`
      + (drum ? " (채널 10 = 드럼)" : ` (GM ${p.program ?? 0}${p.program === null ? ", 프로그램 체인지가 없어 0으로 가정" : ""})`)
      + ` · 노트 ${notes.length}개`);
  }

  // ---------- 검증 ----------
  let song;
  try {
    song = validateSong({ title, bpm, timeSig, tempoMap, tracks });
  } catch (e) {
    err(`MIDI는 읽었지만 만들어진 곡이 aria 검증을 통과하지 못했습니다: ${e.message}\n`
      + "가져오기 모듈이 aria 제약을 못 맞춘 것이므로 midi-import.js를 고쳐야 합니다 — 위 메시지가 어떤 제약을 어겼는지 알려줍니다");
  }

  // ---------- 리포트 ----------
  if (unmapped.size) {
    const list = [...unmapped.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}번×${n}`).join(", ");
    drop.push(`aria 타악기 피스에 대응이 없는 드럼 노트 ${[...unmapped.values()].reduce((s, n) => s + n, 0)}개 (${list})`);
  }
  if (overBar) drop.push(`${MAX_BAR}마디를 넘는 노트 ${overBar}개 — aria의 마디 상한`);
  if (cutNotes) drop.push(`한 트랙 ${MAX_NOTES}개를 넘는 노트 ${cutNotes}개(뒷부분부터 잘림)`);
  if (emptyTracks) drop.push(`쓸 수 있는 노트가 하나도 남지 않은 채널 ${emptyTracks}개`);
  if (clampedDur) warn.push(`${MAX_DUR}박을 넘는 긴 노트 ${clampedDur}개를 ${MAX_DUR}박으로 줄였습니다`);
  if (tooShort) warn.push(`반올림·격자 스냅으로 길이가 0이 된 노트 ${tooShort}개를 ${quantize ?? MIN_DUR}박으로 늘렸습니다`);
  if (stats.hanging) warn.push(`짝이 되는 note off가 없는 노트 ${stats.hanging}개 — 버리지 않고 곡 끝(${r3(endTick / ticksPerBeat)}박)까지 울리게 했습니다`);
  if (stats.orphanOffs) warn.push(`시작 없이 끝만 있는 note off ${stats.orphanOffs}개는 무시했습니다`);
  if (stats.overlaps) warn.push(`같은 음이 끝나기 전에 다시 시작한 곳 ${stats.overlaps}군데 — 먼저 시작한 음을 먼저 오는 note off와 짝지었습니다(FIFO)`);
  if (bpmClamped) warn.push(`aria 범위(20~300bpm)를 벗어난 템포 ${bpmClamped}개를 범위 안으로 맞췄습니다`);

  const noteCount = song.tracks.reduce((s, t) => s + t.notes.length, 0);
  if (!noteCount) warn.push("노트를 하나도 찾지 못했습니다 — 컨트롤 정보만 든 MIDI이거나 트랙이 비어 있습니다");
  const lines = [
    `SMF format ${format} · ${divisionLabel} · MTrk ${chunks.length}개${quantize ? ` · ${quantize}박 격자로 스냅` : " · 격자 스냅 없음(소수 셋째 자리 반올림)"}`,
    `"${song.title}" — ${song.bpm}bpm ${song.timeSig[0]}/${song.timeSig[1]} · 트랙 ${song.tracks.length}개 · 노트 ${noteCount}개`
  ];
  if (presetLines.length) lines.push("프리셋 추정:", ...presetLines);
  if (song.tempoMap.length)
    lines.push(`템포 변화 ${song.tempoMap.length}개: ${song.tempoMap.slice(0, 8).map(t => `${t.bar}마디→${t.bpm}`).join(", ")}${song.tempoMap.length > 8 ? " …" : ""}`);
  if (drop.length) lines.push("버린 것:", ...drop.map(d => `  - ${d}`));
  if (warn.length) lines.push("경고:", ...warn.map(w => `  - ${w}`));

  return { song, report: lines.join("\n") };
}

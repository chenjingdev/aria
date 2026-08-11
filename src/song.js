// aria — 곡 모델: 생성·검증·피치/시간 계산
import {
  DRUM_PIECES, TEMPLATES, isDrumPreset, presetExists, presetLabel, presetDurationSec, drumPieces,
  presetArticulations
} from "./presets.js";

const NOTE_RE = /^([A-Ga-g])([#b]?)(-?\d)$/;
const SEMIS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteToMidi(pitch) {
  const m = NOTE_RE.exec(String(pitch).trim());
  if (!m) return null;
  const v = SEMIS[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (parseInt(m[3], 10) + 1) * 12;
  return v >= 0 && v <= 127 ? v : null;
}

export function midiToFreq(midi) { return 440 * 2 ** ((midi - 69) / 12); }

export function beatsPerBar(song) {
  const [n, d] = song.timeSig;
  return n * (4 / d); // 4분음표 단위 박 수
}
// 기준 템포의 1박 길이. 템포 변화가 있는 곡에서는 beatToSec를 써야 한다.
export function secondsPerBeat(song) { return 60 / song.bpm; }
export function noteStartBeat(song, note) { return (note.bar - 1) * beatsPerBar(song) + note.beat; }

// ---------- 템포 맵 ----------
// song.bpm이 기준 템포(1마디)이고, song.tempoMap의 {bar, bpm, ramp}가 그 위의 변화점이다.
// ramp:true면 직전 변화점부터 이 마디까지 템포가 선형으로 변한다(rit./accel.).
export const MAX_TEMPO_POINTS = 64;
export const MAX_SECTIONS = 64;
export const MAX_ARTICULATION_REGIONS = 100;

// 한 음의 주법은 note-on이 놓인 마디에서 결정한다. 구간 override가 없으면 기존
// track.articulation으로 돌아가고, 그것도 없으면 sampler가 preset 기본 주법을 고른다.
export function effectiveArticulation(track, bar) {
  const regions = Array.isArray(track?.articulationRegions) ? track.articulationRegions : [];
  const region = regions.find(item => item && bar >= item.from && bar <= item.to);
  return region?.articulation ?? track?.articulation;
}

// 렌더·내보내기 전에 한 번 만들어 두고 재사용하는 구간 테이블.
// 각 구간: [startBeat, endBeat)에서 bpm이 bpm0 → bpm1로 선형 변화, startSec에서 시작.
export function tempoSegments(song) {
  const bpb = beatsPerBar(song);
  const points = [{ beat: 0, bpm: song.bpm, ramp: false }];
  for (const t of song.tempoMap ?? []) {
    const beat = (t.bar - 1) * bpb;
    if (beat <= 0) points[0].bpm = t.bpm; // 1마디 항목은 기준 템포를 덮어쓴다
    else points.push({ beat, bpm: t.bpm, ramp: !!t.ramp });
  }
  points.sort((a, b) => a.beat - b.beat);

  const segs = [];
  let sec = 0;
  for (let i = 0; i < points.length; i++) {
    const cur = points[i], next = points[i + 1];
    const bpm0 = cur.bpm;
    // 마지막 구간은 끝이 없다 — 곡 끝까지 같은 템포
    const endBeat = next ? next.beat : Infinity;
    const bpm1 = next && next.ramp ? next.bpm : bpm0;
    const seg = { startBeat: cur.beat, endBeat, bpm0, bpm1, startSec: sec };
    segs.push(seg);
    if (next) sec += segmentSeconds(seg, endBeat - cur.beat);
  }
  return segs;
}

// 구간 시작에서 u박 지난 시점까지의 경과 초
function segmentSeconds(seg, u) {
  if (u <= 0) return 0;
  const { bpm0, bpm1, startBeat, endBeat } = seg;
  if (bpm1 === bpm0 || !Number.isFinite(endBeat)) return (60 * u) / bpm0;
  const k = (bpm1 - bpm0) / (endBeat - startBeat); // 박당 bpm 변화율
  // log1p — bpm 차가 극히 작을 때 log((bpm0+ku)/bpm0)는 인자에서 유효숫자가 전부 사라진다
  return (60 / k) * Math.log1p((k * u) / bpm0);
}

// 절대 박 위치 → 곡 시작부터의 초
export function beatToSec(segs, beat) {
  if (beat <= 0) return 0;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].startBeat <= beat) lo = mid; else hi = mid - 1;
  }
  const seg = segs[lo];
  return seg.startSec + segmentSeconds(seg, Math.min(beat, seg.endBeat) - seg.startBeat);
}

// beatToSec의 역함수. 녹음 클립처럼 길이가 초 단위로 정해진 음원을
// 템포 변화가 있는 악보 위에 정확한 박 길이로 표시할 때 사용한다.
export function secToBeat(segs, sec) {
  if (sec <= 0) return 0;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].startSec <= sec) lo = mid; else hi = mid - 1;
  }
  const seg = segs[lo];
  const d = sec - seg.startSec;
  if (seg.bpm1 === seg.bpm0 || !Number.isFinite(seg.endBeat))
    return seg.startBeat + seg.bpm0 * d / 60;
  const k = (seg.bpm1 - seg.bpm0) / (seg.endBeat - seg.startBeat);
  return seg.startBeat + (seg.bpm0 * Math.expm1(k * d / 60)) / k;
}

export function notePlaybackEndBeat(song, track, note, segs = tempoSegments(song)) {
  const startBeat = noteStartBeat(song, note);
  const writtenEnd = startBeat + note.dur;
  const durationSec = presetDurationSec(track.preset);
  if (durationSec === null) return writtenEnd;
  const recordedEnd = secToBeat(segs, beatToSec(segs, startBeat) + durationSec);
  return Math.max(writtenEnd, recordedEnd);
}

// 해당 박에서 실제로 울리고 있는 bpm (MIDI 내보내기·표시용)
export function bpmAtBeat(segs, beat) {
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].startBeat <= beat) lo = mid; else hi = mid - 1;
  }
  const seg = segs[lo];
  if (seg.bpm1 === seg.bpm0 || !Number.isFinite(seg.endBeat)) return seg.bpm0;
  const u = Math.min(beat, seg.endBeat) - seg.startBeat;
  return seg.bpm0 + ((seg.bpm1 - seg.bpm0) / (seg.endBeat - seg.startBeat)) * u;
}

export function hasTempoChanges(song) { return (song.tempoMap ?? []).length > 0; }

export function totalBars(song) {
  const bpb = beatsPerBar(song);
  const segs = tempoSegments(song);
  let max = 8;
  for (const t of song.tracks)
    for (const n of t.notes) {
      const endBeat = notePlaybackEndBeat(song, t, n, segs);
      max = Math.max(max, Math.ceil(endBeat / bpb));
    }
  return max;
}

export function createSong({ title, bpm, template, timeSig } = {}) {
  if (template !== undefined && !Object.hasOwn(TEMPLATES, template))
    throw new Error(`알 수 없는 템플릿 "${template}" — 사용 가능: ${Object.keys(TEMPLATES).join(", ")}`);
  const tpl = template ? TEMPLATES[template] : null;
  return {
    title: title || (tpl ? `${tpl.name} 스케치` : "무제"),
    bpm: bpm ?? tpl?.bpm ?? 100,
    timeSig: timeSig ?? [4, 4],
    tempoMap: [],
    tracks: (tpl?.tracks ?? []).map(t => ({ ...t, notes: [] }))
  };
}

const err = m => { throw new Error(m); };

// 트랙이 프리셋 값을 덮어쓸 수 있는 항목: [키, 최소, 최대, 설명]
export const TRACK_OVERRIDES = [
  ["velRange", 0, 1, "벨로시티 범위 — 0이면 모든 노트를 중간 세기로, 1이면 악보의 velocity를 그대로 SoundFont 엔진에 보낸다"],
  ["reverb", 0, 1, "리버브 센드 양"],
  ["eqLow", -12, 12, "저역 셸빙(200Hz) dB — 답답하면 내리고 얇으면 올린다"],
  ["eqMid", -12, 12, "중역 피킹(1kHz, Q 0.9) dB — 박스톤·비음을 깎거나 존재감을 올린다"],
  ["eqHigh", -12, 12, "고역 셸빙(4kHz) dB — 쨍하면 내리고 답답하면 올린다"]
];

// tempoMap 검증 — 마디 오름차순, 마디 중복 없음, 1마디 항목의 ramp는 의미가 없어 무시
export function validateTempoMap(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) err("tempoMap은 배열이어야 합니다 — [{bar, bpm, ramp?}, ...]");
  if (raw.length > MAX_TEMPO_POINTS) err(`템포 변화점은 최대 ${MAX_TEMPO_POINTS}개입니다 (받은 값: ${raw.length}개)`);
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") err("tempoMap 항목은 {bar, bpm, ramp?} 객체여야 합니다");
    const bar = Number(t.bar), bpm = Number(t.bpm);
    if (!Number.isInteger(bar) || bar < 1 || bar > 999)
      err(`tempoMap의 bar는 1~999 정수 (받은 값: ${JSON.stringify(t.bar)})`);
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)
      err(`tempoMap의 bpm은 20~300 (받은 값: ${JSON.stringify(t.bpm)})`);
    if (seen.has(bar)) err(`tempoMap에 ${bar}마디가 중복됩니다 — 한 마디에 템포 변화는 하나만`);
    seen.add(bar);
    out.push(bar === 1 ? { bar, bpm } : { bar, bpm, ramp: !!t.ramp });
  }
  out.sort((a, b) => a.bar - b.bar);
  return out;
}

// 곡 전체를 검증하고 정규화된 사본을 반환. 실패 시 한국어 메시지로 throw.
export function validateSong(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) err("곡은 JSON 객체여야 합니다");
  const song = {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 120) : "무제",
    bpm: Number(raw.bpm),
    timeSig: Array.isArray(raw.timeSig) ? raw.timeSig.map(Number) : [4, 4],
    tempoMap: [],
    tracks: []
  };
  if (!Number.isFinite(song.bpm) || song.bpm < 20 || song.bpm > 300) err("bpm은 20~300 사이 숫자여야 합니다");
  const [n, d] = song.timeSig;
  if (!Number.isInteger(n) || n < 1 || n > 16 || ![2, 4, 8, 16].includes(d))
    err("timeSig는 [박자수(1~16), 박자단위(2|4|8|16)] 형식이어야 합니다 (예: [4,4])");
  song.tempoMap = validateTempoMap(raw.tempoMap);
  // 1마디 항목은 곧 기준 템포다 — bpm으로 흡수해 "표시된 bpm과 실제 템포가 다른" 상태를 만들지 않는다
  const atOne = song.tempoMap.find(t => t.bar === 1);
  if (atOne) { song.bpm = atOne.bpm; song.tempoMap = song.tempoMap.filter(t => t !== atOne); }
  if (!Array.isArray(raw.tracks)) err("tracks는 배열이어야 합니다");
  if (raw.tracks.length > 32) err("트랙은 최대 32개입니다");
  const names = new Set();
  const bpb = beatsPerBar(song);
  for (const rt of raw.tracks) {
    const name = typeof rt?.name === "string" ? rt.name.trim() : "";
    if (!name) err("모든 트랙에 name이 필요합니다");
    if (names.has(name.toLowerCase())) err(`트랙 이름 중복: "${name}"`);
    names.add(name.toLowerCase());
    if (!presetExists(rt.preset))
      err(`트랙 "${name}"의 preset "${rt.preset}"이 없습니다 — list_presets로 확인하세요`);
    const track = {
      name, preset: rt.preset,
      // 잡음·미세 흔들림의 씨앗을 고정하는 값. 예전에는 이름을 그대로 씨앗으로 썼던 탓에
      // 트랙 이름만 바꿔도 소리가 미묘하게 달라졌다. 없으면 현재 이름으로 한 번 굳혀 두므로
      // 기존 곡의 소리는 그대로 유지되고, 이후 이름을 바꿔도 소리는 변하지 않는다.
      seed: rt.seed === undefined || rt.seed === null ? name : String(rt.seed),
      volume: rt.volume === undefined ? 0.8 : Number(rt.volume),
      pan: rt.pan === undefined ? 0 : Number(rt.pan),
      notes: []
    };
    // 상한이 2인 이유: 1.0이 0dB(원래 크기)이고 2.0이 약 +6dB다. 예전 상한 1은 "기본이 최대"라
    // 한 악기를 키우려면 나머지를 다 줄여야 했다. 넘치는 만큼은 마스터 리미터가 받아 준다
    if (!Number.isFinite(track.volume) || track.volume < 0 || track.volume > 2)
      err(`트랙 "${name}"의 volume은 0~2 (1.0이 원래 크기=0dB, 2.0이 약 +6dB)`);
    if (!Number.isFinite(track.pan) || track.pan < -1 || track.pan > 1) err(`트랙 "${name}"의 pan은 -1~1`);
    if (rt.mute === true) track.mute = true; // 음소거 — 렌더(재생·내보내기)에서 제외
    if (rt.solo === true) track.solo = true; // 솔로 — 하나라도 켜져 있으면 그 트랙들만 들린다(음소거보다 우선)
    if (rt.articulation !== undefined && rt.articulation !== null) {
      const articulation = typeof rt.articulation === "string" ? rt.articulation.trim() : "";
      const definitions = presetArticulations(rt.preset);
      if (!articulation || !definitions || !Object.hasOwn(definitions, articulation)) {
        const choices = definitions ? Object.keys(definitions).join(", ") : "(이 프리셋은 별도 연주법 선택 없음)";
        err(`트랙 "${name}"의 articulation ${JSON.stringify(rt.articulation)}을 ${rt.preset}에서 찾을 수 없습니다 — 선택 가능: ${choices}`);
      }
      track.articulation = articulation;
    }
    // 마디 구간별 실제 녹음 주법. 서로 겹치면 어느 주법을 쓸지 모호하므로 허용하지
    // 않고, 같은 주법이 바로 이어지는 항목은 한 구간으로 합쳐 저장 표현을 고정한다.
    if (rt.articulationRegions !== undefined && rt.articulationRegions !== null) {
      if (!Array.isArray(rt.articulationRegions))
        err(`트랙 "${name}"의 articulationRegions는 배열이어야 합니다 — [{from,to,articulation}, ...]`);
      if (rt.articulationRegions.length > MAX_ARTICULATION_REGIONS)
        err(`트랙 "${name}"의 구간 주법은 최대 ${MAX_ARTICULATION_REGIONS}개입니다`);
      const definitions = presetArticulations(rt.preset);
      const regions = [];
      for (const rawRegion of rt.articulationRegions) {
        if (!rawRegion || typeof rawRegion !== "object" || Array.isArray(rawRegion))
          err(`트랙 "${name}"의 articulationRegions 항목은 {from,to,articulation} 객체여야 합니다`);
        const from = Number(rawRegion.from), to = Number(rawRegion.to ?? rawRegion.from);
        const articulation = typeof rawRegion.articulation === "string" ? rawRegion.articulation.trim() : "";
        if (!Number.isInteger(from) || from < 1 || from > 999)
          err(`트랙 "${name}" 구간 주법의 from은 1~999 정수여야 합니다`);
        if (!Number.isInteger(to) || to < from || to > 999)
          err(`트랙 "${name}" 구간 주법의 to는 from 이상 999 이하 정수여야 합니다`);
        if (!articulation || !definitions || !Object.hasOwn(definitions, articulation)) {
          const choices = definitions ? Object.keys(definitions).join(", ") : "(이 프리셋은 별도 연주법 선택 없음)";
          err(`트랙 "${name}"의 구간 articulation ${JSON.stringify(rawRegion.articulation)}을 ${rt.preset}에서 찾을 수 없습니다 — 선택 가능: ${choices}`);
        }
        regions.push({ from, to, articulation });
      }
      regions.sort((a, b) => a.from - b.from || a.to - b.to || a.articulation.localeCompare(b.articulation));
      const canonical = [];
      for (const region of regions) {
        const previous = canonical.at(-1);
        if (previous && region.from <= previous.to)
          err(`트랙 "${name}"의 구간 주법 ${previous.from}~${previous.to}마디와 ${region.from}~${region.to}마디가 겹칩니다 — 한 시점에는 주법 하나만 선택할 수 있습니다`);
        if (previous && previous.articulation === region.articulation && previous.to + 1 === region.from)
          previous.to = region.to;
        else canonical.push(region);
      }
      if (canonical.length) track.articulationRegions = canonical;
    }
    // 프리셋 상수를 덮어쓰는 선택적 음색 파라미터 — 값이 없으면 키 자체를 남기지 않는다
    for (const [key, lo, hi, label] of TRACK_OVERRIDES) {
      if (rt[key] === undefined || rt[key] === null) continue;
      // Number() 강제변환을 쓰면 ""·[]·[1.5]·true가 조용히 통과해 표현이 왜곡된다 — 숫자만 받는다
      const v = rt[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi)
        err(`트랙 "${name}"의 ${key}는 ${lo}~${hi} 사이 숫자여야 합니다 (${label}) — 받은 값: ${JSON.stringify(v)}`);
      track[key] = v;
    }
    // 구간 게인 — 특정 마디 구간에서만 이 트랙의 음량을 dB로 조절 (구간 믹싱: "여기서만 심벌 -6dB")
    if (rt.gains !== undefined && rt.gains !== null) {
      if (!Array.isArray(rt.gains)) err(`트랙 "${name}"의 gains는 배열이어야 합니다 — [{from,to,db}, ...]`);
      if (rt.gains.length > 100) err(`트랙 "${name}"의 구간 게인은 최대 100개입니다`);
      const gains = [];
      for (const rg of rt.gains) {
        if (!rg || typeof rg !== "object") err(`트랙 "${name}"의 gains 항목은 {from,to,db} 객체여야 합니다`);
        const from = Number(rg.from), to = Number(rg.to ?? rg.from), db = Number(rg.db);
        if (!Number.isInteger(from) || from < 1 || from > 999) err(`트랙 "${name}" 구간 게인의 from은 1~999 정수여야 합니다`);
        if (!Number.isInteger(to) || to < from || to > 999) err(`트랙 "${name}" 구간 게인의 to는 from 이상 999 이하 정수여야 합니다`);
        if (!Number.isFinite(db) || db < -60 || db > 12) err(`트랙 "${name}" 구간 게인의 db는 -60~+12 사이여야 합니다`);
        // to_db가 있으면 구간에 걸쳐 db → to_db로 서서히 변하는 램프다(페이드인·페이드아웃).
        // 램프는 샘플 단위로 걸리므로 길게 끄는 화음 하나짜리 엔딩도 실제로 사그라든다.
        if (rg.to_db !== undefined && rg.to_db !== null) {
          const toDb = Number(rg.to_db);
          if (!Number.isFinite(toDb) || toDb < -60 || toDb > 12)
            err(`트랙 "${name}" 구간 게인의 to_db는 -60~+12 사이여야 합니다 (받은 값: ${JSON.stringify(rg.to_db)})`);
          if (toDb !== db) { gains.push({ from, to, db: Math.round(db * 10) / 10, to_db: Math.round(toDb * 10) / 10 }); continue; }
        }
        if (db !== 0) gains.push({ from, to, db: Math.round(db * 10) / 10 });
      }
      if (gains.length) {
        gains.sort((a, b) => a.from - b.from || a.to - b.to);
        track.gains = gains;
      }
    }
    const rawNotes = rt.notes ?? [];
    if (!Array.isArray(rawNotes)) err(`트랙 "${name}"의 notes는 배열이어야 합니다`);
    if (rawNotes.length > 10000) err(`트랙 "${name}"의 노트가 10000개를 넘습니다`);
    for (const rn of rawNotes) track.notes.push(validateNote(rn, track, song, bpb));
    track.notes.sort((a, b) => noteStartBeat(song, a) - noteStartBeat(song, b) || String(a.pitch).localeCompare(String(b.pitch)));
    song.tracks.push(track);
  }
  // 섹션 이름표 — "1절", "후렴" 처럼 곡의 어디인지 부르는 이름. 소리에는 영향이 없고
  // 사람과 AI가 같은 말로 위치를 가리키기 위한 것이다("후렴을 더 크게" 같은 지시가 통하도록)
  song.sections = [];
  if (Array.isArray(raw.sections)) {
    const seen = new Set();
    for (const rs of raw.sections) {
      if (!rs || typeof rs !== "object") err("sections 항목은 {bar, label} 객체여야 합니다");
      const bar = Number(rs.bar);
      const label = typeof rs.label === "string" ? rs.label.trim().slice(0, 24) : "";
      if (!Number.isInteger(bar) || bar < 1 || bar > 999)
        err(`섹션의 bar는 1~999 정수여야 합니다 (받은 값: ${JSON.stringify(rs.bar)})`);
      if (!label) err(`${bar}마디 섹션에 이름이 없습니다 — label을 주세요 (예: "후렴")`);
      if (seen.has(bar)) err(`${bar}마디에 섹션 이름표가 중복됩니다 — 한 마디에 하나만`);
      seen.add(bar);
      song.sections.push({ bar, label });
    }
    if (song.sections.length > MAX_SECTIONS) err(`섹션 이름표는 최대 ${MAX_SECTIONS}개입니다 (받은 값: ${song.sections.length}개)`);
    song.sections.sort((a, b) => a.bar - b.bar);
  }
  // 구간 피드백 (GUI에서 사용자가 남김) — 불량 항목은 곡을 깨지 않고 조용히 걸러낸다
  song.feedback = [];
  if (Array.isArray(raw.feedback)) {
    for (const rf of raw.feedback.slice(0, 200)) {
      if (!rf || typeof rf !== "object") continue;
      const text = typeof rf.text === "string" ? rf.text.trim().slice(0, 500) : "";
      const from = Number(rf.from_bar);
      if (!text || !Number.isInteger(from) || from < 1 || from > 999) continue;
      const toRaw = Number(rf.to_bar ?? from);
      const item = {
        id: Number.isInteger(rf.id) && rf.id > 0 ? rf.id : 0,
        from_bar: from,
        to_bar: Number.isInteger(toRaw) && toRaw >= from ? Math.min(toRaw, 999) : from,
        text,
        done: rf.done === true,
        ts: typeof rf.ts === "string" ? rf.ts : new Date().toISOString()
      };
      if (typeof rf.track === "string" && rf.track.trim()) item.track = rf.track.trim().slice(0, 60);
      song.feedback.push(item);
    }
    let next = song.feedback.reduce((m, f) => Math.max(m, f.id), 0) + 1;
    for (const f of song.feedback) if (!f.id) f.id = next++;
  }
  return song;
}

export function validateNote(rn, track, song, bpb = beatsPerBar(song)) {
  const where = `트랙 "${track.name}"`;
  if (!rn || typeof rn !== "object") err(`${where}: 노트는 객체여야 합니다`);
  const note = {
    bar: Number(rn.bar), beat: rn.beat === undefined ? 0 : Number(rn.beat),
    pitch: rn.pitch, dur: Number(rn.dur),
    vel: rn.vel === undefined ? 96 : Number(rn.vel)
  };
  if (!Number.isInteger(note.bar) || note.bar < 1 || note.bar > 999)
    err(`${where}: bar는 1~999 정수 (받은 값: ${JSON.stringify(rn.bar)})`);
  if (!Number.isFinite(note.beat) || note.beat < 0 || note.beat >= bpb)
    err(`${where}: beat는 0 이상 ${bpb} 미만 (마디 내 4분음표 단위 위치, 받은 값: ${JSON.stringify(rn.beat)})`);
  if (!Number.isFinite(note.dur) || note.dur <= 0 || note.dur > 64)
    err(`${where}: dur는 0보다 크고 64 이하인 박 단위 길이 (받은 값: ${JSON.stringify(rn.dur)})`);
  if (!Number.isInteger(note.vel) || note.vel < 1 || note.vel > 127)
    err(`${where}: vel은 1~127 정수 (받은 값: ${JSON.stringify(rn.vel)})`);
  if (isDrumPreset(track.preset)) {
    const pieces = drumPieces(track.preset);
    if (!Object.hasOwn(pieces, note.pitch))
      err(`${where}는 드럼 킷입니다 — pitch는 다음 중 하나: ${Object.keys(pieces).join(", ")} (받은 값: ${JSON.stringify(rn.pitch)})`);
  } else if (noteToMidi(note.pitch) === null) {
    err(`${where}: pitch "${rn.pitch}"를 해석할 수 없습니다 — "C4", "F#3", "Bb2" 형식 (코드명은 개별 음으로 풀어서 넣으세요)`);
  }
  // 휘어 오르내림 — 음이 울리는 동안 이 반음 수만큼 미끄러진다. 값이 없으면 키 자체를 남기지 않는다
  if (rn.bend !== undefined && rn.bend !== null) {
    const b = Number(rn.bend);
    if (!Number.isFinite(b) || b < -12 || b > 12)
      err(`${where}: bend는 -12~12 반음이어야 합니다 (양수면 올라가고 음수면 떨어진다, 받은 값: ${JSON.stringify(rn.bend)})`);
    if (b !== 0) {
      if (isDrumPreset(track.preset)) err(`${where}는 드럼 킷이라 bend를 쓸 수 없습니다`);
      note.bend = Math.round(b * 100) / 100;
    }
  }
  return note;
}

export function findTrack(song, name) {
  const t = song.tracks.find(t => t.name.toLowerCase() === String(name).trim().toLowerCase());
  if (!t) err(`트랙 "${name}"이 없습니다 — 현재 트랙: ${song.tracks.map(t => t.name).join(", ") || "(없음)"}`);
  return t;
}

export function songText(song) { return JSON.stringify(song, null, 2); }

export function songSummary(song) {
  const notes = song.tracks.reduce((s, t) => s + t.notes.length, 0);
  const trackList = song.tracks.map(t => {
    const ov = TRACK_OVERRIDES.filter(([k]) => t[k] !== undefined).map(([k]) => `${k}=${t[k]}`);
    const articulation = t.articulation ? `, articulation=${t.articulation}` : "";
    const articulationRegions = t.articulationRegions?.length
      ? `, 구간 주법 ${t.articulationRegions.length}곳` : "";
    const gains = !t.gains ? "" : t.gains.length <= 3
      ? `, 🎚${t.gains.map(g => `${g.from}${g.to !== g.from ? `~${g.to}` : ""}마디 ${g.db > 0 ? "+" : ""}${g.db}dB`).join(" · ")}`
      : `, 🎚구간 게인 ${t.gains.length}개`;
    return `${t.mute ? "🔇" : ""}${t.name}(${presetLabel(t.preset)}, 노트 ${t.notes.length}개${ov.length ? `, ${ov.join(" ")}` : ""}${articulation}${articulationRegions}${gains})`;
  }).join(" · ");
  const tm = song.tempoMap ?? [];
  const tempoLine = tm.length
    ? `\n템포 변화 ${tm.length}개: ${tm.map(t => `${t.bar}마디→${t.bpm}${t.ramp ? "(점진)" : ""}`).join(", ")}`
    : "";
  const openFb = (song.feedback ?? []).filter(f => !f.done).length;
  const fbLine = openFb ? `\n💬 처리 안 된 구간 피드백 ${openFb}건 — list_feedback로 확인하세요` : "";
  return `"${song.title}" — ${song.bpm}bpm ${song.timeSig[0]}/${song.timeSig[1]} · ${totalBars(song)}마디 · 트랙 ${song.tracks.length}개, 노트 ${notes}개${trackList ? `\n${trackList}` : ""}${tempoLine}${fbLine}`;
}

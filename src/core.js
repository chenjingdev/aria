// aria — 상태 + 작곡 연산 디스패처. MCP와 HTTP API가 같은 연산을 공유한다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DRUM_PIECES, TEMPLATES, SF_PRESETS, SF_DRUM_KITS,
  isDrumPreset, presetLabel, presetKind, presetArticulations
} from "./presets.js";
import { samplerAssetStatus, samplerAssetName, samplerEngineLabel } from "./sampler-assets.js";
import {
  createSong, validateSong, validateNote, findTrack, songText, songSummary, totalBars, beatsPerBar,
  tempoSegments, beatToSec, notePlaybackEndBeat, TRACK_OVERRIDES, MAX_TEMPO_POINTS, MAX_SECTIONS
} from "./song.js";
import { renderRange } from "./sampler-renderer.js";
import { wavBuffer } from "./renderer.js";
import { lufs } from "./master.js";
import { midiBuffer } from "./midi.js";
import { importMidi } from "./midi-import.js";
import { detectKey, outOfKey } from "./key.js";
import { hashSeed, mulberry32 } from "./rng.js";
import { startPlayback, stopPlayback, isPlaying, playInfo, levelReport } from "./player.js";

// ARIA_DATA_DIR: 테스트 등에서 실제 자동 저장을 건드리지 않기 위한 오버라이드
const DATA_DIR = process.env.ARIA_DATA_DIR || path.join(os.homedir(), ".aria");
const AUTOSAVE = path.join(DATA_DIR, "song.json");
const EXPORT_DIR = path.join(os.homedir(), "Music", "aria");

export const state = {
  song: null,
  guiUrl: null,
  log: [] // {id, at, source, text}
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function broadcast(ev) { for (const fn of listeners) { try { fn(ev); } catch { /* 리스너 오류 무시 */ } } }

// 새 트랙·템플릿을 만들 때 필요한 음원이 실제로 열리는지 확인한다.
// 누락된 SoundFont/SFZ를 다른 음원으로 바꾸거나 무음으로 진행하지 않는다.
function requirePresetAvailable(id) {
  const spec = SF_PRESETS[id] ?? SF_DRUM_KITS[id];
  if (!spec) throw new Error(`preset "${id}"이 없습니다 — list_presets로 확인하세요`);
  const status = samplerAssetStatus(spec);
  if (!status.available)
    throw new Error(`preset "${id}"에 필요한 음원 ${samplerAssetName(spec, status)}을 사용할 수 없습니다: ${status.reason}`);
  return spec;
}

let logSeq = 0;
export function addLog(source, text) {
  // 같은 밀리초에 같은 작업이 반복돼도 UI가 서로 다른 기록으로 보존할 수 있는 단조 증가 ID.
  const entry = { id: `${process.pid}-${++logSeq}`, at: Date.now(), source, text };
  state.log.push(entry);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  broadcast({ type: "log", entry });
}

let saveTimer = null;
let lastWriteMs = 0; // 이 인스턴스가 마지막으로 자동 저장을 쓴 시각(파일 mtime)
function writeAutosave() {
  // 원자적 쓰기: 임시 파일에 쓴 뒤 rename — 중단돼도 기존 파일이 살아남는다
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 다중 인스턴스 보호: 내 마지막 쓰기 이후 다른 인스턴스가 파일을 갱신했다면 덮지 않는다
  // (MCP stdio로 뜬 낡은 인스턴스가 종료·연산 시 현재 작업을 12시간 전 곡으로 되돌리는 사고 방지)
  try {
    const m = fs.statSync(AUTOSAVE).mtimeMs;
    if (lastWriteMs && m > lastWriteMs + 500) {
      console.error("[aria] 자동 저장 건너뜀 — 더 최신의 다른 aria 인스턴스가 곡을 갱신했습니다");
      return;
    }
  } catch { /* 파일 없음 — 첫 저장 */ }
  const tmp = `${AUTOSAVE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state.song));
  fs.renameSync(tmp, AUTOSAVE);
  try { lastWriteMs = fs.statSync(AUTOSAVE).mtimeMs; } catch { /* noop */ }
}
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeAutosave(); } catch (e) { console.error("[aria] 자동 저장 실패:", e.message); }
  }, 300);
}

// 종료 직전 호출 — 디바운스 중인 저장을 잃지 않는다
export function flushAutosave() {
  if (!saveTimer || !state.song) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try { writeAutosave(); } catch (e) { console.error("[aria] 종료 저장 실패:", e.message); }
}

export function loadAutosave() {
  try {
    if (fs.existsSync(AUTOSAVE)) {
      state.song = validateSong(JSON.parse(fs.readFileSync(AUTOSAVE, "utf8")));
      lastWriteMs = fs.statSync(AUTOSAVE).mtimeMs; // 복원 시점 기준 — 이후 남이 갱신하면 내 쓰기가 양보한다
      return true;
    }
  } catch (e) { console.error("[aria] 자동 저장 복원 실패(새 곡으로 시작):", e.message); }
  return false;
}

function mutated() {
  autosave();
  broadcast({ type: "state", song: state.song, playing: playInfo(), songs: libraryNames(), ...keyInfo() });
}

// 조성 판정과 "벗어난 음" 목록 — 화면이 표시하는 데 쓴다.
// 확신이 없을 때는 아무것도 안 보낸다: 근거 없는 빨간 표시는 없는 것보다 나쁘다.
// (검증에서 확신도 0.5~0.7 구간의 정답률이 22%까지 떨어지는 게 확인돼 문턱을 0.7로 올렸다)
export const KEY_MIN_CONFIDENCE = 0.7;
export function keyTrusted(key) {
  return !!key && key.tonic !== null && key.confidence >= KEY_MIN_CONFIDENCE
    && !key.warning && (!key.alt || key.score - key.alt.score >= 0.05);
}
// 곡이 아주 크면 편집마다 계산이 이벤트 루프를 막는다(상한 곡에서 약 100ms) — 그때는 건너뛴다
const KEY_MAX_NOTES = 20000;
export function keyInfo() {
  const song = state.song;
  if (!song) return { key: null, outOfKey: {} };
  if (song.tracks.reduce((n, t) => n + t.notes.length, 0) > KEY_MAX_NOTES) return { key: null, outOfKey: {} };
  const key = detectKey(song);
  if (!keyTrusted(key)) return { key, outOfKey: {} };
  return { key, outOfKey: Object.fromEntries([...outOfKey(song, key)].map(([n, set]) => [n, [...set]])) };
}

// ---------- 곡 라이브러리 (~/.aria/songs/*.json) ----------
const SONGS_DIR = path.join(DATA_DIR, "songs");
const songFile = name => path.join(SONGS_DIR, name.replace(/[/\\:*?"<>|]/g, "_").trim().slice(0, 80) + ".json");

export function libraryNames() {
  try {
    return fs.readdirSync(SONGS_DIR).filter(f => f.endsWith(".json"))
      .map(f => {
        const p = path.join(SONGS_DIR, f);
        try { return { name: JSON.parse(fs.readFileSync(p, "utf8")).title, mtime: fs.statSync(p).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean).sort((a, b) => a.mtime - b.mtime).map(x => x.name);
  } catch { return []; }
}

function saveToLibrary(name, song) {
  fs.mkdirSync(SONGS_DIR, { recursive: true });
  const file = songFile(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...song, title: name }));
  fs.renameSync(tmp, file);
}

function readFromLibrary(name) {
  const file = songFile(name);
  if (!fs.existsSync(file))
    throw new Error(`라이브러리에 "${name}"이 없습니다 — 보관된 곡: ${libraryNames().join(", ") || "(없음)"}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function needSong() {
  if (!state.song) throw new Error("아직 곡이 없습니다 — 먼저 new_song으로 곡을 만드세요");
  return state.song;
}

// 다단계 되돌리기 — 곡을 바꾸는 모든 연산의 "직전 상태"를 runOp이 자동으로 쌓는다.
// 개별 연산은 스냅숏을 찍지 않는다: 검증 실패로 예외가 나면 애초에 쌓이지 않으므로
// "실패한 연산이 직전 스냅숏을 덮어쓰는" 사고가 구조적으로 불가능하다.
const UNDO_DEPTH = 30;
const UNDO_BYTES = 40_000_000; // 큰 곡 30개를 다 들고 있지 않도록 총량으로도 제한
let undoStack = []; // [{ label, json }] — 뒤쪽이 최신
let redoStack = [];

function trimUndo() {
  while (undoStack.length > UNDO_DEPTH) undoStack.shift();
  let bytes = undoStack.reduce((s, e) => s + e.json.length, 0);
  while (undoStack.length > 1 && bytes > UNDO_BYTES) bytes -= undoStack.shift().json.length;
}

function pushUndo(label, json) {
  undoStack.push({ label, json });
  redoStack = []; // 새 편집이 들어오면 앞으로 갈 길은 사라진다
  trimUndo();
}

// 되돌리기/다시하기 공용 — from에서 꺼내 현재 상태를 to에 넣고 곡을 교체한다
function stepHistory(from, to, verb) {
  needSong();
  const entry = from.pop();
  if (!entry) throw new Error(`${verb}할 편집이 없습니다`);
  const restored = validateSong(JSON.parse(entry.json));
  to.push({ label: entry.label, json: JSON.stringify(state.song) });
  if (to.length > UNDO_DEPTH) to.shift();
  state.song = restored;
  mutated();
  return entry.label;
}

// 곡을 바꾸는 연산 — runOp이 실행 전 스냅숏을 떠 두었다가 실제로 바뀐 경우에만 쌓는다
const MUTATING = new Set([
  "new_song", "set_song", "load_song", "add_track", "remove_track", "set_track",
  "set_tempo", "clear_tempo", "set_section", "remove_section", "add_notes", "clear_notes", "delete_note", "move_note",
  "resize_note", "split_note", "move_notes", "delete_notes", "set_region_gain", "set_velocity", "set_bend",
  "insert_bars", "delete_bars", "copy_bars", "humanize", "swing", "quantize", "import_midi", "ab_load",
  "add_feedback", "resolve_feedback"
]);

const OP_LABELS = {
  new_song: "새 곡", set_song: "곡 통째 교체", load_song: "곡 불러오기",
  add_track: "트랙 추가", remove_track: "트랙 삭제", set_track: "트랙 설정 변경",
  set_tempo: "빠르기 변경", clear_tempo: "빠르기 변화점 삭제",
  set_section: "구간 이름표", remove_section: "구간 이름표 삭제",
  add_notes: "노트 추가", clear_notes: "노트 삭제", delete_note: "노트 삭제",
  move_note: "노트 이동", resize_note: "노트 길이 변경", split_note: "노트 자르기",
  move_notes: "노트 여러 개 이동", delete_notes: "노트 여러 개 삭제", set_velocity: "노트 세기 변경",
  set_bend: "음 휘기",
  set_region_gain: "구간 음량", insert_bars: "빈 마디 삽입", delete_bars: "마디 잘라내기",
  copy_bars: "구간 복제", humanize: "무작위 편차", swing: "스윙", quantize: "박자 정리",
  import_midi: "MIDI 가져오기", ab_load: "A/B 안 불러오기",
  add_feedback: "메모 추가", resolve_feedback: "메모 완료"
};

function undoLabel(name, args) {
  const base = OP_LABELS[name] ?? name;
  return args?.track ? `${base} (${args.track})` : base;
}

const CLIP_TIME_EPSILON = 1e-9;

// Recorded Clip은 악보의 짧은 trigger dur가 아니라 원본 초 길이만큼 실제로 재생된다.
// 구조 편집이 이 고정 구간의 중간을 가르면 trim/offset 없이 정직하게 표현할 수 없으므로,
// 일반 노트를 늘이거나 줄이는 로직에 들어가기 전에 실제 재생 구간으로 판정한다.
function fixedClipIntervals(song, bpb = beatsPerBar(song)) {
  const segs = tempoSegments(song);
  const intervals = [];
  for (const track of song.tracks) {
    if (presetKind(track.preset) !== "clip") continue;
    for (const note of track.notes) {
      const start = (note.bar - 1) * bpb + note.beat;
      intervals.push({
        track, note, start,
        end: notePlaybackEndBeat(song, track, note, segs)
      });
    }
  }
  return intervals;
}

function clipLastBar(interval, bpb) {
  return Math.max(interval.note.bar, Math.ceil(interval.end / bpb));
}

function rejectFixedClipInsertSeam(song, at, bpb) {
  const seam = (at - 1) * bpb;
  for (const interval of fixedClipIntervals(song, bpb)) {
    if (interval.start >= seam - CLIP_TIME_EPSILON || interval.end <= seam + CLIP_TIME_EPSILON) continue;
    throw new Error(
      `"${interval.track.name}"의 Recorded Clip이 ${interval.note.bar}마디에서 시작해 ${clipLastBar(interval, bpb)}마디까지 이어져 ${at}마디 삽입 지점을 가릅니다`
      + " — 원본 길이가 고정된 clip 중간에는 빈 시간을 끼울 수 없습니다. clip 전체를 move_note로 옮기거나 delete_note로 삭제한 뒤 다시 배치하세요"
    );
  }
}

function rejectPartialFixedClipDelete(song, from, to, rangeStart, rangeEnd, bpb) {
  for (const interval of fixedClipIntervals(song, bpb)) {
    const overlaps = interval.start < rangeEnd - CLIP_TIME_EPSILON &&
      interval.end > rangeStart + CLIP_TIME_EPSILON;
    const fullyCovered = interval.start >= rangeStart - CLIP_TIME_EPSILON &&
      interval.end <= rangeEnd + CLIP_TIME_EPSILON;
    if (!overlaps || fullyCovered) continue;
    throw new Error(
      `${from}~${to}마디 삭제 구간이 "${interval.track.name}" Recorded Clip(${interval.note.bar}~${clipLastBar(interval, bpb)}마디)의 일부만 가릅니다`
      + " — Recorded Clip은 원본 길이가 고정되어 trim·offset 없이 중간만 잘라낼 수 없습니다. clip 전체 길이를 포함해 삭제하거나 delete_note로 전체 clip을 지운 뒤 다시 배치하세요"
    );
  }
}

// at마디 앞에 count마디만큼의 빈 시간을 끼워 넣은 곡을 만든다(검증 전).
// 노트·구간 게인·템포 변화·피드백을 함께 밀고, 삽입 지점을 걸친 긴 노트는 그만큼 늘린다 —
// 게인·피드백 처리와 대칭이라 마디 잘라내기와 왕복했을 때 원래대로 돌아온다.
function shiftBars(song, at, count, bpb) {
  rejectFixedClipInsertSeam(song, at, bpb);
  const shift = b => b >= at ? b + count : b;
  const ins = (at - 1) * bpb;
  let moved = 0, stretched = 0;
  const next = {
    ...song,
    tempoMap: (song.tempoMap ?? []).map(tp => ({ ...tp, bar: shift(tp.bar) })),
    sections: (song.sections ?? []).map(s => ({ ...s, bar: Math.min(999, shift(s.bar)) })),
    feedback: (song.feedback ?? []).map(f => ({ ...f, from_bar: Math.min(999, shift(f.from_bar)), to_bar: Math.min(999, shift(f.to_bar)) })),
    tracks: song.tracks.map(t => {
      const tr = { ...t, notes: t.notes.map(n => {
        if (n.bar >= at) { moved++; return { ...n, bar: n.bar + count }; }
        const s = (n.bar - 1) * bpb + n.beat;
        if (s + n.dur > ins + 1e-9) { stretched++; return { ...n, dur: Math.min(64, r3(n.dur + count * bpb)) }; }
        return n;
      }) };
      if (t.gains) tr.gains = t.gains.map(g => ({ ...g, from: shift(g.from), to: shift(g.to) }));
      return tr;
    })
  };
  return { song: next, moved, stretched };
}

// 노트 하나를 정확히 집는다 — bar+pitch(+beat+dur)로 찾고, 모호하면 후보를 알려준다
// dur까지 받는 이유: 같은 자리에 같은 음이 겹쳐 있으면(중복 입력 등) 길이로만 구분할 수 있다
function pickNote(t, { bar, beat, pitch, dur }) {
  const b = Number(bar);
  if (!Number.isInteger(b)) throw new Error("bar(마디 번호)가 필요합니다");
  if (pitch === undefined || pitch === null || pitch === "") throw new Error("pitch(음이름 또는 드럼 피스)가 필요합니다");
  const matches = t.notes.filter(n => n.bar === b && String(n.pitch) === String(pitch)
    && (beat === undefined || Math.abs(n.beat - Number(beat)) < 1e-6)
    && (dur === undefined || Math.abs(n.dur - Number(dur)) < 1e-6));
  if (!matches.length)
    throw new Error(`"${t.name}" ${b}마디에서 ${pitch} 노트를 찾지 못했습니다${beat !== undefined ? ` (beat ${beat})` : ""}${dur !== undefined ? ` (dur ${dur})` : ""}`);
  if (matches.length > 1) {
    // 완전히 동일한 노트끼리는 구분이 불가능하고 어느 쪽을 집어도 결과가 같다 —
    // 첫 번째를 집는다 (붙여넣기 등으로 생긴 완전 중복을 하나씩 지울 수 있어야 한다)
    const same = matches.every(m => Math.abs(m.beat - matches[0].beat) < 1e-6 && Math.abs(m.dur - matches[0].dur) < 1e-6);
    if (!same)
      throw new Error(`"${t.name}" ${b}마디에 ${pitch} 노트가 ${matches.length}개 있습니다 — beat·dur로 특정하세요 (후보: ${matches.map(n => `beat ${n.beat}/dur ${n.dur}`).join(", ")})`);
  }
  return matches[0];
}

const MAX_RENDER_SEC = 600;
function clampRange(song, from_bar, to_bar) {
  const total = totalBars(song);
  const from = from_bar ?? 1;
  const to = to_bar ?? total;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1)
    throw new Error(`구간이 이상합니다: from_bar=${from_bar}, to_bar=${to_bar}`);
  // from이 곡 범위 밖이면 조용히 접지 말고 거절한다 — 안 그러면 무음 파일이 나가고 LLM이 엉뚱한 원인을 찾는다.
  // to<from 검사보다 먼저 둔다: to_bar를 생략하면 to=곡 끝이라 "구간이 이상합니다"로 잘못 안내된다.
  if (from > total) throw new Error(`곡은 ${total}마디까지입니다 — from_bar=${from}는 곡 범위 밖입니다`);
  if (to < from) throw new Error(`구간이 이상합니다: from_bar=${from_bar}, to_bar=${to_bar}`);
  const clamped = [from, Math.min(to, total)];
  checkRenderLength(song, clamped[0], clamped[1]);
  return clamped;
}
function rangeSeconds(song, from, to) {
  const bpb = beatsPerBar(song), segs = tempoSegments(song);
  return beatToSec(segs, to * bpb) - beatToSec(segs, (from - 1) * bpb);
}
function checkRenderLength(song, from, to) {
  const sec = rangeSeconds(song, from, to);
  if (sec > MAX_RENDER_SEC)
    throw new Error(`구간이 너무 깁니다(${Math.round(sec)}초) — 렌더는 한 번에 ${MAX_RENDER_SEC}초(10분)까지입니다. from_bar/to_bar로 구간을 나누세요`);
}

const fmtBeats = n => (Math.round(n * 100) / 100).toString();
const r3 = n => Math.round(n * 1000) / 1000;
// A/B 비교용 두 칸 — 라이브러리 안에 예약된 이름으로 둔다
const abSlot = v => {
  const s = String(v ?? "").trim().toUpperCase();
  if (s !== "A" && s !== "B") throw new Error(`slot은 "A" 또는 "B"여야 합니다 (받은 값: ${JSON.stringify(v)})`);
  return s;
};
const abName = s => `${s}안 (비교용)`;
// 절대 박 위치를 마디+박으로. 반올림 뒤 박이 마디 길이에 딱 걸리면 다음 마디 0박으로 넘긴다 —
// r3(3.9999999)이 4가 되어 "beat는 4 미만" 검증에 걸리던 실제 버그가 여기서 났다
function barBeatOf(abs, bpb) {
  let bar = Math.floor(abs / bpb) + 1;
  let beat = r3(abs - (bar - 1) * bpb);
  if (beat >= bpb) { bar += 1; beat = 0; }
  return { bar, beat };
}
const gridName = g => ({ 1: "4분음표", 0.5: "8분음표", 0.25: "16분음표", 0.125: "32분음표", 2: "2분음표", 4: "온음표" }[g] ?? `${g}박`);
// 연주 느낌 연산들의 공통 대상 고르기 — 구간을 안 주면 트랙 전체
const rangeNotes = (t, from_bar, to_bar) =>
  (from_bar === undefined && to_bar === undefined)
    ? t.notes.slice()
    : t.notes.filter(n => n.bar >= (from_bar ?? 1) && n.bar <= (to_bar ?? 999));
const fmtDb = v => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}dB` : "-∞");

// 렌더 결과를 한 줄 수치로 — 귀가 없는 쪽(LLM)이 판단할 재료
function levelLine(level) {
  if (!level) return "";
  const { peak, peakDb, rmsDb, clipped, clipPct, limiter, lufs: lu } = level;
  // 리미터가 붙은 뒤로 클리핑은 사실상 0이다 — 경고문도 그에 맞게 바꾼다
  const warn = clipped > 0
    ? `  ⚠ 왜곡 ${clipped.toLocaleString()}샘플(${clipPct.toFixed(2)}%) — 리미터로도 못 막을 만큼 큽니다. 겹치는 노트의 vel이나 트랙 음량을 낮추세요`
    // 리미터가 세게·자주 눌린다는 건 소리가 넘친다는 뜻이다. 예전 "헤드룸" 경고가 하던 역할을 이어받는다
    : limiter && (limiter.maxGrDb > 3 || limiter.pct > 20)
      ? `  ⚠ 리미터가 많이 눌리고 있습니다 — 겹치는 노트의 vel이나 트랙 음량을 낮추면 더 시원하게 들립니다`
    : peak < 0.08 ? "  ⚠ 너무 조용합니다 — 트랙 음량이나 vel을 올리세요"
    : "";
  const lim = limiter && limiter.samples
    ? ` · 리미터 ${limiter.pct.toFixed(1)}% 구간에서 최대 ${limiter.maxGrDb.toFixed(1)}dB 눌림`
    : "";
  const loud = Number.isFinite(lu) ? ` · 체감 음량 ${lu.toFixed(1)} LUFS` : "";
  return `레벨: 피크 ${fmtDb(peakDb)} · RMS ${fmtDb(rmsDb)}${loud}${lim}${warn}`;
}

// ---------- 연산들 (MCP·HTTP 공용) ----------
export const ops = {
  new_song({ title, bpm, template, time_sig } = {}) {
    let timeSig;
    if (time_sig !== undefined) {
      if (!Array.isArray(time_sig) || time_sig.length !== 2)
        throw new Error("time_sig는 [박자수, 박자단위] 두 원소 배열입니다 (예: [7,8], [5,4], [13,16])");
      timeSig = time_sig.map(Number); // 실제 범위 검증은 validateSong이 한다
    }
    // HTTP 경로는 zod를 거치지 않으므로 생성 결과도 반드시 검증을 통과시킨다.
    // 검증을 먼저 끝낸 뒤에야 부수효과(자동 보존·재생 중단)를 낸다 — 실패한 호출이 재생을 끊거나 디스크에 쓰면 안 된다.
    const next = validateSong(createSong({ title, bpm, template, timeSig }));
    // 미설치 상태로 곡을 만든 뒤 나중에 재생에서야 무음이 되는 흐름을 허용하지 않는다.
    for (const track of next.tracks) requirePresetAvailable(track.preset);
    if (state.song?.tracks.some(t => t.notes.length)) saveToLibrary(state.song.title, state.song);
    stopPlayback(broadcast);
    state.song = next;
    mutated();
    return `새 곡을 만들었습니다.\n${songSummary(state.song)}` +
      (template ? `\n템플릿 "${TEMPLATES[template].name}" 편성이 준비됐습니다(노트는 비어 있음).` : "") +
      `\n피아노롤 GUI: ${state.guiUrl ?? "(시작 중)"}` +
      `\n다음: add_notes로 트랙에 노트를 넣고 play로 들어보세요. 형식은 list_presets·get_song 참고.`;
  },

  get_song() {
    const song = needSong();
    const p = playInfo();
    return `${songSummary(song)}${p ? `\n▶ 재생 중: ${p.fromBar}~${p.toBar}마디${p.loop ? " 루프" : ""}` : ""}\nGUI: ${state.guiUrl}\n\n${songText(song)}`;
  },

  set_song({ song_json } = {}) {
    if (typeof song_json !== "string" || !song_json.trim()) throw new Error("song_json(곡 전체 JSON 문자열)이 필요합니다");
    let parsed;
    try { parsed = JSON.parse(song_json); } catch (e) { throw new Error(`JSON 파싱 실패: ${e.message}`); }
    const next = validateSong(parsed);
    stopPlayback(broadcast);
    state.song = next;
    mutated();
    return `곡을 통째로 교체했습니다.\n${songSummary(state.song)}`;
  },

  list_presets({ query, family, source, kind, available_only = false, limit } = {}) {
    const resultLimit = limit === undefined ? 30 : Number(limit);
    if (!Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > 100)
      throw new Error(`list_presets limit은 1~100 정수여야 합니다 — 받은 값: ${JSON.stringify(limit)}`);
    const tpls = Object.entries(TEMPLATES).map(([id, t]) => `  ${id} — ${t.name}: ${t.desc}`).join("\n");
    const entries = [
      ...Object.entries(SF_PRESETS).map(([id, spec]) => ({ id, spec, drum: false })),
      ...Object.entries(SF_DRUM_KITS).map(([id, spec]) => ({ id, spec, drum: true }))
    ].map(item => ({
      ...item,
      kind: item.spec.kind === "clip" ? "clip" : item.drum ? "percussion" : "instrument",
      status: samplerAssetStatus(item.spec, { shallow: true })
    }));
    const availableCount = entries.filter(item => item.status.available).length;
    const norm = value => String(value ?? "").trim().toLocaleLowerCase("en");
    const q = norm(query), qTokens = q.split(/\s+/).filter(Boolean);
    const wantedFamily = norm(family), wantedSource = norm(source), wantedKind = norm(kind);
    if (wantedKind && !["instrument", "percussion", "clip"].includes(wantedKind))
      throw new Error(`kind는 instrument, percussion, clip 중 하나여야 합니다 — 받은 값: ${JSON.stringify(kind)}`);
    const hasFilter = Boolean(q || wantedFamily || wantedSource || wantedKind || available_only || limit !== undefined);
    const filtered = entries.filter(({ id, spec, status, kind: entryKind }) => {
      if (available_only && !status.available) return false;
      if (wantedFamily && norm(spec.family) !== wantedFamily) return false;
      if (wantedSource && ![spec.source, spec.sourceDetail].some(value => norm(value) === wantedSource)) return false;
      if (wantedKind && entryKind !== wantedKind) return false;
      const searchable = norm([
        id, spec.name, spec.desc, spec.family, spec.source, spec.sourceDetail,
        spec.articulation, spec.category, spec.familyDetail, spec.sourceEntry,
        spec.recordedNote, spec.recordedDynamic, spec.aliasSearch,
        ...Object.entries(spec.articulations ?? {}).flatMap(([id, definition]) => [id, definition?.label]), entryKind
      ].join(" "));
      if (qTokens.length && !qTokens.every(token => searchable.includes(token))) return false;
      return true;
    });
    if (!hasFilter) {
      const countBy = key => [...entries.reduce((map, item) => {
        const value = item.spec[key] ?? (key === "source" ? "기타/GM" : "기타");
        map.set(value, (map.get(value) ?? 0) + 1);
        return map;
      }, new Map())].sort((a, b) => a[0].localeCompare(b[0]));
      const sources = countBy("source").map(([name, count]) => `  ${name}: ${count}`).join("\n");
      const families = countBy("family").map(([name, count]) => `  ${name}: ${count}`).join("\n");
      const kinds = [...entries.reduce((map, item) => {
        map.set(item.kind, (map.get(item.kind) ?? 0) + 1);
        return map;
      }, new Map())].map(([name, count]) => `  ${name}: ${count}`).join("\n");
      const unavailable = entries.filter(item => !item.status.available).length;
      return `외부 샘플 프리셋 ${entries.length}개 (사용 가능 ${availableCount}, 설치·수정 필요 ${unavailable})\n`
        + `엔진: SpessaSynth · SoundFont / sfizz · SFZ\n\n종류별:\n${kinds}\n\n출처별:\n${sources}\n\n악기군별:\n${families}`
        + `\n\n실제 ID·주법은 list_presets({family:"Violin"}), list_presets({source:"VSCO 2 CE"}), list_presets({query:"tremolo"})처럼 좁혀서 확인하세요.`
        + `\n미설치·손상 음원은 다른 폰트나 팩으로 자동 대체하지 않습니다.`
        + `\n\nnew_song 템플릿 (현재 구현의 빠른 출발점이며 장르 정의가 아님):\n${tpls}`;
    }
    if (!filtered.length)
      return `조건에 맞는 샘플 프리셋이 없습니다. 전체 ${entries.length}개, 사용 가능 ${availableCount}개입니다.`;
    const line = ({ id, spec, drum, kind: entryKind, status }) => {
      const asset = samplerAssetName(spec, status);
      const allPieces = drum ? Object.keys(spec.pieces ?? DRUM_PIECES) : [];
      const visiblePieces = allPieces.slice(0, 24);
      const pieces = drum && entryKind !== "clip"
        ? `\n    pitch: ${visiblePieces.join(", ")}${allPieces.length > visiblePieces.length ? ` … 외 ${allPieces.length - visiblePieces.length}개` : ""}`
        : "";
      const articulationRows = Object.entries(spec.articulations ?? {});
      const articulations = articulationRows.length
        ? `\n    articulation: ${articulationRows.map(([key, value]) => `${key}=${value.label ?? key}${key === spec.defaultArticulation ? " (기본)" : ""}`).join("; ")}`
        : "";
      return `  ${id} — ${spec.name} [${entryKind} · ${samplerEngineLabel(spec)} · ${status.available ? `설치됨: ${asset}` : `${status.reason}: ${asset}`}]: ${spec.desc}${pieces}${articulations}`;
    };
    const shown = filtered.slice(0, resultLimit);
    const more = filtered.length - shown.length;
    return `검색 결과 ${filtered.length}개 중 ${shown.length}개 표시 (전체 ${entries.length}, 사용 가능 ${availableCount})`
      + (more > 0 ? `\n${more}개가 더 있습니다 — query·family·source·kind를 더 좁히거나 limit을 최대 100까지 올리세요.` : "")
      + `\n${shown.map(line).join("\n")}`;
  },

  add_track({ name, preset, volume, pan, articulation, ...rest } = {}) {
    const song = needSong();
    if (!name || !preset) throw new Error("name과 preset이 필요합니다");
    requirePresetAvailable(preset);
    if (song.tracks.some(t => t.name.toLowerCase() === String(name).trim().toLowerCase()))
      throw new Error(`트랙 "${name}"이 이미 있습니다`);
    // 씨앗은 이름과 별개로 굳힌다 — 이후 이름을 바꿔도 소리가 안 변한다.
    // 이름을 지웠다 같은 이름으로 다시 만들면 씨앗이 겹칠 수 있어 접미사로 피한다
    let seed = String(name);
    for (let i = 2; song.tracks.some(t => t.seed === seed); i++) seed = `${name}#${i}`;
    const track = { name, seed, preset, volume: volume ?? 0.8, pan: pan ?? 0, notes: [] };
    if (articulation !== undefined) track.articulation = articulation;
    for (const [key] of TRACK_OVERRIDES) if (rest[key] !== undefined) track[key] = rest[key];
    state.song = validateSong({ ...song, tracks: [...song.tracks, track] });
    mutated();
    return `트랙 "${name}"(${presetLabel(preset)}) 추가. 현재 트랙: ${state.song.tracks.map(t => t.name).join(", ")}`;
  },

  remove_track({ track } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    song.tracks = song.tracks.filter(x => x !== t);
    mutated();
    return `트랙 "${t.name}" 삭제 — undo_edit으로 되돌릴 수 있습니다. 남은 트랙: ${song.tracks.map(t => t.name).join(", ") || "(없음)"}`;
  },

  set_track({ track, preset, volume, pan, new_name, mute, solo, articulation, ...rest } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    // 라이브 상태는 건드리지 않고 사본을 만들어 검증 통과 후에만 교체한다
    const updated = { ...t, notes: t.notes };
    const changes = [];
    // 음색 오버라이드 — null을 주면 프리셋 기본값으로 되돌린다
    for (const [key] of TRACK_OVERRIDES) {
      if (!Object.hasOwn(rest, key)) continue;
      if (rest[key] === null) { delete updated[key]; changes.push(`${key}→프리셋 기본값`); }
      else { updated[key] = rest[key]; changes.push(`${key}→${rest[key]}`); }
    }
    if (preset !== undefined) {
      requirePresetAvailable(preset);
      const wasDrum = isDrumPreset(t.preset), isDrum = isDrumPreset(preset);
      if (wasDrum !== isDrum && t.notes.length)
        throw new Error(`"${t.name}"에 노트가 있어 ${wasDrum ? "드럼→멜로디" : "멜로디→드럼"} 전환이 불가합니다 — clear_notes 후 바꾸세요`);
      updated.preset = preset;
      // 프리셋마다 articulation ID 체계가 다르다. 호출자가 새 값을 함께 주지 않았다면
      // 옛 프리셋의 선택을 새 음원에 억지로 적용하지 않고 새 프리셋 기본값으로 되돌린다.
      if (articulation === undefined) delete updated.articulation;
      changes.push(`프리셋→${presetLabel(preset)}`);
    }
    if (articulation !== undefined) {
      if (articulation === null) {
        delete updated.articulation;
        changes.push("연주법→프리셋 기본값");
      } else {
        const definitions = presetArticulations(updated.preset);
        if (typeof articulation !== "string" || !definitions || !Object.hasOwn(definitions, articulation))
          throw new Error(`articulation ${JSON.stringify(articulation)}을 ${updated.preset}에서 찾을 수 없습니다 — list_presets로 선택 가능한 원래 연주법을 확인하세요`);
        updated.articulation = articulation;
        changes.push(`연주법→${definitions[articulation].label ?? articulation}`);
      }
    }
    if (volume !== undefined) { updated.volume = volume; changes.push(`볼륨→${volume}`); }
    if (mute !== undefined) {
      if (mute === true) { updated.mute = true; changes.push("음소거"); }
      else { delete updated.mute; changes.push("음소거 해제"); }
    }
    if (solo !== undefined) {
      if (solo === true) { updated.solo = true; changes.push("솔로"); }
      else { delete updated.solo; changes.push("솔로 해제"); }
    }
    if (pan !== undefined) { updated.pan = pan; changes.push(`팬→${pan}`); }
    if (new_name !== undefined) {
      const trimmed = String(new_name).trim();
      if (song.tracks.some(x => x !== t && x.name.toLowerCase() === trimmed.toLowerCase()))
        throw new Error(`트랙 이름 "${new_name}"이 이미 있습니다`);
      changes.push(`이름 ${t.name}→${trimmed}`); updated.name = trimmed;
    }
    if (!changes.length) throw new Error("바꿀 항목이 없습니다 (preset/articulation/volume/pan/mute/solo/new_name 중 하나 이상)");
    state.song = validateSong({ ...song, tracks: song.tracks.map(x => x === t ? updated : x) });
    mutated();
    return `트랙 "${updated.name}" 변경: ${changes.join(", ")}`;
  },

  set_tempo({ bpm, from_bar, ramp } = {}) {
    const song = needSong();
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new Error("bpm은 20~300 숫자");
    const bar = from_bar ?? 1;
    if (!Number.isInteger(bar) || bar < 1 || bar > 999) throw new Error("from_bar는 1~999 정수");
    if (ramp !== undefined && typeof ramp !== "boolean")
      throw new Error(`ramp는 true/false여야 합니다 — 받은 값: ${JSON.stringify(ramp)}`);
    if (bar === 1) {
      // 기준 템포 교체 — 1마디 항목이 따로 있으면 함께 정리한다
      const next = validateSong({ ...song, bpm, tempoMap: (song.tempoMap ?? []).filter(t => t.bar !== 1) });
      state.song = next;
      mutated();
      return `기준 템포를 ${bpm}bpm으로 변경했습니다${next.tempoMap.length ? ` (이후 템포 변화 ${next.tempoMap.length}개는 유지)` : ""}`;
    }
    const others = (song.tempoMap ?? []).filter(t => t.bar !== bar);
    if (others.length >= MAX_TEMPO_POINTS) throw new Error(`템포 변화점은 최대 ${MAX_TEMPO_POINTS}개입니다`);
    state.song = validateSong({ ...song, tempoMap: [...others, { bar, bpm, ramp: !!ramp }] });
    mutated();
    if (!ramp) return `${bar}마디부터 템포를 ${bpm}bpm으로 바꿉니다`;
    // 램프는 "직전 변화점부터" 걸린다 — 어디서 시작하는지 헷갈리기 쉬우니 실제 구간을 되돌려준다
    const prev = others.filter(t => t.bar < bar).sort((a, b) => b.bar - a.bar)[0];
    const fromBar = prev?.bar ?? 1;
    const fromBpm = prev?.bpm ?? state.song.bpm;
    return `${fromBar}마디(${fromBpm}bpm)부터 ${bar}마디(${bpm}bpm)까지 ${bpm < fromBpm ? "점점 느려집니다(rit.)" : "점점 빨라집니다(accel.)"}`
      + (fromBar === 1 && bar > 4
        ? `\n주의: 곡 처음부터 ${bar - 1}마디에 걸쳐 변합니다. 마지막에만 늘어지게 하려면 시작 마디에 앵커를 먼저 두세요 — set_tempo({bpm:${fromBpm}, from_bar:${Math.max(2, bar - 3)}})`
        : "");
  },

  // 섹션 이름표 — 곡의 어디인지 부르는 이름. 소리에는 영향이 없지만,
  // 이게 있어야 "후렴을 더 크게" 같은 말이 사람과 AI 사이에서 통한다
  set_section({ bar, label } = {}) {
    const song = needSong();
    if (!Number.isInteger(bar) || bar < 1 || bar > 999)
      throw new Error(`bar는 1~999 정수여야 합니다 — 받은 값: ${JSON.stringify(bar)}`);
    const text = typeof label === "string" ? label.trim().slice(0, 24) : "";
    if (!text) throw new Error(`label이 필요합니다 (예: "1절", "후렴", "간주") — 지우려면 remove_section을 쓰세요`);
    const others = (song.sections ?? []).filter(s => s.bar !== bar);
    if (others.length >= MAX_SECTIONS) throw new Error(`섹션 이름표는 최대 ${MAX_SECTIONS}개입니다`);
    const had = (song.sections ?? []).find(s => s.bar === bar);
    state.song = validateSong({ ...song, sections: [...others, { bar, label: text }] });
    mutated();
    return had
      ? `${bar}마디 이름표를 "${had.label}" → "${text}"로 바꿨습니다`
      : `${bar}마디에 "${text}" 이름표를 붙였습니다`;
  },

  remove_section({ bar } = {}) {
    const song = needSong();
    const all = song.sections ?? [];
    if (!all.length) throw new Error("지울 섹션 이름표가 없습니다");
    if (bar === undefined) {
      state.song = validateSong({ ...song, sections: [] });
      mutated();
      return `섹션 이름표 ${all.length}개를 모두 지웠습니다`;
    }
    if (!Number.isInteger(bar) || bar < 1 || bar > 999)
      throw new Error(`bar는 1~999 정수여야 합니다 — 받은 값: ${JSON.stringify(bar)}`);
    const kept = all.filter(s => s.bar !== bar);
    if (kept.length === all.length)
      throw new Error(`${bar}마디에 이름표가 없습니다 — 현재: ${all.map(s => `${s.bar}마디 "${s.label}"`).join(", ")}`);
    state.song = validateSong({ ...song, sections: kept });
    mutated();
    return `${bar}마디 이름표를 지웠습니다 (남은 ${kept.length}개)`;
  },

  clear_tempo({ from_bar } = {}) {
    const song = needSong();
    if (from_bar !== undefined && (!Number.isInteger(from_bar) || from_bar < 1 || from_bar > 999))
      throw new Error(`from_bar는 1~999 정수여야 합니다 — 받은 값: ${JSON.stringify(from_bar)}`);
    const before = (song.tempoMap ?? []).length;
    if (!before) return "삭제할 템포 변화가 없습니다 (기준 템포는 set_tempo로 바꾸세요)";
    const kept = from_bar === undefined ? [] : song.tempoMap.filter(t => t.bar !== from_bar);
    if (from_bar !== undefined && kept.length === before)
      throw new Error(`${from_bar}마디에 템포 변화가 없습니다 — 현재: ${song.tempoMap.map(t => `${t.bar}마디`).join(", ")}`);
    state.song = validateSong({ ...song, tempoMap: kept });
    mutated();
    return `템포 변화 ${before - kept.length}개 삭제 (남은 ${kept.length}개). 기준 템포 ${song.bpm}bpm은 유지됩니다`;
  },

  add_notes({ track, notes } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    if (!Array.isArray(notes) || !notes.length) throw new Error("notes는 비어 있지 않은 배열이어야 합니다 — [{bar,beat,pitch,dur,vel?}, ...]");
    if (t.notes.length + notes.length > 10000) throw new Error("트랙당 노트는 최대 10000개");
    const bpb = beatsPerBar(song);
    const added = notes.map(n => validateNote(n, t, song, bpb));
    // 사본으로 검증 통과 후 교체 — 실패해도 라이브 상태가 오염되지 않는다
    state.song = validateSong({
      ...song,
      tracks: song.tracks.map(x => x === t ? { ...t, notes: [...t.notes, ...added] } : x)
    });
    mutated();
    const barMin = Math.min(...added.map(n => n.bar)), barMax = Math.max(...added.map(n => n.bar));
    return `"${t.name}"에 노트 ${added.length}개 추가 (${barMin}~${barMax}마디, 트랙 합계 ${state.song.tracks.find(x => x.name === t.name).notes.length}개)\nplay({from_bar:${barMin}, to_bar:${barMax}})로 방금 넣은 부분만 들어볼 수 있습니다.`;
  },

  clear_notes({ track, from_bar, to_bar } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    const before = t.notes.length;
    const ranged = from_bar !== undefined || to_bar !== undefined;
    const from = from_bar ?? 1, to = to_bar ?? 999;
    const kept = ranged ? t.notes.filter(n => n.bar < from || n.bar > to) : [];
    t.notes = kept;
    mutated();
    return `"${t.name}"에서 노트 ${before - t.notes.length}개 삭제 (남은 ${t.notes.length}개)`
      + (kept.length < before ? " — undo_edit으로 되돌릴 수 있습니다" : "");
  },

  // 노트 하나만 삭제 — GUI에서 노트를 클릭해 지우거나, LLM이 특정 음만 뺄 때
  delete_note({ track, bar, beat, pitch, dur } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    const n = pickNote(t, { bar, beat, pitch, dur });
    t.notes = t.notes.filter(x => x !== n);
    mutated();
    return `"${t.name}"의 ${n.bar}마디 ${n.beat}박 ${n.pitch}(${n.dur}박) 노트를 지웠습니다 — undo_edit으로 되돌릴 수 있습니다 (남은 노트 ${t.notes.length}개)`;
  },

  // 노트 하나의 타이밍 이동 — 엇박 교정("반 박 늦은 걸 제자리로") 용도
  move_note({ track, bar, beat, pitch, dur, to_bar, to_beat } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    const n = pickNote(t, { bar, beat, pitch, dur });
    const nb = to_bar === undefined ? n.bar : Number(to_bar);
    const nbeat = to_beat === undefined ? n.beat : Number(to_beat);
    if (nb === n.bar && Math.abs(nbeat - n.beat) < 1e-6) return "제자리입니다 — 바뀐 것이 없습니다";
    const moved = validateNote({ ...n, bar: nb, beat: nbeat }, t, song); // 범위·박자 검증 재사용
    t.notes = t.notes.map(x => x === n ? moved : x);
    mutated();
    return `"${t.name}" ${n.pitch}: ${n.bar}마디 ${n.beat}박 → ${nb}마디 ${nbeat}박으로 이동 (undo_edit으로 되돌리기)`;
  },

  // 노트 하나의 길이 변경 — GUI에서 노트 오른쪽 가장자리를 드래그할 때
  resize_note({ track, bar, beat, pitch, dur, from_dur } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    if (presetKind(t.preset) === "clip")
      throw new Error(`"${t.name}"은 Recorded Clip(녹음 클립) 트랙입니다 — 원본 길이가 고정된 one-shot이라 resize_note로 자를 수 없습니다. 시작 위치를 move_note로 옮기세요`);
    const n = pickNote(t, { bar, beat, pitch, dur: from_dur });
    const d = Number(dur);
    if (!Number.isFinite(d) || d <= 0 || d > 64) throw new Error("dur는 0보다 크고 64 이하인 박 단위 길이여야 합니다");
    if (Math.abs(d - n.dur) < 1e-9) return "길이가 같습니다 — 바뀐 것이 없습니다";
    const updated = validateNote({ ...n, dur: d }, t, song);
    t.notes = t.notes.map(x => x === n ? updated : x);
    mutated();
    return `"${t.name}" ${n.pitch}(${n.bar}마디): 길이 ${n.dur}박 → ${d}박 (undo_edit으로 되돌리기)`;
  },

  // 노트 하나를 둘로 자른다(가위) — GUI ✂ 자르기 모드, 긴 노트를 나눠 뒷부분만 고칠 때
  split_note({ track, bar, beat, pitch, dur, at_bar, at_beat } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    if (presetKind(t.preset) === "clip")
      throw new Error(`"${t.name}"은 Recorded Clip(녹음 클립) 트랙입니다 — split_note는 같은 원본을 두 번 재생하므로 지원하지 않습니다. 실제 trim·offset 편집 기능이 추가될 때까지 원본 한 번 재생으로 유지하세요`);
    const n = pickNote(t, { bar, beat, pitch, dur });
    const bpb = beatsPerBar(song);
    const ab = Number(at_bar), abeat = Number(at_beat ?? 0);
    if (!Number.isInteger(ab) || ab < 1 || !Number.isFinite(abeat) || abeat < 0)
      throw new Error("at_bar/at_beat(자를 위치)가 필요합니다 — 노트 시작과 끝 사이의 마디·박");
    const start = (n.bar - 1) * bpb + n.beat, at = (ab - 1) * bpb + abeat;
    if (at <= start + 1e-6 || at >= start + n.dur - 1e-6)
      throw new Error(`자를 위치가 노트 안쪽이 아닙니다 — 이 노트는 ${n.bar}마디 ${n.beat}박부터 ${fmtBeats(n.dur)}박 길이입니다`);
    const d1 = r3(at - start), d2 = r3(n.dur - d1);
    const head = validateNote({ ...n, dur: d1 }, t, song, bpb);
    const tail = validateNote({ ...n, bar: ab, beat: r3(abeat), dur: d2 }, t, song, bpb);
    t.notes = t.notes.flatMap(x => x === n ? [head, tail] : [x]);
    mutated();
    return `"${t.name}" ${n.pitch}(${n.bar}마디 ${n.beat}박, ${fmtBeats(n.dur)}박)를 ${ab}마디 ${fmtBeats(abeat)}박에서 잘랐습니다 — ${fmtBeats(d1)}박 + ${fmtBeats(d2)}박 (undo_edit으로 되돌리기)`;
  },

  // 노트 세기(벨로시티) 조절 — 절대값·증감·배율, 그리고 구간에 걸친 점층(크레셴도/디미누엔도)
  // 세기만 바꾸는 전용 연산이 없어 지웠다 다시 넣어야 했던 것을 대체한다
  // 음이 울리는 동안 미끄러지는 정도(반음). 0을 주면 곧게 편다.
  set_bend({ track, notes, from_bar, to_bar, bend } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    if (isDrumPreset(t.preset)) throw new Error(`"${t.name}"은 드럼 킷이라 음을 휠 수 없습니다`);
    const b = Number(bend);
    if (!Number.isFinite(b) || b < -12 || b > 12)
      throw new Error(`bend는 -12~12 반음이어야 합니다 (양수면 올라가고 음수면 떨어진다, 0이면 곧게 편다) — 받은 값: ${JSON.stringify(bend)}`);
    let targets;
    if (Array.isArray(notes) && notes.length) {
      if (notes.length > 500) throw new Error("한 번에 500개까지만 바꿀 수 있습니다");
      targets = notes.map(id => pickNote(t, id));
    } else if (from_bar !== undefined || to_bar !== undefined) {
      targets = t.notes.filter(n => n.bar >= (from_bar ?? 1) && n.bar <= (to_bar ?? 999));
    } else targets = t.notes;
    if (!targets.length) throw new Error("바꿀 노트가 없습니다");
    const set = new Set(targets);
    const rounded = Math.round(b * 100) / 100;
    t.notes = t.notes.map(n => {
      if (!set.has(n)) return n;
      const next = { ...n };
      if (rounded === 0) delete next.bend; else next.bend = rounded;
      return next;
    });
    mutated();
    return rounded === 0
      ? `"${t.name}" 노트 ${targets.length}개를 곧게 폈습니다`
      : `"${t.name}" 노트 ${targets.length}개가 울리는 동안 ${Math.abs(rounded)}반음 ${rounded > 0 ? "올라갑니다" : "떨어집니다"}`;
  },

  set_velocity({ track, notes, from_bar, to_bar, vel, to_vel, by, scale } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    let targets;
    if (Array.isArray(notes) && notes.length) {
      if (notes.length > 500) throw new Error("한 번에 500개까지만 바꿀 수 있습니다");
      targets = notes.map(id => pickNote(t, id));
    } else if (from_bar !== undefined || to_bar !== undefined) {
      const from = from_bar ?? 1, to = to_bar ?? 999;
      targets = t.notes.filter(n => n.bar >= from && n.bar <= to);
    } else targets = t.notes;
    if (!targets.length) throw new Error("바꿀 노트가 없습니다");

    const given = [vel, by, scale].filter(v => v !== undefined).length;
    if (given !== 1) throw new Error("vel(절대값)·by(증감)·scale(배율) 중 정확히 하나를 주세요");
    const chk = (v, lo, hi, label) => {
      const x = Number(v);
      if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`${label}는 ${lo}~${hi} 사이여야 합니다`);
      return x;
    };
    const clamp = v => Math.max(1, Math.min(127, Math.round(v)));

    let calc;
    if (vel !== undefined) {
      const v0 = chk(vel, 1, 127, "vel");
      if (to_vel === undefined) calc = () => v0;
      else {
        // 점층 — 선택 구간의 시작~끝 사이를 시간에 비례해 v0 → v1로 잇는다
        const v1 = chk(to_vel, 1, 127, "to_vel");
        const bpb = beatsPerBar(song);
        const pos = n => (n.bar - 1) * bpb + n.beat;
        const lo = Math.min(...targets.map(pos)), hi = Math.max(...targets.map(pos));
        calc = n => hi - lo < 1e-9 ? v1 : v0 + (v1 - v0) * (pos(n) - lo) / (hi - lo);
      }
    } else if (by !== undefined) {
      const d = chk(by, -126, 126, "by");
      calc = n => n.vel + d;
    } else {
      const k = chk(scale, 0.1, 5, "scale");
      calc = n => n.vel * k;
    }

    const set = new Set(targets);
    let changed = 0, lo = 128, hi = 0;
    t.notes = t.notes.map(n => {
      if (!set.has(n)) return n;
      const v = clamp(calc(n));
      lo = Math.min(lo, v); hi = Math.max(hi, v);
      if (v === n.vel) return n;
      changed++;
      return { ...n, vel: v };
    });
    mutated();
    const how = vel !== undefined ? (to_vel !== undefined ? `${vel}→${to_vel} 점층` : `${vel}로 설정`)
      : by !== undefined ? `${by > 0 ? "+" : ""}${by}` : `×${scale}`;
    return `"${t.name}" 노트 ${targets.length}개의 세기를 ${how} — ${changed}개 변경, 결과 범위 ${lo}~${hi}`
      + " (undo_edit으로 되돌리기)";
  },

  // 여러 노트를 한 번에 이동 — 선택 목록(notes) 또는 마디 구간(from_bar~to_bar)으로 대상 지정, 되돌리기 한 번에 복구
  move_notes({ track, by_beats, notes, from_bar, to_bar } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    const by = Number(by_beats);
    if (!Number.isFinite(by) || by === 0 || Math.abs(by) > 64)
      throw new Error("by_beats는 0이 아닌 -64~64 박(4분음표 단위)이어야 합니다 — 음수면 앞으로, 양수면 뒤로");
    let targets;
    if (Array.isArray(notes) && notes.length) {
      if (notes.length > 500) throw new Error("한 번에 500개까지만 옮길 수 있습니다");
      targets = notes.map(id => pickNote(t, id));
    } else if (from_bar !== undefined || to_bar !== undefined) {
      const from = from_bar ?? 1, to = to_bar ?? 999;
      targets = t.notes.filter(n => n.bar >= from && n.bar <= to);
    } else throw new Error("대상이 필요합니다 — notes 목록([{bar,beat,pitch}...]) 또는 from_bar/to_bar 구간");
    if (!targets.length) throw new Error("옮길 노트가 없습니다");
    const bpb = beatsPerBar(song);
    const movedPairs = targets.map(n => {
      const abs = (n.bar - 1) * bpb + n.beat + by;
      if (abs < 0) throw new Error(`${n.bar}마디 ${n.pitch}가 곡 시작 앞으로 나갑니다 — by_beats를 줄이세요`);
      const { bar: nb, beat: nbeat } = barBeatOf(abs, bpb);
      return [n, validateNote({ ...n, bar: nb, beat: nbeat }, t, song, bpb)];
    });
    const map = new Map(movedPairs);
    t.notes = t.notes.map(n => map.get(n) ?? n);
    mutated();
    return `"${t.name}" 노트 ${targets.length}개를 ${by > 0 ? "뒤로" : "앞으로"} ${Math.abs(by)}박 옮겼습니다 (undo_edit으로 되돌리기)`;
  },

  // ---------- 연주 느낌: 무작위 편차 · 스윙 · 박자 정리 ----------
  // 셋 다 "노트의 위치·세기를 옮기는 편집"이다. 재생 때 흔드는 게 아니라 데이터를 바꾸므로
  // 화면에서 결과가 그대로 보이고, 마음에 안 들면 undo_edit 한 번으로 돌아간다.
  humanize({ track, from_bar, to_bar, timing = 0.02, velocity = 8, seed } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    if (!Number.isFinite(timing) || timing < 0 || timing > 0.25)
      throw new Error(`timing은 0~0.25박이어야 합니다 (0.02면 아주 살짝) — 받은 값: ${JSON.stringify(timing)}`);
    if (!Number.isInteger(velocity) || velocity < 0 || velocity > 40)
      throw new Error(`velocity는 0~40이어야 합니다 (세기를 이만큼까지 위아래로 흔든다) — 받은 값: ${JSON.stringify(velocity)}`);
    if (!timing && !velocity) throw new Error("timing과 velocity 중 하나는 0보다 커야 합니다");
    const targets = rangeNotes(t, from_bar, to_bar);
    if (!targets.length) throw new Error("흔들 노트가 없습니다");
    const bpb = beatsPerBar(song);
    // 같은 입력 상태·범위·seed에서는 결과가 재현된다. 이미 바뀐 노트에 다시 적용하면 누적된다.
    const base = hashSeed("humanize", t.seed ?? t.name, seed ?? 0);
    const set = new Set(targets);
    let moved = 0;
    t.notes = t.notes.map(n => {
      if (!set.has(n)) return n;
      const rnd = mulberry32(hashSeed(base, n.bar, n.beat, n.pitch, n.dur));
      const dt = timing ? (rnd() * 2 - 1) * timing : 0;
      const dv = velocity ? Math.round((rnd() * 2 - 1) * velocity) : 0;
      const abs = Math.max(0, (n.bar - 1) * bpb + n.beat + dt);
      const next = { ...n, ...barBeatOf(abs, bpb) };
      if (dv) next.vel = Math.max(1, Math.min(127, (n.vel ?? 96) + dv));
      moved++;
      return validateNote(next, t, song, bpb);
    });
    mutated();
    return `"${t.name}" 노트 ${moved}개에 무작위 편차를 기록했습니다`
      + ` (타이밍 ±${timing}박, 세기 ±${velocity}) — 사람다움이나 groove를 보장하지 않으며, 한 번 더 부르면 편차가 겹쳐 쌓입니다`;
  },

  swing({ track, amount = 0.5, unit = 0.5, from_bar, to_bar } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1)
      throw new Error(`amount는 0~1이어야 합니다 (0=정박, 1=셋잇단 느낌) — 받은 값: ${JSON.stringify(amount)}`);
    if (![0.25, 0.5].includes(unit))
      throw new Error(`unit은 0.5(8분음표) 또는 0.25(16분음표)여야 합니다 — 받은 값: ${JSON.stringify(unit)}`);
    const targets = rangeNotes(t, from_bar, to_bar);
    if (!targets.length) throw new Error("스윙을 걸 노트가 없습니다");
    const bpb = beatsPerBar(song);
    const pair = unit * 2;
    const ratio = 0.5 + amount * (2 / 3 - 0.5); // 0.5(정박) ~ 0.667(셋잇단)
    const set = new Set(targets);
    let swung = 0;
    t.notes = t.notes.map(n => {
      if (!set.has(n)) return n;
      const abs = (n.bar - 1) * bpb + n.beat;
      const p0 = Math.floor(abs / pair + 1e-9) * pair;
      const frac = (abs - p0) / pair;
      // 뒷박만 민다. 이미 밀린 음도 같은 구간(0.4~0.75)에 있어 다시 부르면 새 비율로 옮겨간다 —
      // 그래서 "살짝 → 강하게"로 바꿔도 스윙이 겹쳐 쌓이지 않는다
      if (frac < 0.4 || frac > 0.75) return n;
      const nextAbs = p0 + pair * ratio;
      if (Math.abs(nextAbs - abs) < 1e-6) return n;
      swung++;
      return validateNote({ ...n, ...barBeatOf(nextAbs, bpb) }, t, song, bpb);
    });
    if (!swung) { return `"${t.name}"에 밀 뒷박이 없습니다 — ${unit === 0.5 ? "8분" : "16분"} 뒷박에 놓인 음이 있어야 스윙이 걸립니다`; }
    mutated();
    return `"${t.name}" 뒷박 ${swung}개를 밀었습니다 (${unit === 0.5 ? "8분" : "16분"} 스윙 ${Math.round(amount * 100)}%)`;
  },

  quantize({ track, grid = 0.25, strength = 1, from_bar, to_bar } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    if (!Number.isFinite(grid) || grid <= 0 || grid > 4)
      throw new Error(`grid는 0보다 크고 4 이하인 박 값이어야 합니다 (1=4분, 0.5=8분, 0.25=16분) — 받은 값: ${JSON.stringify(grid)}`);
    if (!Number.isFinite(strength) || strength <= 0 || strength > 1)
      throw new Error(`strength는 0보다 크고 1 이하여야 합니다 (1=격자에 딱 맞춤, 0.5=절반만 당김) — 받은 값: ${JSON.stringify(strength)}`);
    const targets = rangeNotes(t, from_bar, to_bar);
    if (!targets.length) throw new Error("정리할 노트가 없습니다");
    const bpb = beatsPerBar(song);
    const set = new Set(targets);
    let fixed = 0, worst = 0;
    t.notes = t.notes.map(n => {
      if (!set.has(n)) return n;
      const abs = (n.bar - 1) * bpb + n.beat;
      const snapped = Math.round(abs / grid) * grid;
      const nextAbs = Math.max(0, abs + (snapped - abs) * strength);
      if (Math.abs(nextAbs - abs) < 1e-6) return n;
      worst = Math.max(worst, Math.abs(snapped - abs));
      fixed++;
      return validateNote({ ...n, ...barBeatOf(nextAbs, bpb) }, t, song, bpb);
    });
    if (!fixed) return `"${t.name}"은 이미 ${gridName(grid)} 격자에 맞아 있습니다`;
    mutated();
    return `"${t.name}" 노트 ${fixed}개를 ${gridName(grid)} 격자로 정리했습니다`
      + `${strength < 1 ? ` (${Math.round(strength * 100)}%만 당김)` : ""} — 가장 많이 어긋나 있던 음은 ${r3(worst)}박`;
  },

  // 여러 노트를 한 번에 삭제 — GUI 블록 선택용 (구간 전체는 clear_notes)
  delete_notes({ track, notes } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    if (!Array.isArray(notes) || !notes.length) throw new Error("notes(삭제할 노트 목록 [{bar,beat,pitch}...])가 필요합니다");
    if (notes.length > 500) throw new Error("한 번에 500개까지만 지울 수 있습니다");
    const targets = new Set(notes.map(id => pickNote(t, id)));
    t.notes = t.notes.filter(n => !targets.has(n));
    mutated();
    return `"${t.name}"에서 노트 ${targets.size}개를 지웠습니다 — undo_edit으로 되돌릴 수 있습니다 (남은 ${t.notes.length}개)`;
  },

  // 구간 게인: 특정 트랙의 특정 마디 구간만 dB 단위로 음량 조절 — "여기서만 심벌 -6dB"
  set_region_gain({ track, from_bar, to_bar, db, to_db } = {}) {
    const song = needSong();
    const t = findTrack(song, track);
    const from = Number(from_bar), to = Number(to_bar ?? from_bar), d = Number(db);
    if (!Number.isInteger(from) || from < 1 || from > 999) throw new Error("from_bar는 1~999 정수여야 합니다");
    if (!Number.isInteger(to) || to < from || to > 999) throw new Error("to_bar는 from_bar 이상 999 이하 정수여야 합니다");
    if (!Number.isFinite(d) || d < -60 || d > 12) throw new Error("db는 -60~+12 사이 숫자입니다 (예: -6이면 절반 크기, 0이면 구간 게인 제거)");
    // to_db를 주면 구간에 걸쳐 서서히 변하는 램프 — 페이드인·페이드아웃
    let ramp = null;
    if (to_db !== undefined && to_db !== null) {
      const t2 = Number(to_db);
      if (!Number.isFinite(t2) || t2 < -60 || t2 > 12) throw new Error("to_db는 -60~+12 사이 숫자입니다");
      if (t2 === d) throw new Error(`db와 to_db가 같으면 변하는 게 없습니다 — 서서히 바꾸려면 다른 값을, 일정하게 두려면 to_db를 빼세요`);
      ramp = t2;
    }
    // 같은 구간을 다시 부르면 값이 교체(누를수록 총량 갱신)되고, db=0은 "정확히 그 구간" 항목만 제거한다.
    // 겹치기만 하는 항목은 절대 건드리지 않는다 — GUI ±3dB 누적이 0을 지나는 순간 다른 구간의 믹싱이 날아가는 사고 방지
    const fmtGains = gs => gs.map(g => `${g.from}${g.to !== g.from ? `~${g.to}` : ""}마디 ${g.db > 0 ? "+" : ""}${g.db}dB`
      + (g.to_db !== undefined ? `→${g.to_db > 0 ? "+" : ""}${g.to_db}dB` : "")).join(" · ");
    const exact = (t.gains ?? []).filter(g => g.from === from && g.to === to);
    const kept = (t.gains ?? []).filter(g => !(g.from === from && g.to === to));
    // 램프는 db가 0이어도 "지우기"가 아니다 — 페이드아웃은 0dB에서 시작하는 게 보통이다.
    // (이 조기 반환이 램프보다 앞에 있어서 {db:0, to_db:-40}이 조용히 아무 일도 안 하던 버그)
    if (d === 0 && ramp === null && !exact.length) {
      const overlapping = (t.gains ?? []).filter(g => g.to >= from && g.from <= to);
      return `"${t.name}" ${from}~${to}마디와 정확히 일치하는 게인이 없어 제거할 것이 없습니다`
        + (overlapping.length ? ` — 겹치는 게인: ${fmtGains(overlapping)} (제거하려면 그 구간 그대로 db 0을 부르세요)` : "");
    }
    const nextGains = ramp === null
      ? (d === 0 ? kept : [...kept, { from, to, db: Math.round(d * 10) / 10 }])
      : [...kept, { from, to, db: Math.round(d * 10) / 10, to_db: Math.round(ramp * 10) / 10 }];
    const updated = { ...t, notes: t.notes };
    if (nextGains.length) updated.gains = nextGains; else delete updated.gains;
    const validated = validateSong({ ...song, tracks: song.tracks.map(x => x === t ? updated : x) });
    state.song = validated;
    mutated();
    const list = fmtGains(state.song.tracks.find(x => x.name === t.name).gains ?? []);
    if (ramp !== null)
      return `"${t.name}" ${from}~${to}마디를 ${d > 0 ? "+" : ""}${d}dB에서 ${ramp > 0 ? "+" : ""}${ramp}dB로 ${ramp < d ? "서서히 작아지게" : "서서히 커지게"} 했습니다`
        + ` — 길게 끄는 음 안에서도 소리가 변합니다 (undo_edit으로 되돌리기)\n현재 게인: ${list}`;
    return d === 0
      ? `"${t.name}" ${from}~${to}마디 게인 제거${list ? ` (남은 게인: ${list})` : ""}`
      : `"${t.name}" ${from}~${to}마디 게인 ${d > 0 ? "+" : ""}${d}dB ${exact.length ? "갱신" : "설정"} — 이 구간의 노트만 음량이 바뀝니다 (undo_edit으로 되돌리기)\n현재 게인: ${list}`;
  },

  // 빈 마디 삽입 — at_bar 앞에 count개를 끼워 넣고, 전 트랙의 노트·구간 게인·템포 변화·피드백을 함께 뒤로 민다
  insert_bars({ at_bar, count } = {}) {
    const song = needSong();
    const at = Number(at_bar), c = Number(count ?? 1);
    if (!Number.isInteger(at) || at < 1 || at > 999) throw new Error("at_bar는 1~999 정수여야 합니다 — 이 마디 앞에 빈 마디가 들어갑니다");
    if (!Number.isInteger(c) || c < 1 || c > 64) throw new Error("count는 1~64 정수여야 합니다");
    const maxUsed = Math.max(totalBars(song),
      ...(song.tempoMap ?? []).map(tp => tp.bar),
      ...song.tracks.flatMap(t => (t.gains ?? []).map(g => g.to)));
    if (maxUsed + c > 999) throw new Error(`삽입하면 999마디 한도를 넘습니다 (현재 최대 ${maxUsed}마디 사용 중)`);
    const { song: next, moved, stretched } = shiftBars(song, at, c, beatsPerBar(song));
    const validated = validateSong(next);
    state.song = validated;
    mutated();
    return `${at}마디 앞에 빈 마디 ${c}개를 넣었습니다 — 노트 ${moved}개 뒤로 밀림${stretched ? `, 걸친 노트 ${stretched}개 길이 연장` : ""} (전체 트랙, undo_edit으로 되돌리기)\n곡 길이: ${totalBars(state.song)}마디`;
  },

  // 구간 복제 — from~to 마디를 to_bar 자리에 통째로 베껴 넣는다 (1절을 2절 자리에)
  // mode="insert"면 붙일 자리에 빈 마디를 먼저 밀어 넣고, "overwrite"면 그 자리 노트를 지우고 덮어쓴다
  copy_bars({ from_bar, to_bar, at_bar, tracks, mode, times } = {}) {
    const song = needSong();
    const from = Number(from_bar), to = Number(to_bar ?? from_bar), at = Number(at_bar);
    const rep = Number(times ?? 1);
    const how = mode ?? "insert";
    if (!Number.isInteger(from) || from < 1 || from > 999) throw new Error("from_bar는 1~999 정수여야 합니다");
    if (!Number.isInteger(to) || to < from) throw new Error("to_bar는 from_bar 이상 정수여야 합니다");
    if (!Number.isInteger(at) || at < 1 || at > 999) throw new Error("at_bar는 1~999 정수여야 합니다 — 복사본이 시작될 마디");
    if (how !== "insert" && how !== "overwrite") throw new Error('mode는 "insert"(빈 마디를 밀어 넣고 삽입) 또는 "overwrite"(그 자리를 덮어씀)여야 합니다');
    if (!Number.isInteger(rep) || rep < 1 || rep > 32) throw new Error("times는 1~32 정수여야 합니다");
    if (at > from && at <= to) throw new Error(`붙일 자리(${at}마디)가 복사할 구간(${from}~${to}마디) 안에 있습니다 — 구간 밖으로 지정하세요`);

    const span = to - from + 1;
    const total = span * rep;
    const bpb = beatsPerBar(song);
    // 대상 트랙 — 안 주면 전 트랙
    const names = tracks === undefined || tracks === null ? null
      : (Array.isArray(tracks) ? tracks : [tracks]).map(x => findTrack(song, x).name);
    const targeted = t => names === null || names.includes(t.name);

    const maxUsed = Math.max(totalBars(song), at + total - 1,
      ...(song.tempoMap ?? []).map(tp => tp.bar),
      ...song.tracks.flatMap(t => (t.gains ?? []).map(g => g.to)));
    if (maxUsed + (how === "insert" ? total : 0) > 999)
      throw new Error(`복제하면 999마디 한도를 넘습니다 (현재 최대 ${maxUsed}마디 사용 중)`);

    // 붙일 자리 뒤를 밀어내는 경우, 원본 구간도 함께 밀릴 수 있으므로 복사본은 "미루기 전" 원본에서 뜬다
    const picked = song.tracks.map(t => targeted(t)
      ? t.notes.filter(n => n.bar >= from && n.bar <= to).map(n => ({ ...n }))
      : []);

    let base = song;
    if (how === "insert") base = validateSong(shiftBars(song, at, total, bpb).song);
    // 삽입으로 원본 구간이 뒤로 밀렸다면 복사본은 이미 떠 두었으므로 영향 없다

    let copied = 0, cleared = 0;
    const next = {
      ...base,
      tracks: base.tracks.map((t, i) => {
        if (!targeted(t)) return t;
        let notes = t.notes;
        if (how === "overwrite") {
          const before = notes.length;
          notes = notes.filter(n => n.bar < at || n.bar >= at + total);
          cleared += before - notes.length;
        }
        const added = [];
        for (let k = 0; k < rep; k++)
          for (const n of picked[i]) {
            added.push({ ...n, bar: n.bar - from + at + k * span });
            copied++;
          }
        return { ...t, notes: [...notes, ...added] };
      })
    };
    state.song = validateSong(next);
    mutated();
    return `${from}~${to}마디(${span}마디)를 ${at}마디에 ${rep > 1 ? `${rep}번 ` : ""}복제했습니다`
      + ` — 노트 ${copied}개 복사${cleared ? `, 덮어쓴 자리의 노트 ${cleared}개 삭제` : ""}`
      + `${how === "insert" ? `, 뒤쪽 ${total}마디 밀림` : ""}`
      + ` (${names ? `대상: ${names.join(", ")}` : "전체 트랙"}, undo_edit으로 되돌리기)\n곡 길이: ${totalBars(state.song)}마디`;
  },

  // 마디 잘라내기 — from~to 구간을 전 트랙에서 들어내고 뒤를 당겨 붙인다 (DAW의 delete time)
  delete_bars({ from_bar, to_bar } = {}) {
    const song = needSong();
    const total = totalBars(song);
    const from = Number(from_bar), to = Number(to_bar ?? from_bar);
    if (!Number.isInteger(from) || from < 1) throw new Error("from_bar는 1 이상 정수여야 합니다");
    if (from > total) throw new Error(`곡은 ${total}마디까지입니다 — from_bar=${from}는 곡 범위 밖입니다`);
    if (!Number.isInteger(to) || to < from) throw new Error("to_bar는 from_bar 이상 정수여야 합니다");
    const end = Math.min(to, total);
    const span = end - from + 1;
    const bpb = beatsPerBar(song);
    const rs = (from - 1) * bpb, re = end * bpb;
    rejectPartialFixedClipDelete(song, from, end, rs, re, bpb);
    const mapF = b => b < from ? b : b > end ? b - span : from;      // 구간 안 시작점 → 이음새로
    const mapT = b => b < from ? b : b > end ? b - span : from - 1;  // 구간 안 끝점 → 이음새 앞으로
    let removed = 0, clipped = 0, pulled = 0;
    const tracks = song.tracks.map(t => {
      const notes = [];
      for (const n of t.notes) {
        const s = (n.bar - 1) * bpb + n.beat;
        if (s >= rs && s < re) { removed++; continue; }                 // 구간 안에서 시작 → 삭제
        if (s < rs) {
          const overlap = Math.max(0, Math.min(s + n.dur, re) - rs);    // 구간에 걸친 만큼만 축소 (꼬리는 이음새에 다시 붙는다)
          if (overlap > 0) {
            const nd = r3(n.dur - overlap);
            if (nd > 0) { clipped++; notes.push({ ...n, dur: nd }); }
            else removed++; // 축소 후 길이 0 — 사실상 구간 안 노트라 지운다 (dur 0은 검증 불가)
          }
          else notes.push(n);
        } else { pulled++; notes.push({ ...n, bar: n.bar - span }); }   // 구간 뒤 → 당겨 붙임
      }
      const tr = { ...t, notes };
      if (t.gains) {
        const gains = t.gains.map(g => ({ ...g, from: mapF(g.from), to: mapT(g.to) })).filter(g => g.to >= g.from);
        if (gains.length) tr.gains = gains; else delete tr.gains;
      }
      return tr;
    });
    // 구간 안 템포 변화: 마지막 것이 구간 뒤 템포를 지배하므로 이음새로 옮긴다.
    // 뒤에서 당겨온 항목이 정확히 이음새에 앉으면 그쪽이 우선하되, 그 항목이 램프면 평탄으로 —
    // 램프의 앵커(구간 안 마지막 템포)가 함께 잘려나가, 남겨두면 앞쪽 멀쩡한 마디의 템포가 조용히 바뀐다
    const inside = (song.tempoMap ?? []).filter(tp => tp.bar >= from && tp.bar <= end);
    const tempoMap = (song.tempoMap ?? []).filter(tp => tp.bar < from)
      .concat((song.tempoMap ?? []).filter(tp => tp.bar > end).map(tp => ({ ...tp, bar: tp.bar - span })));
    const collide = tempoMap.find(tp => tp.bar === from);
    if (inside.length) {
      if (collide) { if (collide.ramp) collide.ramp = false; }
      else tempoMap.push({ bar: from, bpm: inside[inside.length - 1].bpm }); // bar 1이면 validateSong이 기준 템포로 흡수
    }
    const feedback = (song.feedback ?? []).map(f => ({ ...f, from_bar: mapF(f.from_bar), to_bar: mapT(f.to_bar) }))
      .filter(f => f.to_bar >= f.from_bar);
    // 섹션 이름표: 잘린 구간 안의 것은 이음새로 모이므로 중복이 생긴다 — 앞의 것만 남긴다
    const seenSec = new Set();
    const sections = (song.sections ?? [])
      .map(s => ({ ...s, bar: mapF(s.bar) }))
      .filter(s => !seenSec.has(s.bar) && seenSec.add(s.bar));
    const validated = validateSong({ ...song, tempoMap, feedback, sections, tracks });
    state.song = validated;
    mutated();
    return `${from}~${end}마디를 잘라냈습니다 — 노트 ${removed}개 삭제${clipped ? `, ${clipped}개 길이 축소` : ""}, 뒤쪽 노트 ${pulled}개 당겨 붙임 (전체 트랙, undo_edit으로 되돌리기)\n곡 길이: ${totalBars(state.song)}마디`;
  },

  undo_edit({ steps } = {}) {
    const n = steps === undefined ? 1 : Math.trunc(Number(steps));
    if (!Number.isFinite(n) || n < 1 || n > UNDO_DEPTH) throw new Error(`steps는 1~${UNDO_DEPTH} 사이여야 합니다`);
    const done = [];
    for (let i = 0; i < n; i++) {
      if (!undoStack.length) break;
      done.push(stepHistory(undoStack, redoStack, "되돌리기"));
    }
    if (!done.length) throw new Error("되돌릴 편집이 없습니다");
    return `${done.map(l => `"${l}"`).join(", ")} 편집을 되돌렸습니다`
      + ` (남은 되돌리기 ${undoStack.length}단계, redo_edit으로 다시 적용)\n${songSummary(state.song)}`;
  },

  redo_edit({ steps } = {}) {
    const n = steps === undefined ? 1 : Math.trunc(Number(steps));
    if (!Number.isFinite(n) || n < 1 || n > UNDO_DEPTH) throw new Error(`steps는 1~${UNDO_DEPTH} 사이여야 합니다`);
    const done = [];
    for (let i = 0; i < n; i++) {
      if (!redoStack.length) break;
      done.push(stepHistory(redoStack, undoStack, "다시 적용"));
    }
    if (!done.length) throw new Error("다시 적용할 편집이 없습니다 — 되돌리기를 한 뒤에 쓸 수 있습니다");
    return `${done.map(l => `"${l}"`).join(", ")} 편집을 다시 적용했습니다`
      + ` (남은 다시하기 ${redoStack.length}단계)\n${songSummary(state.song)}`;
  },

  edit_history() {
    return `되돌리기 ${undoStack.length}단계 / 다시하기 ${redoStack.length}단계`
      + (undoStack.length ? `\n최근 편집(마지막이 가장 최신): ${undoStack.slice(-10).map(e => e.label).join(" → ")}` : "");
  },

  play({ from_bar, to_bar, loop } = {}) {
    const song = needSong();
    if (!song.tracks.some(t => t.notes.length)) throw new Error("재생할 노트가 없습니다 — add_notes로 먼저 노트를 넣으세요");
    const [from, to] = clampRange(song, from_bar, to_bar);
    const { rangeSec, level } = startPlayback(song, { fromBar: from, toBar: to, loop: !!loop }, broadcast);
    const levelText = levelLine(level);
    // MCP가 재생을 시작해도 열린 GUI가 같은 출력 진단을 받을 수 있게 별도 이벤트로 보낸다.
    broadcast({ type: "level", text: levelText, fromBar: from, toBar: to });
    return `▶ ${from}~${to}마디를 스피커로 재생 중 (${fmtBeats(rangeSec)}초${loop ? ", 루프 — stop으로 정지" : ""})\n${levelText}`;
  },

  stop() {
    return stopPlayback(broadcast) ? "⏹ 재생을 멈췄습니다" : "재생 중이 아닙니다";
  },

  save_song({ name } = {}) {
    const song = needSong();
    const n = typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : song.title;
    saveToLibrary(n, song);
    mutated();
    return `라이브러리에 "${n}" 보관 (총 ${libraryNames().length}곡)`;
  },

  // 두 안을 담아 두고 번갈아 들어 보기. 라이브러리에 보관하므로 재시작해도 남고 목록에도 보인다.
  // ⚡ 즉시 믹스로 재생 중에 바꾸면 듣던 자리에서 이어지므로 "어느 쪽이 나은지"를 바로 견줄 수 있다.
  ab_save({ slot } = {}) {
    const song = needSong();
    const s = abSlot(slot);
    saveToLibrary(abName(s), song);
    mutated();
    return `지금 곡을 ${s}안에 담았습니다 ("${song.title}") — 반대쪽을 담은 뒤 ab_load로 번갈아 들어 보세요`;
  },

  ab_load({ slot } = {}) {
    const s = abSlot(slot);
    const name = abName(s);
    if (!libraryNames().includes(name))
      throw new Error(`${s}안이 비어 있습니다 — 먼저 ab_save({slot:"${s}"})로 담으세요`);
    const target = validateSong(readFromLibrary(name));
    stopPlayback(broadcast);
    state.song = target;
    mutated();
    return `${s}안을 불러왔습니다.\n${songSummary(target)}`;
  },

  load_song({ name } = {}) {
    if (typeof name !== "string" || !name.trim()) throw new Error("name(라이브러리의 곡 이름)이 필요합니다 — list_songs로 확인하세요");
    const target = validateSong(readFromLibrary(name.trim()));
    if (state.song?.tracks.some(t => t.notes.length)) saveToLibrary(state.song.title, state.song); // 현재 곡 자동 보존
    stopPlayback(broadcast);
    state.song = target;
    mutated();
    return `불러왔습니다.\n${songSummary(target)}`;
  },

  // 다른 도구에서 만든 MIDI를 끌어온다. 기존 곡은 통째로 교체되지만 undo_edit으로 되돌아간다.
  import_midi({ path: inPath, quantize, title } = {}) {
    if (typeof inPath !== "string" || !inPath.trim())
      throw new Error("path에 가져올 .mid 파일 경로를 주세요 (예: ~/Downloads/song.mid)");
    const file = path.resolve(inPath.trim().replace(/^~(?=\/|$)/, os.homedir()));
    if (!fs.existsSync(file)) throw new Error(`파일이 없습니다: ${file}`);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`파일이 아닙니다: ${file}`);
    if (stat.size > 8 * 1024 * 1024) throw new Error(`MIDI 파일이 너무 큽니다(${(stat.size / 1e6).toFixed(1)}MB) — 8MB까지 읽습니다`);
    const { song, report } = importMidi(fs.readFileSync(file), {
      quantize,
      title: title ?? path.basename(file).replace(/\.midi?$/i, "")
    });
    for (const track of song.tracks) requirePresetAvailable(track.preset);
    state.song = song;
    mutated();
    // 멜로디 트랙이 16개 이상이면 가져오기는 되지만 다시 MIDI로 내보낼 수 없다(채널 15개 한계)
    const mel = song.tracks.filter(t => !isDrumPreset(t.preset)).length;
    return `가져왔습니다 — ${file}\n${report}\n${songSummary(song)}`
      + (mel > 15 ? `\n⚠ 멜로디 트랙이 ${mel}개라 이 곡은 다시 MIDI로 내보낼 수 없습니다(MIDI 채널은 15개까지) — WAV는 됩니다` : "")
      + `\n(원래 곡으로 돌아가려면 undo_edit)`;
  },

  check_key() {
    const song = needSong();
    const key = detectKey(song);
    // tonic만 보면 안 된다 — 무조 곡은 tonic 0에 확신도 0으로 나와 이 검사를 그냥 통과한다
    if (!keyTrusted(key))
      return `조성을 확실히 판정할 수 없습니다 (가장 가까운 후보 ${key.ko}, 확신도 ${Math.round(key.confidence * 100)}%)`
        + (key.warning ? `\n${key.warning}` : "")
        + `\n전조가 있거나 조성이 흐린 곡일 수 있습니다 — 화성 트랙만 보고 판정하려면 그 트랙만 남긴 뒤 다시 부르세요`;
    const bad = outOfKey(song, key);
    const total = [...bad.values()].reduce((n, set) => n + set.size, 0);
    return `조성: ${key.ko} (${key.name}) · 확신도 ${Math.round(key.confidence * 100)}%`
      + (total
        ? `\n조성에서 벗어난 음 ${total}개 — 마디:박:음이름\n`
          + [...bad].map(([name, set]) => `  ${name}: ${[...set].join(", ")}`).join("\n")
          + `\n(일부러 쓴 음일 수도 있습니다 — 되풀이되는 것은 의도로 보고 표시하지 않습니다)`
        : `\n조성에서 벗어난 음은 없습니다.`);
  },

  list_songs() {
    const names = libraryNames();
    if (!names.length) return "라이브러리가 비어 있습니다 — save_song으로 현재 곡을 보관하세요";
    return `보관된 곡 ${names.length}개 (오래된 순): ${names.join(" · ")}\n현재 열린 곡: ${state.song?.title ?? "(없음)"}`;
  },

  // ---------- 구간 피드백: GUI에서 사용자가 남기고, LLM이 읽고 반영한다 ----------
  add_feedback({ from_bar, to_bar, track, text } = {}) {
    const song = needSong();
    const t = typeof text === "string" ? text.trim() : "";
    if (!t) throw new Error("text(피드백 내용)가 필요합니다");
    if (t.length > 500) throw new Error("피드백은 500자 이내로 남겨주세요");
    const from = Number(from_bar);
    const to = Number(to_bar ?? from_bar);
    if (!Number.isInteger(from) || from < 1 || from > 999) throw new Error("from_bar는 1~999 정수여야 합니다");
    if (!Number.isInteger(to) || to < from || to > 999) throw new Error("to_bar는 from_bar 이상 999 이하 정수여야 합니다");
    const fb = song.feedback ?? (song.feedback = []);
    if (fb.filter(f => !f.done).length >= 100) throw new Error("열린 피드백이 너무 많습니다(100건) — 먼저 처리하거나 정리하세요");
    let trackName;
    if (typeof track === "string" && track.trim()) trackName = findTrack(song, track).name;
    const id = fb.reduce((m, f) => Math.max(m, f.id), 0) + 1;
    const item = { id, from_bar: from, to_bar: to, text: t, done: false, ts: new Date().toISOString() };
    if (trackName) item.track = trackName;
    fb.push(item);
    mutated();
    return `피드백 #${id} 등록 (${from}${to !== from ? `~${to}` : ""}마디${trackName ? ` · ${trackName}` : ""}): ${t}`;
  },

  list_feedback() {
    const song = needSong();
    const fb = song.feedback ?? [];
    const open = fb.filter(f => !f.done);
    if (!open.length) return `처리할 피드백이 없습니다${fb.length ? ` (완료 ${fb.length}건)` : ""}`;
    const lines = open.map(f =>
      `#${f.id} [${f.from_bar}${f.to_bar !== f.from_bar ? `~${f.to_bar}` : ""}마디${f.track ? ` · ${f.track}` : ""}] ${f.text}`);
    return `열린 피드백 ${open.length}건:\n${lines.join("\n")}\n\n항목을 반영한 뒤 resolve_feedback({id})로 완료 표시하세요. 구간만 다시 듣기: play({from_bar, to_bar})`;
  },

  resolve_feedback({ id } = {}) {
    const song = needSong();
    const f = (song.feedback ?? []).find(x => x.id === Number(id));
    if (!f) throw new Error(`피드백 #${id}가 없습니다 — list_feedback로 확인하세요`);
    if (f.done) return `피드백 #${id}는 이미 완료 상태입니다`;
    f.done = true;
    mutated();
    const remain = song.feedback.filter(x => !x.done).length;
    return `피드백 #${id} 완료${remain ? ` — 남은 피드백 ${remain}건` : " — 모두 처리했습니다"}`;
  },

  export({ format = "both", path: outPath, from_bar, to_bar, stems = false } = {}) {
    const song = needSong();
    if (!["midi", "wav", "both"].includes(format)) throw new Error(`format은 midi|wav|both (받은 값: ${format})`);
    if (!song.tracks.some(t => t.notes.length)) throw new Error("내보낼 노트가 없습니다");
    if (stems) return exportStems(song, outPath, from_bar, to_bar);
    const ranged = from_bar !== undefined || to_bar !== undefined;
    // 길이 상한은 오디오 렌더에만 적용된다 — MIDI만 뽑을 때는 10분을 넘겨도 막지 않는다
    const [from, to] = format === "midi"
      ? [from_bar ?? 1, Math.max(from_bar ?? 1, to_bar ?? totalBars(song))]
      : clampRange(song, from_bar, to_bar);
    const base = outPath
      ? path.resolve(String(outPath).replace(/^~(?=\/|$)/, os.homedir()))
      : path.join(EXPORT_DIR,
        safeName(song.title) || "aria-song");
    // MIDI는 항상 곡 전체다 — 구간 접미사는 실제로 구간만 담은 WAV에만 붙인다.
    // 경로를 직접 준 경우엔 사용자가 고른 이름이므로 손대지 않는다.
    const wavBase = outPath || !ranged ? base : `${base}-${from}-${to}마디`;
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const written = [];
    let level = null;
    if (format !== "wav") { fs.writeFileSync(`${base}.mid`, midiBuffer(song)); written.push(`${base}.mid (곡 전체)`); }
    if (format !== "midi") {
      const { left, right, sr, master } = renderRange(song, from, to);
      level = master ?? levelReport(left, right);
      if (master) level.lufs = lufs(left, right, sr).integrated;
      fs.writeFileSync(`${wavBase}.wav`, wavBuffer(left, right, sr));
      written.push(`${wavBase}.wav (${from}~${to}마디, ${fmtBeats(rangeSeconds(song, from, to))}초)`);
    }
    return `내보내기 완료:\n${written.map(w => `  ${w}`).join("\n")}`
      + (ranged && format === "both" ? `\n(구간 지정은 WAV에만 적용됩니다 — MIDI는 곡 전체)` : "")
      + (level ? `\n${levelLine(level)}` : "");
  }
};

// 공통 실행기 — 편집 이력·로그·에러 처리 포함. source: "mcp" | "gui"
export function runOp(name, args = {}, source = "mcp") {
  const op = Object.hasOwn(ops, name) ? ops[name] : undefined;
  if (!op) throw new Error(`알 수 없는 명령: ${name}`);
  // 실행 전 스냅숏 — 예외가 나면 아래로 내려오지 않으므로 실패한 연산은 이력을 건드리지 않는다
  const before = MUTATING.has(name) && state.song ? JSON.stringify(state.song) : null;
  try {
    const result = op(args);
    // 인자만 다르고 결과가 같은 연산(같은 값으로 set_track 등)은 이력을 채우지 않는다
    if (before !== null && JSON.stringify(state.song) !== before) pushUndo(undoLabel(name, args), before);
    addLog(source, opLogLine(name, args));
    return result;
  } catch (e) {
    addLog(source, `✗ ${name}: ${e.message}`);
    throw e;
  }
}

// 악기별 파일 내보내기 — 다른 도구(로직·에이블톤 등)에서 믹싱하려면 트랙마다 따로 필요하다.
// 스템은 트랙 볼륨·음소거 없이, 그러나 팬·리버브·구간 게인은 담아서 굽는다.
function exportStems(song, outPath, from_bar, to_bar) {
  const [from, to] = clampRange(song, from_bar, to_bar);
  const live = song.tracks.filter(t => t.notes.some(n => n.bar >= from && n.bar <= to));
  if (!live.length) throw new Error(`${from}~${to}마디에 소리가 나는 트랙이 없습니다`);
  const dir = outPath
    ? path.resolve(String(outPath).replace(/^~(?=\/|$)/, os.homedir()))
    : path.join(EXPORT_DIR, `${safeName(song.title) || "aria-song"}-스템`);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  live.forEach((t, i) => {
    // 파일 이름이 겹치지 않도록 번호를 앞에 붙인다 — 트랙 이름이 특수문자뿐이어도 안전하다
    const base = `${String(i + 1).padStart(2, "0")}-${safeName(t.name) || `트랙${i + 1}`}`;
    const { left, right, sr } = renderRange(song, from, to, { stem: t.name });
    fs.writeFileSync(path.join(dir, `${base}.wav`), wavBuffer(left, right, sr));
    written.push(`${base}.wav (${t.notes.filter(n => n.bar >= from && n.bar <= to).length}개 노트)`);
  });
  const skipped = song.tracks.length - live.length;
  return `악기별 파일 ${written.length}개를 내보냈습니다 — ${dir}\n${written.map(w => `  ${w}`).join("\n")}`
    + (skipped ? `\n(이 구간에 소리가 없는 트랙 ${skipped}개는 건너뛰었습니다)` : "")
    + `\n주의: 스템에는 트랙 볼륨·음소거가 빠져 있고 마스터 처리도 안 들어갑니다 — 다른 도구에서 다시 믹싱하라는 용도입니다`;
}

const safeName = s => String(s).replace(/[^\w가-힣ㄱ-ㅎa-zA-Z0-9 _-]+/g, "").trim().replace(/\s+/g, "-");

function opLogLine(name, args) {
  switch (name) {
    case "new_song": return `new_song ${args.template ? `템플릿=${args.template}` : ""} ${args.title ?? ""}`.trim();
    case "add_notes": return `add_notes ${args.track} ${Array.isArray(args.notes) ? args.notes.length : 0}개`;
    case "clear_notes": return `clear_notes ${args.track} ${args.from_bar ?? 1}~${args.to_bar ?? "끝"}`;
    case "set_region_gain": return `set_region_gain ${args.track} ${args.from_bar}~${args.to_bar ?? args.from_bar}마디 ${args.db > 0 ? "+" : ""}${args.db}dB${args.to_db !== undefined ? `→${args.to_db}dB` : ""}`;
    case "set_bend": return `set_bend ${args.track} ${args.bend > 0 ? "+" : ""}${args.bend}반음`;
    case "set_velocity": return `set_velocity ${args.track} ${args.vel !== undefined ? (args.to_vel !== undefined ? `${args.vel}→${args.to_vel}` : args.vel) : args.by !== undefined ? `${args.by > 0 ? "+" : ""}${args.by}` : `×${args.scale}`}`;
    case "copy_bars": return `copy_bars ${args.from_bar}~${args.to_bar ?? args.from_bar}마디 → ${args.at_bar}마디${args.times > 1 ? ` ×${args.times}` : ""}`;
    case "undo_edit": return `undo_edit 되돌리기${args.steps > 1 ? ` ${args.steps}단계` : ""}`;
    case "redo_edit": return `redo_edit 다시 적용${args.steps > 1 ? ` ${args.steps}단계` : ""}`;
    case "edit_history": return "edit_history 편집 이력";
    case "delete_note": return `delete_note ${args.track} ${args.bar}마디 ${args.pitch}`;
    case "resize_note": return `resize_note ${args.track} ${args.bar}마디 ${args.pitch} →${args.dur}박`;
    case "move_notes": return `move_notes ${args.track} ${Array.isArray(args.notes) ? `${args.notes.length}개` : `${args.from_bar ?? 1}~${args.to_bar ?? "끝"}마디`} ${args.by_beats > 0 ? "+" : ""}${args.by_beats}박`;
    case "delete_notes": return `delete_notes ${args.track} ${Array.isArray(args.notes) ? args.notes.length : 0}개`;
    case "move_note": return `move_note ${args.track} ${args.pitch} ${args.bar}마디 ${args.beat ?? ""}박→${args.to_bar ?? args.bar}마디 ${args.to_beat ?? ""}박`;
    case "split_note": return `split_note ${args.track} ${args.bar}마디 ${args.pitch} @${args.at_bar}마디 ${args.at_beat ?? 0}박`;
    case "insert_bars": return `insert_bars ${args.at_bar}마디 앞 ${args.count ?? 1}개`;
    case "delete_bars": return `delete_bars ${args.from_bar}~${args.to_bar ?? args.from_bar}마디`;
    case "set_track": return `set_track ${args.track} ${args.preset ?? ""} ${args.volume !== undefined ? `vol=${args.volume}` : ""}`.trim();
    case "play": return `play ${args.from_bar ?? 1}~${args.to_bar ?? "끝"}마디${args.loop ? " 루프" : ""}`;
    case "set_tempo": return `set_tempo ${args.bpm}bpm ${args.from_bar ? `${args.from_bar}마디${args.ramp ? " 점진" : ""}` : "기준"}`.trim();
    case "clear_tempo": return `clear_tempo ${args.from_bar ? `${args.from_bar}마디` : "전체"}`;
    case "humanize": return `humanize ${args.track} 타이밍±${args.timing ?? 0.02} 세기±${args.velocity ?? 8}`;
    case "swing": return `swing ${args.track} ${Math.round((args.amount ?? 0.5) * 100)}% ${args.unit === 0.25 ? "16분" : "8분"}`;
    case "quantize": return `quantize ${args.track} ${gridName(args.grid ?? 0.25)}${args.strength < 1 ? ` ${Math.round(args.strength * 100)}%` : ""}`;
    case "set_section": return `set_section ${args.bar}마디 "${args.label}"`;
    case "remove_section": return `remove_section ${args.bar ? `${args.bar}마디` : "전체"}`;
    case "export": return `export ${args.stems ? "악기별" : args.format ?? "both"}${args.from_bar || args.to_bar ? ` ${args.from_bar ?? 1}~${args.to_bar ?? "끝"}마디` : ""}`;
    case "import_midi": return `import_midi ${String(args.path ?? "").split("/").pop()}`;
    case "ab_save": return `ab_save ${args.slot}안에 담기`;
    case "ab_load": return `ab_load ${args.slot}안 듣기`;
    case "save_song": return `save_song ${args.name ?? ""}`.trim();
    case "load_song": return `load_song ${args.name ?? ""}`.trim();
    default: return `${name}${args.track ? ` ${args.track}` : ""}${args.bpm ? ` ${args.bpm}` : ""}`;
  }
}

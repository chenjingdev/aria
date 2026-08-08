// aria — 외부 샘플 악기·드럼 킷·선택적 출발 템플릿 정의.
// Aria는 자체 파형 합성기를 포함하지 않는다. 모든 프리셋은 설치된 SoundFont/SFZ 음원으로 렌더한다.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// 앱에 노출하는 managed pack catalog. 원본 오디오는 저장소에 넣지 않고 각 manifest가
// 정확한 공식 출처·체크섬·설치 위치와 선택 가능한 SFZ entry를 정의한다.
const CATALOG_MANIFEST_FILES = [
  "vsco2-ce.json",
  "philharmonia-all-sfz.json",
  "salamander-drumkit-sfz.json"
];
const CATALOG_MANIFESTS = CATALOG_MANIFEST_FILES.map(name => JSON.parse(fs.readFileSync(
  fileURLToPath(new URL(`../packs/${name}`, import.meta.url)), "utf8"
)));

function catalogSource(manifest, entry) {
  if (manifest.id === "philharmonia-all-sfz") return "Philharmonia";
  if (manifest.id === "salamander-drumkit-sfz") return "Salamander";
  if (manifest.id === "vsco2-ce") return "VSCO 2 CE";
  return entry.source ?? manifest.name ?? manifest.id;
}

function catalogRelease(entry) {
  // release는 noteOff 뒤의 실제 여운이다. 원본 파일의 전체 길이(durationSec,
  // maxSampleDurationSec)와 섞으면 짧은 노트 하나에도 수십 초 빈 꼬리가 붙는다.
  if (Number.isFinite(entry.release) && entry.release >= 0) return entry.release;
  if (entry.kind !== "pitched-instrument" &&
      Number.isFinite(entry.tailHintSec) && entry.tailHintSec >= 0) return entry.tailHintSec;
  const articulation = entry.articulation ?? "";
  if (/staccato|spiccato|pizzicato/.test(articulation)) return 0.55;
  if (/roll|tremolo|keyswitch/.test(articulation)) return 1.8;
  if (entry.drum || /percussion|mapped-kit|one-shot|clip/.test(`${entry.kind ?? ""} ${articulation}`)) return 6;
  return 1.1;
}

function catalogFamily(entry) {
  const raw = String(entry.family ?? "").trim();
  const text = `${entry.name ?? ""} ${entry.path ?? ""}`;
  if (raw === "Contrabass") return "Double Bass";
  if (raw === "Tenor Trombone") return "Trombone";
  if (raw === "Snare") return "Snare Drum";
  if (["Temp", "Misc 2", "Other"].includes(raw)) {
    if (/glock/i.test(text)) return "Glockenspiel";
    if (/nepalese.?bells?/i.test(text)) return "Nepalese Bells";
    if (/triangle/i.test(text)) return "Triangle";
    if (/timp/i.test(text)) return "Timpani";
    if (/tumba|conga/i.test(text)) return "Congas";
    if (/bongo/i.test(text)) return "Bongos";
    if (/vibra.?ring/i.test(text)) return "Vibra Ring";
    return "Sound Effects";
  }
  return raw || entry.category || "Other";
}

function catalogSpec(manifest, entry) {
  const articulation = entry.articulation ?? "sustain";
  const term = String(entry.label ?? articulation).split(/\s+[—·]\s+/)[0].trim();
  const source = catalogSource(manifest, entry);
  const family = catalogFamily(entry);
  const sourceEntry = entry.sourceEntry ?? entry.clip?.sourceEntry ?? null;
  const clipIdentity = entry.kind === "clip"
    ? [entry.recordedNote, entry.recordedDynamic,
      Number.isFinite(entry.durationSec) ? `${entry.durationSec.toFixed(3)}초` : null]
      .filter(Boolean).join(" · ") : "";
  const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
  const common = {
    engine: "sfizz",
    pack: manifest.id,
    sfz: entry.path,
    name: term && !String(entry.name).includes(term) ? `${entry.name} · ${term}` : entry.name,
    desc: `${source} 원본 SFZ · ${entry.label ?? articulation}${clipIdentity ? ` · ${clipIdentity}` : ""}`,
    family,
    familyDetail: entry.family ?? family,
    source,
    sourceDetail: entry.source ?? source,
    articulation,
    articulations: entry.articulations ?? null,
    defaultArticulation: entry.defaultArticulation ?? null,
    duration: entry.duration ?? null,
    durationSec: Number.isFinite(entry.durationSec) ? entry.durationSec : null,
    maxSampleDurationSec: Number.isFinite(entry.maxSampleDurationSec) ? entry.maxSampleDurationSec : null,
    tailHintSec: Number.isFinite(entry.tailHintSec) ? entry.tailHintSec : null,
    kind: entry.kind ?? (entry.drum ? "drum-kit" : "instrument"),
    category: entry.category ?? null,
    sourceEntry,
    recordedNote: entry.recordedNote ?? null,
    recordedDynamic: entry.recordedDynamic ?? null,
    aliasSearch: aliases.map(alias => [alias.id, alias.name, alias.path, ...(alias.sourcePaths ?? [])]
      .filter(Boolean).join(" ")).join(" ") || null,
    recommended: entry.recommended === true,
    bank: entry.gm?.bank ?? 0,
    gm: entry.gm?.program ?? 0,
    gain: 1,
    reverb: entry.drum ? 0.22 : 0.3,
    release: catalogRelease(entry)
  };
  if (!entry.drum) return common;
  return {
    ...common,
    drum: true,
    program: entry.gm?.program ?? 0,
    pieces: Object.fromEntries((entry.pieces ?? []).map(piece => [piece.id, piece.key])),
    pieceLabels: Object.fromEntries((entry.pieces ?? []).map(piece => [piece.id, piece.label])),
    pieceDurationsSec: Object.fromEntries((entry.pieces ?? [])
      .filter(piece => Number.isFinite(piece.durationSec) && piece.durationSec > 0)
      .map(piece => [piece.id, piece.durationSec])),
    pieceControls: Object.fromEntries((entry.pieces ?? [])
      .filter(piece => Array.isArray(piece.cc) && piece.cc.length)
      .map(piece => [piece.id, piece.cc]))
  };
}

// 드럼 킷의 공통 피스 이름 → General MIDI 퍼커션 노트(채널 10)
export const DRUM_PIECES = {
  "kick": 36, "snare": 38, "rim": 37, "clap": 39, "hhc": 42, "hho": 46,
  "tom-l": 43, "tom-m": 47, "tom-h": 50, "crash": 49, "ride": 51, "shaker": 70
};

// 선택적 출발 템플릿 — new_song(template)이 만드는 제품 스케치. 장르 정의가 아니며 노트는 비어 있다.
export const TEMPLATES = {
  "citypop": {
    name: "시티팝 출발 스케치", desc: "한 가지 band/electronic 방향: 96bpm · 샘플 드럼 + 핑거 베이스 + 전기피아노 + 패드", bpm: 96,
    tracks: [
      { name: "Drums", preset: "sf-band-kit", volume: 0.9, pan: 0 },
      { name: "Bass", preset: "sf-bass", volume: 0.85, pan: 0 },
      { name: "E.Piano", preset: "sf-epiano", volume: 0.8, pan: -0.15 },
      { name: "Lead", preset: "sf-warm-pad", volume: 0.7, pan: 0.1 }
    ]
  },
  "lofi": {
    name: "웜 루프 출발 스케치", desc: "한 가지 lo-fi-adjacent 방향: 72bpm · 샘플 드럼 + 핑거 베이스 + 전기피아노 + 오르골", bpm: 72,
    tracks: [
      { name: "Drums", preset: "sf-brush-kit", volume: 0.85, pan: 0 },
      { name: "Bass", preset: "sf-bass", volume: 0.8, pan: 0 },
      { name: "Keys", preset: "sf-fm-epiano", volume: 0.8, pan: -0.1 },
      { name: "Melody", preset: "sf-music-box", volume: 0.6, pan: 0.15 }
    ]
  },
  "ballad": {
    name: "발라드 출발 스케치", desc: "한 가지 slow narrative 방향: 68bpm · 그랜드 피아노 + 현악 앙상블 + 샘플 드럼", bpm: 68,
    tracks: [
      { name: "Piano", preset: "sf-piano-gm", volume: 0.9, pan: 0 },
      { name: "Strings", preset: "sf-strings", volume: 0.6, pan: 0 },
      { name: "Bass", preset: "sf-bass", volume: 0.75, pan: 0 },
      { name: "Drums", preset: "sf-band-kit", volume: 0.7, pan: 0 }
    ]
  },
  "bossa": {
    name: "어쿠스틱 2-feel 출발 스케치", desc: "한 가지 bossa-adjacent 방향: 128bpm(하프타임 느낌) · 샘플 드럼 + 그랜드 피아노 + 나일론 기타", bpm: 128,
    tracks: [
      { name: "Drums", preset: "sf-brush-kit", volume: 0.75, pan: 0 },
      { name: "Bass", preset: "sf-bass", volume: 0.8, pan: 0 },
      { name: "Piano", preset: "sf-piano-gm", volume: 0.8, pan: -0.1 },
      { name: "Guitar", preset: "sf-nylon", volume: 0.65, pan: 0.2 }
    ]
  },
  "edm": {
    name: "4-on-floor 샘플 출발 스케치", desc: "넓은 EDM 전체가 아닌 GM 전자음 샘플 방향: 124bpm · 샘플 드럼 + 신스 베이스 + 플럭 + 톱니 리드", bpm: 124,
    tracks: [
      { name: "Drums", preset: "sf-808-kit", volume: 0.95, pan: 0 },
      { name: "Bass", preset: "sf-synth-bass", volume: 0.9, pan: 0 },
      { name: "Chords", preset: "sf-pizzicato", volume: 0.7, pan: -0.1 },
      { name: "Lead", preset: "sf-saw-lead", volume: 0.75, pan: 0.1 }
    ]
  },
  "chiptune": {
    name: "칩 계열 샘플 출발 스케치", desc: "한 가지 chip-inspired GM 샘플 방향: 140bpm · 사각 리드 + 베이스 + 플럭 화성, 타악기는 곡에 맞게 별도 선택", bpm: 140,
    tracks: [
      { name: "Bass", preset: "sf-square-lead", volume: 0.7, pan: 0 },
      { name: "Lead", preset: "sf-square-lead", volume: 0.7, pan: 0.05 },
      { name: "Harmony", preset: "sf-pizzicato", volume: 0.55, pan: -0.15 }
    ]
  }
};

// ---------- SoundFont 기반 프리셋 ----------
// gm: 사운드폰트에서 찾을 General MIDI 프로그램 번호(MIDI 내보내기에도 그대로 쓰임)
export const SF_PRESETS = {
  // font: 반드시 사용할 사운드폰트 파일(~/.aria/soundfonts/ 기준). 없으면 오류로 표시하며 대체하지 않는다.
  // sf-piano는 기존 저장곡 호환을 위해 Salamander ID로 유지한다. 경량 GM판은 별도 ID다.
  "sf-piano-gm": { name: "Grand Piano (GM)", desc: "GeneralUser GM 그랜드 피아노 — 기본 폰트만 설치해도 사용할 수 있는 피아노", gm: 0, gain: 1.0, reverb: 0.22, release: 0.4, font: "default.sf2" },
  "sf-piano": { name: "Grand Piano (Salamander)", desc: "Salamander 야마하 C5 그랜드 피아노 — 전용 1.2GiB 파일, 벨로시티 16층", gm: 0, gain: 1.0, reverb: 0.25, release: 0.4, font: "salamander.sf2" },
  "sf-epiano": { name: "Tine E.Piano (GM)", desc: "틴 전기피아노 샘플", gm: 4, gain: 1.0, reverb: 0.22, release: 0.3, font: "default.sf2" },
  "sf-fm-epiano": { name: "Electric Piano 2 (GM)", desc: "GeneralUser GM 전기피아노 2 샘플", gm: 5, gain: 1.0, reverb: 0.2, release: 0.3, font: "default.sf2" },
  "sf-music-box": { name: "Music Box (GM)", desc: "GeneralUser GM 오르골 샘플", gm: 10, gain: 0.9, reverb: 0.4, release: 0.7, font: "default.sf2" },
  "sf-vibes": { name: "Vibraphone (GM)", desc: "비브라폰 샘플 — 재즈·라운지", gm: 11, gain: 1.0, reverb: 0.3, release: 0.8, font: "default.sf2" },
  "sf-glockenspiel-gm": { name: "Glockenspiel (GM)", desc: "GeneralUser GM 글로켄슈필 — 경량 기본 말렛", gm: 9, gain: 0.9, reverb: 0.25, release: 0.6, font: "default.sf2" },
  "sf-marimba-gm": { name: "Marimba (GM)", desc: "GeneralUser GM 마림바 — 경량 기본 말렛", gm: 12, gain: 1.0, reverb: 0.22, release: 0.5, font: "default.sf2" },
  "sf-xylophone-gm": { name: "Xylophone (GM)", desc: "GeneralUser GM 실로폰 — 경량 기본 말렛", gm: 13, gain: 0.95, reverb: 0.22, release: 0.4, font: "default.sf2" },
  "sf-organ": { name: "Drawbar Organ (GM)", desc: "드로우바 오르간 샘플", gm: 16, gain: 0.9, reverb: 0.2, release: 0.15, font: "default.sf2" },
  "sf-nylon": { name: "Nylon Guitar (GM)", desc: "나일론 기타 샘플 — 보사노바·발라드 아르페지오", gm: 24, gain: 1.0, reverb: 0.25, release: 0.3, font: "default.sf2" },
  "sf-steel": { name: "Steel Guitar (GM)", desc: "스틸 어쿠스틱 기타 샘플 — 포크·팝 스트로크", gm: 25, gain: 1.0, reverb: 0.22, release: 0.3, font: "default.sf2" },
  "sf-bass": { name: "Finger Bass (GM)", desc: "핑거 일렉 베이스 샘플", gm: 33, gain: 1.0, reverb: 0.05, release: 0.15, font: "default.sf2" },
  "sf-synth-bass": { name: "Synth Bass 1 (GM)", desc: "GeneralUser GM 신스 베이스 샘플", gm: 38, gain: 1.0, reverb: 0.04, release: 0.15, font: "default.sf2" },
  "sf-pizzicato": { name: "Pizzicato Pluck (GM)", desc: "GeneralUser GM 피치카토 현악 샘플", gm: 45, gain: 1.0, reverb: 0.25, release: 0.7, font: "default.sf2" },
  "sf-harp-gm": { name: "Orchestral Harp (GM)", desc: "GeneralUser GM 오케스트라 하프 — 경량 기본 하프", gm: 46, gain: 1.0, reverb: 0.28, release: 0.8, font: "default.sf2" },
  "sf-timpani-gm": { name: "Timpani (GM)", desc: "GeneralUser GM 팀파니 — 경량 기본 팀파니", gm: 47, gain: 1.0, reverb: 0.3, release: 0.8, font: "default.sf2" },
  "sf-strings": { name: "String Ensemble (GM)", desc: "GeneralUser GM 현악 앙상블 샘플", gm: 48, gain: 0.9, reverb: 0.4, release: 0.6, font: "default.sf2" },
  "sf-fantasia": { name: "New Age Pad (GM)", desc: "GeneralUser GM 판타지아 계열 패드 샘플", gm: 88, gain: 0.8, reverb: 0.4, release: 0.7, font: "default.sf2" },
  "sf-warm-pad": { name: "Warm Pad (GM)", desc: "GeneralUser GM 웜 패드 샘플", gm: 89, gain: 0.8, reverb: 0.45, release: 0.8, font: "default.sf2" },
  "sf-square-lead": { name: "Square Lead (GM)", desc: "GeneralUser GM 사각 리드 샘플", gm: 80, gain: 0.9, reverb: 0.2, release: 0.2, font: "default.sf2" },
  "sf-saw-lead": { name: "Saw Lead (GM)", desc: "GeneralUser GM 톱니 리드 샘플", gm: 81, gain: 0.9, reverb: 0.22, release: 0.2, font: "default.sf2" },
  // 기존 ID는 GeneralUser GM 선택지로 유지한다. Philharmonia는 아래의 -phil ID에서 명시적으로 고른다.
  "sf-violin": { name: "Violin (GM)", desc: "바이올린 — GeneralUser GM 독주 현악", gm: 40, gain: 1.15, reverb: 0.3, release: 0.5, font: "default.sf2" },
  "sf-viola": { name: "Viola (GM)", desc: "비올라 — GeneralUser GM 중음 현악", gm: 41, gain: 1.25, reverb: 0.3, release: 0.5, font: "default.sf2" },
  "sf-cello": { name: "Cello (GM)", desc: "첼로 — GeneralUser GM 저중음 현악", gm: 42, gain: 1.1, reverb: 0.3, release: 0.5, font: "default.sf2" },
  "sf-contrabass": { name: "Contrabass (GM)", desc: "콘트라베이스 — GeneralUser GM 최저음 현악", gm: 43, gain: 0.7, reverb: 0.25, release: 0.5, font: "default.sf2" },
  "sf-violin-pizz": { name: "Pizzicato Strings High (GM)", desc: "고음역 피치카토 — GeneralUser GM 앙상블", gm: 45, gain: 1.1, reverb: 0.25, release: 1.2, font: "default.sf2" },
  "sf-viola-pizz": { name: "Pizzicato Strings Mid (GM)", desc: "중음역 피치카토 — GeneralUser GM 앙상블", gm: 45, gain: 1.15, reverb: 0.25, release: 1.2, font: "default.sf2" },
  "sf-contrabass-pizz": { name: "Acoustic Bass Pizz. (GM)", desc: "콘트라베이스 피치카토 대체음 — GeneralUser GM 어쿠스틱 베이스", gm: 32, gain: 1.0, reverb: 0.15, release: 1.2, font: "default.sf2" },
  "sf-violin-sord": { name: "Slow Strings (GM)", desc: "약음기 현악 대체음 — GeneralUser GM 슬로 스트링", gm: 49, gain: 1.2, reverb: 0.35, release: 0.5, font: "default.sf2" },
  "sf-choir": { name: "Choir Aahs (GM)", desc: "GeneralUser GM 합창 아~ 샘플", gm: 52, gain: 0.9, reverb: 0.45, release: 0.6, font: "default.sf2" },
  "sf-brass": { name: "Brass Section (GM)", desc: "GeneralUser GM 브라스 섹션 샘플", gm: 61, gain: 0.95, reverb: 0.2, release: 0.2, font: "default.sf2" },
  "sf-sax": { name: "Alto Sax (GM)", desc: "GeneralUser GM 알토 색소폰", gm: 65, gain: 1.0, reverb: 0.25, release: 0.25, font: "default.sf2" },
  "sf-flute": { name: "Flute (GM)", desc: "GeneralUser GM 플루트", gm: 73, gain: 0.95, reverb: 0.3, release: 0.3, font: "default.sf2" },
  "sf-oboe": { name: "Oboe (GM)", desc: "GeneralUser GM 오보에", gm: 68, gain: 0.95, reverb: 0.3, release: 0.3, font: "default.sf2" },
  "sf-english-horn": { name: "English Horn (GM)", desc: "GeneralUser GM 코랑글레", gm: 69, gain: 1.0, reverb: 0.3, release: 0.3, font: "default.sf2" },
  "sf-clarinet": { name: "Clarinet (GM)", desc: "GeneralUser GM 클라리넷", gm: 71, gain: 0.95, reverb: 0.28, release: 0.3, font: "default.sf2" },
  "sf-bass-clarinet": { name: "Bass Clarinet Sketch (GM)", desc: "GeneralUser GM 클라리넷을 저음역에서 쓰는 대체음", gm: 71, gain: 1.0, reverb: 0.28, release: 0.35, font: "default.sf2" },
  "sf-bassoon": { name: "Bassoon (GM)", desc: "GeneralUser GM 바순", gm: 70, gain: 1.0, reverb: 0.28, release: 0.3, font: "default.sf2" },
  "sf-contrabassoon": { name: "Contrabassoon Sketch (GM)", desc: "GeneralUser GM 바순을 최저음역에서 쓰는 대체음", gm: 70, gain: 1.05, reverb: 0.25, release: 0.35, font: "default.sf2" },
  "sf-horn": { name: "French Horn (GM)", desc: "GeneralUser GM 프렌치 호른", gm: 60, gain: 0.95, reverb: 0.35, release: 0.4, font: "default.sf2" },
  "sf-trumpet": { name: "Trumpet (GM)", desc: "GeneralUser GM 트럼펫", gm: 56, gain: 0.9, reverb: 0.3, release: 0.25, font: "default.sf2" },
  "sf-trombone": { name: "Trombone (GM)", desc: "GeneralUser GM 트롬본", gm: 57, gain: 0.95, reverb: 0.3, release: 0.3, font: "default.sf2" },
  "sf-tuba": { name: "Tuba (GM)", desc: "GeneralUser GM 튜바", gm: 58, gain: 1.0, reverb: 0.25, release: 0.35, font: "default.sf2" },

  // 사용자가 별도로 설치한 Philharmonia 4개 폰트를 명시적으로 고르는 선택지. 누락 시 GM으로 대체하지 않는다.
  // program은 이 전용 SF2 안의 실제 번호, gm은 표준 MIDI로 내보낼 때의 가장 가까운 프로그램이다.
  "sf-violin-phil": { name: "Violin (Philharmonia)", desc: "Philharmonia 바이올린 샘플", program: 40, gm: 40, gain: 1.0, reverb: 0.3, release: 0.5, font: "philharmonia.sf2" },
  "sf-viola-phil": { name: "Viola (Philharmonia)", desc: "Philharmonia 비올라 샘플", program: 41, gm: 41, gain: 1.0, reverb: 0.3, release: 0.5, font: "philharmonia.sf2" },
  "sf-cello-phil": { name: "Cello (Philharmonia)", desc: "Philharmonia 첼로 샘플", program: 42, gm: 42, gain: 1.0, reverb: 0.3, release: 0.5, font: "philharmonia.sf2" },
  "sf-contrabass-phil": { name: "Contrabass (Philharmonia)", desc: "Philharmonia 콘트라베이스 샘플", program: 43, gm: 43, gain: 0.85, reverb: 0.28, release: 0.55, font: "philharmonia.sf2" },
  "sf-violin-pizz-phil": { name: "Violin Pizzicato (Philharmonia)", desc: "Philharmonia 바이올린 피치카토 샘플", program: 44, gm: 45, gain: 1.0, reverb: 0.25, release: 0.9, font: "philharmonia.sf2" },
  "sf-viola-pizz-phil": { name: "Viola Pizzicato (Philharmonia)", desc: "Philharmonia 비올라 피치카토 샘플", program: 45, gm: 45, gain: 1.0, reverb: 0.25, release: 0.9, font: "philharmonia.sf2" },
  "sf-contrabass-pizz-phil": { name: "Contrabass Pizzicato (Philharmonia)", desc: "Philharmonia 콘트라베이스 피치카토 샘플", program: 46, gm: 32, gain: 0.9, reverb: 0.22, release: 1.0, font: "philharmonia.sf2" },
  "sf-violin-sord-phil": { name: "Violin Sordino (Philharmonia)", desc: "Philharmonia 약음기 바이올린 샘플", program: 48, gm: 49, gain: 1.0, reverb: 0.35, release: 0.55, font: "philharmonia.sf2" },
  "sf-flute-phil": { name: "Flute (Philharmonia)", desc: "Philharmonia 플루트 샘플", program: 73, gm: 73, gain: 0.95, reverb: 0.3, release: 0.3, font: "phil-winds.sf2" },
  "sf-oboe-phil": { name: "Oboe (Philharmonia)", desc: "Philharmonia 오보에 샘플", program: 68, gm: 68, gain: 0.95, reverb: 0.3, release: 0.3, font: "phil-winds.sf2" },
  "sf-english-horn-phil": { name: "English Horn (Philharmonia)", desc: "Philharmonia 코랑글레 샘플", program: 69, gm: 69, gain: 1.0, reverb: 0.3, release: 0.3, font: "phil-winds.sf2" },
  "sf-clarinet-phil": { name: "Clarinet (Philharmonia)", desc: "Philharmonia 클라리넷 샘플", program: 71, gm: 71, gain: 0.95, reverb: 0.28, release: 0.3, font: "phil-winds.sf2" },
  "sf-bass-clarinet-phil": { name: "Bass Clarinet (Philharmonia)", desc: "Philharmonia 베이스 클라리넷 샘플", program: 72, gm: 71, gain: 1.0, reverb: 0.28, release: 0.35, font: "phil-winds.sf2" },
  "sf-bassoon-phil": { name: "Bassoon (Philharmonia)", desc: "Philharmonia 바순 샘플", program: 70, gm: 70, gain: 1.0, reverb: 0.28, release: 0.3, font: "phil-winds.sf2" },
  "sf-contrabassoon-phil": { name: "Contrabassoon (Philharmonia)", desc: "Philharmonia 콘트라바순 샘플", program: 74, gm: 70, gain: 1.05, reverb: 0.25, release: 0.35, font: "phil-winds.sf2" },
  "sf-sax-phil": { name: "Alto Sax (Philharmonia)", desc: "Philharmonia 알토 색소폰 샘플", program: 65, gm: 65, gain: 1.0, reverb: 0.25, release: 0.25, font: "phil-winds.sf2" },
  "sf-trumpet-phil": { name: "Trumpet (Philharmonia)", desc: "Philharmonia 트럼펫 샘플", program: 56, gm: 56, gain: 0.9, reverb: 0.3, release: 0.25, font: "phil-brass.sf2" },
  "sf-horn-phil": { name: "French Horn (Philharmonia)", desc: "Philharmonia 프렌치 호른 샘플", program: 60, gm: 60, gain: 0.95, reverb: 0.35, release: 0.4, font: "phil-brass.sf2" },
  "sf-trombone-phil": { name: "Trombone (Philharmonia)", desc: "Philharmonia 트롬본 샘플", program: 57, gm: 57, gain: 0.95, reverb: 0.3, release: 0.3, font: "phil-brass.sf2" },
  "sf-tuba-phil": { name: "Tuba (Philharmonia)", desc: "Philharmonia 튜바 샘플", program: 58, gm: 58, gain: 1.0, reverb: 0.25, release: 0.35, font: "phil-brass.sf2" },
  "sf-timpani": { name: "Timpani (VSCO)", desc: "팀파니 — 실녹음 다이내믹 3층, 오케스트라의 천둥, F#1~D#2 부근", gm: 47, gain: 1.0, reverb: 0.35, release: 0.8, font: "vsco.sf2" },
  "sf-harp": { name: "Harp (VSCO)", desc: "하프 — 아르페지오·글리산도, 서정적 색채", gm: 46, gain: 1.0, reverb: 0.35, release: 0.8, font: "vsco.sf2" },
  "sf-glockenspiel": { name: "Glockenspiel (VSCO)", desc: "글로켄슈필 — 반짝이는 금속 종소리 고음", gm: 9, gain: 0.9, reverb: 0.3, release: 0.6, font: "vsco.sf2" },
  "sf-marimba": { name: "Marimba (VSCO)", desc: "마림바 — 둥글고 따뜻한 나무 말렛", gm: 12, gain: 1.0, reverb: 0.25, release: 0.5, font: "vsco.sf2" },
  "sf-xylophone": { name: "Xylophone (VSCO)", desc: "실로폰 — 마르고 또렷한 나무 말렛 고음", gm: 13, gain: 0.95, reverb: 0.25, release: 0.4, font: "vsco.sf2" },
  "sf-cello-pizz": { name: "Cello Pizz (VSCO)", desc: "첼로 섹션 피치카토 — 통통 튀는 저음 반주", gm: 45, gain: 1.05, reverb: 0.25, release: 1.0, font: "vsco.sf2" },
  "sf-bandoneon": { name: "Tango Accordion (GM)", desc: "GeneralUser GM 탱고 아코디언 샘플", gm: 23, gain: 0.95, reverb: 0.25, release: 0.2, font: "default.sf2" }
};

// 공식/준비된 catalog의 모든 선율·주법 entry를 부분 선별하지 않고 등록한다.
for (const manifest of CATALOG_MANIFESTS) for (const entry of manifest.catalog ?? []) {
  if (entry.drum) continue;
  if (!entry.id || !entry.path || Object.hasOwn(SF_PRESETS, entry.id))
    throw new Error(`${manifest.id} catalog melodic entry가 올바르지 않습니다: ${entry?.id ?? "(id 없음)"}`);
  SF_PRESETS[entry.id] = catalogSpec(manifest, entry);
}

// 같은 악기의 음원 출처만 다른 선택지를 UI에서 한 그룹으로 보여주기 위한 표시 메타데이터.
// family는 사용자에게 보일 악기군 이름, source는 해당 샘플 라이브러리 이름이다.
const SOURCE_VARIANT_FAMILIES = [
  ["Grand Piano", [["sf-piano-gm", "GM"], ["sf-piano", "Salamander"]]],
  ["Glockenspiel", [["sf-glockenspiel-gm", "GM"], ["sf-glockenspiel", "VSCO"]]],
  ["Marimba", [["sf-marimba-gm", "GM"], ["sf-marimba", "VSCO"]]],
  ["Xylophone", [["sf-xylophone-gm", "GM"], ["sf-xylophone", "VSCO"]]],
  ["Orchestral Harp", [["sf-harp-gm", "GM"], ["sf-harp", "VSCO"]]],
  ["Timpani", [["sf-timpani-gm", "GM"], ["sf-timpani", "VSCO"]]],
  ["Violin", [["sf-violin", "GM"], ["sf-violin-phil", "Philharmonia"]]],
  ["Viola", [["sf-viola", "GM"], ["sf-viola-phil", "Philharmonia"]]],
  ["Cello", [["sf-cello", "GM"], ["sf-cello-phil", "Philharmonia"]]],
  ["Double Bass", [["sf-contrabass", "GM"], ["sf-contrabass-phil", "Philharmonia"]]],
  ["Violin Pizzicato", [["sf-violin-pizz", "GM"], ["sf-violin-pizz-phil", "Philharmonia"]]],
  ["Viola Pizzicato", [["sf-viola-pizz", "GM"], ["sf-viola-pizz-phil", "Philharmonia"]]],
  ["Double Bass Pizzicato", [["sf-contrabass-pizz", "GM"], ["sf-contrabass-pizz-phil", "Philharmonia"]]],
  ["Violin Sordino", [["sf-violin-sord", "GM"], ["sf-violin-sord-phil", "Philharmonia"]]],
  ["Flute", [["sf-flute", "GM"], ["sf-flute-phil", "Philharmonia"]]],
  ["Oboe", [["sf-oboe", "GM"], ["sf-oboe-phil", "Philharmonia"]]],
  ["English Horn", [["sf-english-horn", "GM"], ["sf-english-horn-phil", "Philharmonia"]]],
  ["Clarinet", [["sf-clarinet", "GM"], ["sf-clarinet-phil", "Philharmonia"]]],
  ["Bass Clarinet", [["sf-bass-clarinet", "GM"], ["sf-bass-clarinet-phil", "Philharmonia"]]],
  ["Bassoon", [["sf-bassoon", "GM"], ["sf-bassoon-phil", "Philharmonia"]]],
  ["Contrabassoon", [["sf-contrabassoon", "GM"], ["sf-contrabassoon-phil", "Philharmonia"]]],
  ["Alto Sax", [["sf-sax", "GM"], ["sf-sax-phil", "Philharmonia"]]],
  ["Trumpet", [["sf-trumpet", "GM"], ["sf-trumpet-phil", "Philharmonia"]]],
  ["French Horn", [["sf-horn", "GM"], ["sf-horn-phil", "Philharmonia"]]],
  ["Trombone", [["sf-trombone", "GM"], ["sf-trombone-phil", "Philharmonia"]]],
  ["Tuba", [["sf-tuba", "GM"], ["sf-tuba-phil", "Philharmonia"]]]
];
for (const [family, variants] of SOURCE_VARIANT_FAMILIES)
  for (const [id, source] of variants) Object.assign(SF_PRESETS[id], { family, source });

// 단독으로만 등록된 경량 SoundFont 프리셋도 출처·악기군을 빠뜨리지 않는다.
// 이름에서 괄호 안의 출처 표기를 걷어낸 값은 검색용 family의 안전한 기본값이다.
const staticSource = preset => preset.font === "default.sf2" ? "GM"
  : preset.font?.startsWith("salamander") ? "Salamander"
  : preset.font?.startsWith("vsco") ? "VSCO"
  : preset.font?.startsWith("phil") ? "Philharmonia" : "SoundFont";
const staticFamily = preset => String(preset.name).replace(/\s*\([^)]*\)\s*$/, "").trim();
for (const preset of Object.values(SF_PRESETS)) {
  if (!preset.source) preset.source = staticSource(preset);
  if (!preset.family) preset.family = staticFamily(preset);
}

// GM 확장 타악 피스 — sf-orch-kit의 기존 곡 호환용 이름을 유지한다.
export const ORCH_PIECES = {
  kick: 36, snare: 38, "tom-l": 43, "tom-m": 47, "tom-h": 50, crash: 49, ride: 51,
  tamtam: 52, tambourine: 54, cowbell: 56, agogo: 67, cabasa: 69, guiro: 73,
  woodblock: 76, triangle: 81, sleigh: 83, castanets: 85
};

// 샘플 드럼 킷 — pitch는 기존 피스 이름 그대로, GM 노트로 매핑되어 사운드폰트 킷을 친다
// pieces: 킷 전용 피스 어휘(없으면 DRUM_PIECES). 검증·렌더·MIDI 내보내기가 이 맵을 따른다.
export const SF_DRUM_KITS = {
  // release: 렌더 꼬리 계산용 — 크래시·오픈햇 잔향 실측(-60dB ≈ 3.1초)을 담는 값
  "sf-kit": { name: "Studio Kit (GM)", desc: "GeneralUser GM Standard 드럼 샘플", bank: 128, program: 0, release: 3.0, font: "default.sf2" },
  "sf-808-kit": { name: "Electronic Kit (GM)", desc: "GeneralUser 전자 드럼 샘플", bank: 128, program: 25, release: 3.0, font: "default.sf2" },
  "sf-brush-kit": { name: "Brush Kit (GM)", desc: "GeneralUser 브러시 드럼 샘플", bank: 128, program: 40, release: 3.5, font: "default.sf2" },
  "sf-band-kit": { name: "Band Kit (Salamander)", desc: "어쿠스틱 밴드 드럼 실녹음 — 팝·록·발라드, 벨로시티 다층 펀치", bank: 128, program: 0, release: 4.2, font: "salamander-kit.sf2", velRange: 0.7 },
  "sf-orch-kit": {
    name: "Extended Percussion (GM)", desc: "기본 GM 폰트의 확장 타악. 피스: kick·snare·tom-l/m/h·crash·ride·tamtam·triangle·tambourine·castanets·woodblock·sleigh·cowbell·agogo·cabasa·guiro",
    bank: 128, program: 0, release: 6.0, pieces: ORCH_PIECES, velRange: 0.9, font: "default.sf2",
    family: "Orchestral Percussion", source: "GM"
  },
  "sf-orch-kit-phil": {
    name: "Orchestral Percussion (Philharmonia)", desc: "Philharmonia 오케스트라 타악 샘플. 피스: kick·snare·tom-l/m/h·crash·ride·tamtam·triangle·tambourine·castanets·woodblock·sleigh·cowbell·agogo·cabasa·guiro",
    bank: 128, program: 0, release: 6.0, pieces: ORCH_PIECES, velRange: 0.9, font: "phil-perc.sf2",
    family: "Orchestral Percussion", source: "Philharmonia"
  }
};

for (const preset of Object.values(SF_DRUM_KITS)) {
  if (!preset.source) preset.source = staticSource(preset);
  if (!preset.family) preset.family = staticFamily(preset);
}

for (const manifest of CATALOG_MANIFESTS) for (const entry of manifest.catalog ?? []) {
  if (!entry.drum) continue;
  if (!entry.id || !entry.path || Object.hasOwn(SF_DRUM_KITS, entry.id))
    throw new Error(`${manifest.id} catalog drum entry가 올바르지 않습니다: ${entry?.id ?? "(id 없음)"}`);
  SF_DRUM_KITS[entry.id] = catalogSpec(manifest, entry);
}

// 킷의 피스 어휘 — 킷 전용 맵이 있으면 그것, 없으면 공통 DRUM_PIECES
export function drumPieces(id) { return SF_DRUM_KITS[id]?.pieces ?? DRUM_PIECES; }
// 같은 MIDI key를 CC 상태로 나누는 피스(예: Salamander 하이햇 개방도)의
// 원래 controller 값을 MIDI/SFZ 경로가 공통으로 사용한다.
export function drumPieceControls(id) { return SF_DRUM_KITS[id]?.pieceControls ?? {}; }

export function isSfPreset(id) { return Object.hasOwn(SF_PRESETS, id); }
export function isSfDrumKit(id) { return Object.hasOwn(SF_DRUM_KITS, id); }
export function isDrumPreset(id) { return isSfDrumKit(id); }
export function presetExists(id) { return isSfPreset(id) || isSfDrumKit(id); }
export function presetKind(id) {
  const spec = SF_PRESETS[id] ?? SF_DRUM_KITS[id];
  if (!spec) return null;
  if (spec.kind === "clip") return "clip";
  return isSfDrumKit(id) ? "percussion" : "instrument";
}
export function presetDurationSec(id) {
  const spec = SF_PRESETS[id] ?? SF_DRUM_KITS[id];
  if (spec?.kind !== "clip") return null;
  const value = spec.durationSec;
  return Number.isFinite(value) && value > 0 ? value : null;
}
export function presetArticulations(id) {
  const value = (SF_PRESETS[id] ?? SF_DRUM_KITS[id])?.articulations;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
export function presetDefaultArticulation(id) {
  const spec = SF_PRESETS[id] ?? SF_DRUM_KITS[id];
  return spec?.defaultArticulation ?? null;
}
export function presetLabel(id) {
  return SF_PRESETS[id]?.name ?? SF_DRUM_KITS[id]?.name ?? id;
}
// MIDI 내보내기용 GM 프로그램 번호
export function presetGm(id) { return SF_PRESETS[id]?.gm ?? 0; }

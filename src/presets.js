// aria — 악기 프리셋 · 드럼 킷 · 스타일 템플릿 정의
// engine: "fm"(2op+ FM) | "sub"(감산합성) | "add"(가산합성)
// gm: MIDI 내보내기 시 사용할 General MIDI 프로그램 번호(0-based)

export const PRESETS = {
  "soft-piano": {
    name: "Soft Piano", desc: "부드러운 어쿠스틱 피아노 느낌 — 발라드 반주", gm: 0,
    engine: "fm", gain: 0.9, reverb: 0.22,
    params: { ops: [{ ratio: 1, index: 1.1, decay: 2.5 }, { ratio: 3, index: 0.35, decay: 0.25 }],
      adsr: [0.002, 2.8, 0, 0.35], lp: 5500, keyscale: 0.5 }
  },
  "fm-epiano": {
    name: "FM E.Piano", desc: "DX7 계열 전기피아노 — 시티팝·R&B 코드 반주의 기본", gm: 4,
    engine: "fm", gain: 0.9, reverb: 0.2,
    params: { ops: [{ ratio: 1, index: 1.6, decay: 1.4 }, { ratio: 14, index: 0.4, decay: 0.06 }],
      adsr: [0.002, 1.9, 0, 0.3], lp: 7500, keyscale: 0.4 }
  },
  "wurli": {
    name: "Wurli Soft", desc: "우울리처 느낌의 따뜻한 전기피아노 — 로파이·소울", gm: 5,
    engine: "fm", gain: 0.9, reverb: 0.18,
    params: { ops: [{ ratio: 1, index: 0.9, decay: 0.9 }, { ratio: 7, index: 0.25, decay: 0.05 }],
      adsr: [0.003, 1.4, 0, 0.25], lp: 3800, keyscale: 0.4 }
  },
  "dx-lush": {
    name: "DX Lush", desc: "디튠된 FM 패드성 키보드 — 몽환적인 코드에", gm: 88,
    engine: "fm", gain: 0.7, reverb: 0.42,
    params: { ops: [{ ratio: 2, index: 1.1, decay: 1.2 }, { ratio: 1, index: 0.7, decay: 2.2 }],
      adsr: [0.03, 2.6, 0.15, 0.7], lp: 6500, keyscale: 0.3, voices: 2, detune: 7 }
  },
  "music-box": {
    name: "Music Box", desc: "오르골 — 잔향 긴 고음 멜로디", gm: 10,
    engine: "fm", gain: 0.8, reverb: 0.45,
    params: { ops: [{ ratio: 3.93, index: 0.5, decay: 0.12 }],
      adsr: [0.001, 2.4, 0, 0.5], lp: 9000, keyscale: 0.2 }
  },
  "finger-bass": {
    name: "Finger Bass", desc: "핑거 일렉 베이스 — 시티팝·팝의 기본 베이스", gm: 33,
    engine: "sub", gain: 1.0, reverb: 0.04,
    params: { oscs: [{ wave: "triangle", level: 0.75 }, { wave: "saw", level: 0.4 }],
      cutoff: 900, fenv: 1900, fdecay: 0.16, adsr: [0.004, 0.34, 0.3, 0.09] }
  },
  "synth-bass": {
    name: "Synth Bass", desc: "굵은 신스 베이스 — EDM·펑크", gm: 38,
    engine: "sub", gain: 1.0, reverb: 0.03,
    params: { oscs: [{ wave: "saw", level: 0.55 }, { wave: "square", oct: -1, level: 0.35 }, { wave: "sine", oct: -1, level: 0.42 }],
      unison: { voices: 3, detune: 7, spread: 0.22 }, // 저역은 좁게 — 넓히면 위상이 무너진다
      cutoff: 750, fenv: 2600, fdecay: 0.12, adsr: [0.003, 0.3, 0.4, 0.08] }
  },
  "airy-synth": {
    name: "Airy Synth", desc: "공기감 있는 신스 패드/리드 — 뒤에 깔거나 위에 띄우거나", gm: 89,
    engine: "sub", gain: 0.5, reverb: 0.5,
    params: { oscs: [{ wave: "saw", detune: -4, level: 0.45 }, { wave: "saw", detune: 4, level: 0.45 },
        { wave: "saw", oct: 1, detune: 2, level: 0.2 }],
      unison: { voices: 5, detune: 18, spread: 0.9 },
      cutoff: 3200, fenv: 800, fdecay: 0.6, adsr: [0.28, 0.8, 0.75, 0.9] }
  },
  "strings": {
    name: "Strings Pad", desc: "현악 앙상블 패드 — 발라드·영화음악", gm: 48,
    engine: "sub", gain: 0.5, reverb: 0.45,
    params: { oscs: [{ wave: "saw", detune: -3, level: 0.4 }, { wave: "saw", detune: 3, level: 0.4 },
        { wave: "saw", oct: -1, level: 0.25 }],
      unison: { voices: 5, detune: 10, spread: 0.8 },
      cutoff: 4200, fenv: 400, fdecay: 1.0, adsr: [0.4, 1.2, 0.8, 1.3] }
  },
  "pluck": {
    name: "Pluck", desc: "짧게 튕기는 신스 플럭 — 아르페지오·리듬 백킹", gm: 45,
    engine: "sub", gain: 0.8, reverb: 0.3,
    params: { oscs: [{ wave: "saw", level: 0.65 }, { wave: "square", level: 0.18 }],
      unison: { voices: 5, detune: 12, spread: 0.7 },
      cutoff: 1200, fenv: 5200, fdecay: 0.09, adsr: [0.001, 0.22, 0, 0.12] }
  },
  "saw-lead": {
    name: "Saw Lead", desc: "선명한 톱니파 리드 — 멜로디 전면에", gm: 81,
    engine: "sub", gain: 0.78, reverb: 0.25,
    params: { oscs: [{ wave: "saw", level: 0.55 }, { wave: "saw", oct: -1, level: 0.22 }],
      unison: { voices: 7, detune: 16, spread: 0.85 }, // 수퍼쏘 — 현대 팝 리드의 기본형
      cutoff: 6500, fenv: 1500, fdecay: 0.25, adsr: [0.008, 0.4, 0.75, 0.18] }
  },
  "square-lead": {
    name: "Square Lead", desc: "칩튠 느낌 사각파 리드 — 레트로 게임 멜로디", gm: 80,
    engine: "sub", gain: 0.6, reverb: 0.22,
    params: { oscs: [{ wave: "square", level: 0.7 }],
      cutoff: 4800, fenv: 600, fdecay: 0.2, adsr: [0.005, 0.3, 0.65, 0.12] }
  },
  "organ": {
    name: "Organ", desc: "드로우바 오르간 — 가스펠·재즈·록", gm: 16,
    engine: "add", gain: 0.6, reverb: 0.2,
    params: { partials: [{ mult: 1, level: 0.55 }, { mult: 2, level: 0.4 }, { mult: 3, level: 0.18 },
        { mult: 4, level: 0.22 }, { mult: 8, level: 0.1 }],
      adsr: [0.004, 0.04, 0.92, 0.06] }
  }
};

// 드럼 킷 — pitch 자리에 피스 이름을 쓴다 (예: "kick", "snare")
// character가 신스 파라미터 변형을 결정. gmNote: MIDI 내보내기용 GM 퍼커션 노트(채널 10)
export const DRUM_PIECES = {
  "kick": 36, "snare": 38, "rim": 37, "clap": 39, "hhc": 42, "hho": 46,
  "tom-l": 43, "tom-m": 47, "tom-h": 50, "crash": 49, "ride": 51, "shaker": 70
};

export const DRUM_KITS = {
  "lofi-kit": { name: "Lo-fi Kit", desc: "빈티지하게 뭉개진 드럼 — 로파이·시티팝", character: "lofi" },
  "acoustic-kit": { name: "Acoustic Kit", desc: "자연스러운 어쿠스틱 드럼 — 밴드 사운드", character: "acoustic" },
  "e808-kit": { name: "808 Kit", desc: "긴 서브 킥의 전자 드럼 — 힙합·EDM", character: "e808" }
};

// 선택적 출발 템플릿 — new_song(template)이 만드는 제품 스케치. 장르 정의가 아니며 노트는 비어 있다.
export const TEMPLATES = {
  "citypop": {
    name: "시티팝 출발 스케치", desc: "한 가지 band/electronic 방향: 96bpm · 어쿠스틱 드럼 + 핑거 베이스 + FM 전기피아노 + 에어리 리드", bpm: 96,
    tracks: [
      { name: "Drums", preset: "acoustic-kit", volume: 0.9, pan: 0 },
      { name: "Bass", preset: "finger-bass", volume: 0.85, pan: 0 },
      { name: "E.Piano", preset: "fm-epiano", volume: 0.8, pan: -0.15 },
      { name: "Lead", preset: "airy-synth", volume: 0.7, pan: 0.1 }
    ]
  },
  "lofi": {
    name: "웜 루프 출발 스케치", desc: "한 가지 lo-fi-adjacent 방향: 72bpm · 로파이 드럼 + 핑거 베이스 + 우울리 + 오르골", bpm: 72,
    tracks: [
      { name: "Drums", preset: "lofi-kit", volume: 0.85, pan: 0 },
      { name: "Bass", preset: "finger-bass", volume: 0.8, pan: 0 },
      { name: "Keys", preset: "wurli", volume: 0.8, pan: -0.1 },
      { name: "Melody", preset: "music-box", volume: 0.6, pan: 0.15 }
    ]
  },
  "ballad": {
    name: "발라드 출발 스케치", desc: "한 가지 slow narrative 방향: 68bpm · 소프트 피아노 + 스트링 패드 + 어쿠스틱 드럼", bpm: 68,
    tracks: [
      { name: "Piano", preset: "soft-piano", volume: 0.9, pan: 0 },
      { name: "Strings", preset: "strings", volume: 0.6, pan: 0 },
      { name: "Bass", preset: "finger-bass", volume: 0.75, pan: 0 },
      { name: "Drums", preset: "acoustic-kit", volume: 0.7, pan: 0 }
    ]
  },
  "bossa": {
    name: "어쿠스틱 2-feel 출발 스케치", desc: "한 가지 bossa-adjacent 방향: 128bpm(하프타임 느낌) · 어쿠스틱 드럼 + 소프트 피아노 + 플럭", bpm: 128,
    tracks: [
      { name: "Drums", preset: "acoustic-kit", volume: 0.75, pan: 0 },
      { name: "Bass", preset: "finger-bass", volume: 0.8, pan: 0 },
      { name: "Piano", preset: "soft-piano", volume: 0.8, pan: -0.1 },
      { name: "Guitar", preset: "pluck", volume: 0.65, pan: 0.2 }
    ]
  },
  "edm": {
    name: "4-on-floor 신스 출발 스케치", desc: "넓은 EDM 전체가 아닌 한 가지 dance-electronic 방향: 124bpm · 808 드럼 + 신스 베이스 + 플럭 코드 + 톱니 리드", bpm: 124,
    tracks: [
      { name: "Drums", preset: "e808-kit", volume: 0.95, pan: 0 },
      { name: "Bass", preset: "synth-bass", volume: 0.9, pan: 0 },
      { name: "Chords", preset: "pluck", volume: 0.7, pan: -0.1 },
      { name: "Lead", preset: "saw-lead", volume: 0.75, pan: 0.1 }
    ]
  },
  "chiptune": {
    name: "사각파 하이브리드 출발 스케치", desc: "한 가지 chip-inspired 방향: 140bpm · 사각파 리드 + 베이스 + 플럭 화성, 타악기는 곡에 맞게 별도 선택", bpm: 140,
    tracks: [
      { name: "Bass", preset: "square-lead", volume: 0.7, pan: 0 },
      { name: "Lead", preset: "square-lead", volume: 0.7, pan: 0.05 },
      { name: "Harmony", preset: "pluck", volume: 0.55, pan: -0.15 }
    ]
  }
};

// ---------- 샘플(SoundFont) 기반 프리셋 ----------
// 신스 프리셋과 같은 자리에서 골라 쓰는 id들 — 렌더만 ~/.aria/soundfonts/default.sf2의 샘플로 한다.
// gm: 사운드폰트에서 찾을 GM 프로그램 번호(MIDI 내보내기에도 그대로 쓰임)
export const SF_PRESETS = {
  // font: 이 프리셋이 우선 사용할 사운드폰트 파일(~/.aria/soundfonts/ 기준). 없으면 default.sf2로 폴백
  "sf-piano": { name: "Grand Piano", desc: "그랜드 피아노 — Salamander(야마하 C5, 벨로시티 16층) 우선 사용", gm: 0, gain: 1.0, reverb: 0.25, release: 0.4, font: "salamander.sf2" },
  "sf-epiano": { name: "Tine E.Piano", desc: "틴 전기피아노 샘플 — 신스 FM보다 진짜에 가까운 질감", gm: 4, gain: 1.0, reverb: 0.22, release: 0.3 },
  "sf-vibes": { name: "Vibraphone", desc: "비브라폰 샘플 — 재즈·라운지", gm: 11, gain: 1.0, reverb: 0.3, release: 0.8 },
  "sf-organ": { name: "Drawbar Organ", desc: "드로우바 오르간 샘플", gm: 16, gain: 0.9, reverb: 0.2, release: 0.15 },
  "sf-nylon": { name: "Nylon Guitar", desc: "나일론 기타 샘플 — 보사노바·발라드 아르페지오", gm: 24, gain: 1.0, reverb: 0.25, release: 0.3 },
  "sf-steel": { name: "Steel Guitar", desc: "스틸 어쿠스틱 기타 샘플 — 포크·팝 스트로크", gm: 25, gain: 1.0, reverb: 0.22, release: 0.3 },
  "sf-bass": { name: "Finger Bass", desc: "핑거 일렉 베이스 실제 샘플", gm: 33, gain: 1.0, reverb: 0.05, release: 0.15 },
  "sf-strings": { name: "String Ensemble", desc: "현악 앙상블 샘플 — 신스 패드보다 진짜 현의 결", gm: 48, gain: 0.9, reverb: 0.4, release: 0.6 },
  // 필하모니아 오케스트라 독주 현악 — 실제 연주자 녹음, 셈여림별(pp~ff) 진짜 음색 변화
  "sf-violin": { name: "Violin (Phil.)", desc: "독주 바이올린 — 필하모니아 연주자 녹음, 셈여림 레이어", gm: 40, gain: 1.15, reverb: 0.3, release: 0.5, font: "philharmonia.sf2" },
  "sf-viola": { name: "Viola (Phil.)", desc: "독주 비올라 — 바이올린보다 어둡고 따뜻한 중음역", gm: 41, gain: 1.25, reverb: 0.3, release: 0.5, font: "philharmonia.sf2" },
  "sf-cello": { name: "Cello (Phil.)", desc: "독주 첼로 — 노래하는 저중음, 솔로 선율에 최적", gm: 42, gain: 1.1, reverb: 0.3, release: 0.5, font: "philharmonia.sf2" },
  "sf-contrabass": { name: "Contrabass (Phil.)", desc: "독주 콘트라베이스 — 묵직한 최저음역 활", gm: 43, gain: 0.7, reverb: 0.25, release: 0.5, font: "philharmonia.sf2" },
  "sf-violin-pizz": { name: "Violin Pizz (Phil.)", desc: "바이올린 피치카토 — 뜯는 소리, 경쾌한 반주·리듬", gm: 44, gain: 1.1, reverb: 0.25, release: 1.2, font: "philharmonia.sf2" },
  "sf-viola-pizz": { name: "Viola Pizz (Phil.)", desc: "비올라 피치카토 — 중음역 뜯는 소리", gm: 45, gain: 1.15, reverb: 0.25, release: 1.2, font: "philharmonia.sf2" },
  "sf-contrabass-pizz": { name: "Contrabass Pizz (Phil.)", desc: "콘트라베이스 피치카토 — 재즈·탱고 워킹 베이스", gm: 46, gain: 1.0, reverb: 0.15, release: 1.2, font: "philharmonia.sf2" },
  "sf-violin-sord": { name: "Violin Sordino (Phil.)", desc: "약음기 바이올린 — 안개 낀 여린 음색, 서정 악절", gm: 48, gain: 1.2, reverb: 0.35, release: 0.5, font: "philharmonia.sf2" },
  "sf-choir": { name: "Choir Aahs", desc: "합창 아~ 샘플 — 영화적 배경", gm: 52, gain: 0.9, reverb: 0.45, release: 0.6 },
  "sf-brass": { name: "Brass Section", desc: "브라스 섹션 샘플 — 펑크·소울 스탭", gm: 61, gain: 0.95, reverb: 0.2, release: 0.2 },
  "sf-sax": { name: "Alto Sax (Phil.)", desc: "알토 색소폰 — 필하모니아 연주자 녹음, 재즈 멜로디", gm: 65, gain: 1.0, reverb: 0.25, release: 0.25, font: "phil-winds.sf2" },
  "sf-flute": { name: "Flute (Phil.)", desc: "플루트 — 필하모니아 연주자 녹음, 가볍고 맑은 고음", gm: 73, gain: 0.95, reverb: 0.3, release: 0.3, font: "phil-winds.sf2" },
  "sf-oboe": { name: "Oboe (Phil.)", desc: "오보에 — 콧소리 섞인 서정적 목관, 솔로 선율", gm: 68, gain: 0.95, reverb: 0.3, release: 0.3, font: "phil-winds.sf2" },
  "sf-english-horn": { name: "English Horn (Phil.)", desc: "코랑글레 — 오보에보다 어둡고 애수 어린 중음", gm: 69, gain: 1.0, reverb: 0.3, release: 0.3, font: "phil-winds.sf2" },
  "sf-clarinet": { name: "Clarinet (Phil.)", desc: "클라리넷 — 매끄럽고 따뜻한 목관 전음역", gm: 71, gain: 0.95, reverb: 0.28, release: 0.3, font: "phil-winds.sf2" },
  "sf-bass-clarinet": { name: "Bass Clarinet (Phil.)", desc: "베이스 클라리넷 — 어둡고 신비한 저음 목관", gm: 72, gain: 1.0, reverb: 0.28, release: 0.35, font: "phil-winds.sf2" },
  "sf-bassoon": { name: "Bassoon (Phil.)", desc: "바순 — 노래하는 목관 저음, 해학·서정 양쪽", gm: 70, gain: 1.0, reverb: 0.28, release: 0.3, font: "phil-winds.sf2" },
  "sf-contrabassoon": { name: "Contrabassoon (Phil.)", desc: "콘트라바순 — 목관 최저음, 으르렁대는 바닥", gm: 74, gain: 1.05, reverb: 0.25, release: 0.35, font: "phil-winds.sf2" },
  "sf-horn": { name: "French Horn (Phil.)", desc: "프렌치 호른 — 필하모니아 녹음, 서사적 콜·온기 있는 중저음", gm: 60, gain: 0.95, reverb: 0.35, release: 0.4, font: "phil-brass.sf2" },
  "sf-trumpet": { name: "Trumpet (Phil.)", desc: "트럼펫 — 찬란한 금관 고음, 팡파르·솔로", gm: 56, gain: 0.9, reverb: 0.3, release: 0.25, font: "phil-brass.sf2" },
  "sf-trombone": { name: "Trombone (Phil.)", desc: "트롬본 — 넓고 당당한 금관 중저음", gm: 57, gain: 0.95, reverb: 0.3, release: 0.3, font: "phil-brass.sf2" },
  "sf-tuba": { name: "Tuba (Phil.)", desc: "튜바 — 금관의 기초 저음, 묵직한 바닥", gm: 58, gain: 1.0, reverb: 0.25, release: 0.35, font: "phil-brass.sf2" },
  "sf-timpani": { name: "Timpani (VSCO)", desc: "팀파니 — 실녹음 다이내믹 3층, 오케스트라의 천둥, F#1~D#2 부근", gm: 47, gain: 1.0, reverb: 0.35, release: 0.8, font: "vsco.sf2" },
  "sf-harp": { name: "Harp (VSCO)", desc: "하프 — 아르페지오·글리산도, 서정적 색채", gm: 46, gain: 1.0, reverb: 0.35, release: 0.8, font: "vsco.sf2" },
  "sf-glockenspiel": { name: "Glockenspiel (VSCO)", desc: "글로켄슈필 — 반짝이는 금속 종소리 고음", gm: 9, gain: 0.9, reverb: 0.3, release: 0.6, font: "vsco.sf2" },
  "sf-marimba": { name: "Marimba (VSCO)", desc: "마림바 — 둥글고 따뜻한 나무 말렛", gm: 12, gain: 1.0, reverb: 0.25, release: 0.5, font: "vsco.sf2" },
  "sf-xylophone": { name: "Xylophone (VSCO)", desc: "실로폰 — 마르고 또렷한 나무 말렛 고음", gm: 13, gain: 0.95, reverb: 0.25, release: 0.4, font: "vsco.sf2" },
  "sf-cello-pizz": { name: "Cello Pizz (VSCO)", desc: "첼로 섹션 피치카토 — 통통 튀는 저음 반주", gm: 45, gain: 1.05, reverb: 0.25, release: 1.0, font: "vsco.sf2" },
  "sf-bandoneon": { name: "Tango Accordion", desc: "탱고 아코디언(반도네온) 샘플 — 탱고·뮈제트의 심장", gm: 23, gain: 0.95, reverb: 0.25, release: 0.2 }
};
// 오케스트라 타악 전용 피스 (필하모니아 녹음) — sf-orch-kit에서만 유효
export const ORCH_PIECES = {
  kick: 36, snare: 38, "tom-l": 43, "tom-m": 47, "tom-h": 50, crash: 49, ride: 51,
  tamtam: 52, tambourine: 54, cowbell: 56, agogo: 67, cabasa: 69, guiro: 73,
  woodblock: 76, triangle: 81, sleigh: 83, castanets: 85
};

// 샘플 드럼 킷 — pitch는 기존 피스 이름 그대로, GM 노트로 매핑되어 사운드폰트 킷을 친다
// pieces: 킷 전용 피스 어휘(없으면 DRUM_PIECES). 검증·렌더·MIDI 내보내기가 이 맵을 따른다.
export const SF_DRUM_KITS = {
  // release: 렌더 꼬리 계산용 — 크래시·오픈햇 잔향 실측(-60dB ≈ 3.1초)을 담는 값
  "sf-kit": { name: "Studio Kit", desc: "실제 드럼 녹음 샘플 킷 (GM Standard)", bank: 128, program: 0, release: 3.0 },
  "sf-band-kit": { name: "Band Kit (Salamander)", desc: "어쿠스틱 밴드 드럼 실녹음 — 팝·록·발라드, 벨로시티 다층 펀치", bank: 128, program: 0, release: 4.2, font: "salamander-kit.sf2", velRange: 0.7 },
  "sf-orch-kit": {
    name: "Orch Percussion", desc: "오케스트라 타악 — 필하모니아 녹음. 피스: kick(큰북)·snare·tom-l/m/h·crash(합주 심벌)·ride(서스펜디드)·tamtam·triangle·tambourine·castanets·woodblock·sleigh·cowbell·agogo·cabasa·guiro",
    bank: 128, program: 0, release: 6.0, font: "phil-perc.sf2", pieces: ORCH_PIECES, velRange: 0.9
  }
};

// 킷의 피스 어휘 — 킷 전용 맵이 있으면 그것, 없으면 공통 DRUM_PIECES
export function drumPieces(id) { return SF_DRUM_KITS[id]?.pieces ?? DRUM_PIECES; }

export function isSfPreset(id) { return Object.hasOwn(SF_PRESETS, id); }
export function isSfDrumKit(id) { return Object.hasOwn(SF_DRUM_KITS, id); }
export function isDrumPreset(id) { return Object.hasOwn(DRUM_KITS, id) || isSfDrumKit(id); }
export function presetExists(id) {
  return Object.hasOwn(PRESETS, id) || Object.hasOwn(DRUM_KITS, id) || isSfPreset(id) || isSfDrumKit(id);
}
export function presetLabel(id) {
  return PRESETS[id]?.name ?? DRUM_KITS[id]?.name ?? SF_PRESETS[id]?.name ?? SF_DRUM_KITS[id]?.name ?? id;
}
// MIDI 내보내기용 GM 프로그램 번호
export function presetGm(id) { return PRESETS[id]?.gm ?? SF_PRESETS[id]?.gm ?? 0; }

// aria — 조성(key) 추정과 조성에서 벗어난 음 찾기
// 피아노롤이 "이 음은 조에 없다"를 표시하려면 (1) 곡의 조가 무엇이고 (2) 어떤 노트가 거기서
// 벗어났는지가 필요하다. 전역 상태 없이 곡 객체만 읽는 순수 함수들이다.
import { isDrumPreset } from "./presets.js";
import { noteToMidi } from "./song.js";

// ---------- 조성 프로파일 ----------
// 12음 각각이 그 조에서 얼마나 오래 울리는지의 기준 분포. 곡의 실제 분포와 상관계수를 재서
// 가장 닮은 조를 고르는 것이 Krumhansl-Schmuckler 방식이다.
export const PROFILES = Object.freeze({
  // 기본값. 원조 Krumhansl-Kessler(1982) 탐사음 실험값 — Krumhansl-Schmuckler 알고리즘의 그 프로파일.
  // 이 앱에는 이쪽이 맞다: 단조 프로파일이 자연 7음(3.34)과 올린 7음(3.17)을 거의 같게 보므로
  // 자연단음계로 쓴 곡과 화성단음계로 쓴 곡을 모두 받아 준다. 대중음악·AI가 쓰는 단조는
  // 대부분 이끔음 없는 자연단조라 이 성질이 결정적이다(검증 10/10, temperley 8/10).
  kk: {
    label: "Krumhansl-Kessler (1982)",
    major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
  },
  // Temperley(2001)가 Kostka-Payne 화성학 코퍼스의 실제 악보 통계로 다시 뽑은 프로파일.
  // 단조의 올린 7음(4.0)이 자연 7음(2.0)보다 훨씬 크다 — 이끔음을 거의 반드시 쓰는 고전 화성에는
  // 잘 맞지만, 이끔음 없는 Am-F-G-Am 같은 진행은 나란한 장조로 오판한다. 고전풍 곡에만 쓸 것.
  temperley: {
    label: "Temperley / Kostka-Payne (2001)",
    major: [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
    minor: [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0]
  }
});

// 으뜸음에서 반음 몇 칸 위가 음계음인가
const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
// 이론상 정상인 변화음 — 단조는 7음을 올리면 화성단음계(이끔음), 6·7음을 함께 올리면 선율단음계다.
// 실제 악보에서 이 둘은 예외가 아니라 규칙이라 절대 "벗어난 음"으로 세지 않는다.
const ALTERED = { major: [], minor: [9, 11] };
// 흔한 차용음 — 이론상 조성 밖이지만 대중음악에서 색채로 자주 쓰인다.
//   장조: b7(믹솔리디안·bVII) · b3(블루노트·bIII) · b6(iv·bVI 차용) · #4(부속7화음 V/V의 3음)
//   단조: 장3도(피카르디 3도·V/iv의 3음) · #4(V/V의 3음)
// 이것들을 무조건 표시하면 멀쩡한 곡이 온통 빨갛게 되고, 무조건 봐주면 진짜 실수를 놓친다.
// 그래서 "자주 나오면 의도, 한 번 스치면 실수"로 가른다(recurring 참고).
const BORROWED = { major: [10, 3, 8, 6], minor: [4, 6] };

// 조표 관례에 맞춘 표기 — 장조는 Gb 대신 F#처럼 흔히 쓰는 쪽 하나만 고른다
const MAJOR_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

// confidence를 확률처럼 만들 때의 온도 — 상관계수 차가 이 정도(0.06)면 2등이 1등의 1/e쯤 된다.
// 실제 곡들로 재 보니 뚜렷한 조성은 0.7~0.95, 나란한조/딸림조와 팽팽한 곡은 0.4~0.6이 나온다.
const SOFTMAX_T = 0.06;
// 이 아래면 "2등도 만만치 않다"는 뜻이라 화면에 그대로 믿고 표시하면 안 된다
const SHAKY = 0.5;
// 서로 다른 음이 이만큼은 나와야 조를 좁힐 수 있다 — 5음(펜타토닉)이면 충분하다고 본다
const COVER_FULL = 5;
// 1등 상관계수가 이보다 낮으면 어떤 조에도 안 맞는다는 뜻(무조·반음계)
const ATONAL = 0.35;

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

// 노트 하나를 가리키는 문자열 키 — "마디:박:음이름" (예: "3:1.5:C4").
// 화면은 노트마다 이 문자열을 만들어 Set.has()로 조회한다(노트당 해시 한 번).
// 길이(dur)는 일부러 넣지 않는다 — 같은 자리 같은 음이면 길이와 무관하게 판정이 같고,
// 키가 짧을수록 화면 쪽 비용도 준다. 박은 부동소수 찌꺼기(0.30000000000000004)를 없애려고
// 소수점 4자리에서 자른다. 화면에서도 같은 식으로 만들어야 맞는다.
export function noteKey(note) {
  const beat = +(Number(note.beat) || 0).toFixed(4);
  return `${note.bar}:${beat}:${note.pitch}`;
}

// 조의 음계음·정상 변화음을 절대 음높이 클래스(C=0)로 — 피아노롤이 행 배경을 칠하는 데 쓴다
export function scalePitchClasses(key) {
  if (!key || key.tonic === null || key.tonic === undefined) return { scale: [], altered: [] };
  if (!Object.hasOwn(SCALE, key.mode))
    throw new Error(`scalePitchClasses의 mode가 이상합니다 — "major" 또는 "minor"여야 합니다 (받은 값: ${JSON.stringify(key.mode)})`);
  const t = key.tonic;
  return {
    scale: SCALE[key.mode].map(i => (t + i) % 12),
    altered: ALTERED[key.mode].map(i => (t + i) % 12)
  };
}

// ---------- 무게 재기 ----------
// 노트를 "울린 시간"으로 잰다. 개수로 세면 16분음표로 스쳐 가는 경과음이 온음표 화음과
// 같은 표를 행사해 조성이 흔들린다. vel은 일부러 빼 뒀다 — 여린 음도 조성을 만든다.
function weighNotes(song, { durCap, only }) {
  const hist = new Array(12).fill(0);
  const bars = new Array(12).fill(null); // 반음계음이 몇 개의 마디에 흩어져 있는지(차용 판정용)
  let count = 0, total = 0;
  for (const track of song.tracks) {
    if (isDrumPreset(track.preset)) continue; // 드럼은 pitch가 피스 이름이라 조성과 무관
    if (only && !only.has(String(track.name).toLowerCase())) continue;
    for (const n of track.notes ?? []) {
      const midi = noteToMidi(n.pitch);
      if (midi === null) continue; // 검증을 안 거친 곡 객체가 와도 죽지 않게
      const dur = Number(n.dur);
      if (!Number.isFinite(dur) || dur <= 0) continue;
      // 몇 마디씩 끌리는 패드 한 음이 곡 전체를 대표해 버리지 않도록 상한을 둔다
      const w = Math.min(dur, durCap);
      const pc = midi % 12;
      hist[pc] += w;
      total += w;
      count++;
      (bars[pc] ??= new Set()).add(n.bar);
    }
  }
  return { hist, bars, count, total, distinct: hist.reduce((a, w) => a + (w > 0 ? 1 : 0), 0) };
}

function pearson(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  // 12음이 완전히 고르면 분산이 0이라 상관을 정의할 수 없다 — 조성 없음(0)으로 본다
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

// 1등이 24개 후보 전체에서 차지하는 몫(볼츠만 분포) — 0~1이라 그대로 확신도로 쓸 수 있다.
// 후보가 딱 둘 팽팽하면 0.5, 하나만 튀면 1에 가깝고, 전부 같으면 1/24가 된다.
function share(cands, top) {
  let sum = 0;
  for (const c of cands) sum += Math.exp((c.score - top) / SOFTMAX_T);
  return 1 / sum;
}

function label(tonic, mode) {
  const n = mode === "major" ? MAJOR_NAMES[tonic] : MINOR_NAMES[tonic];
  // 한국어 정식 조성명은 "올림바단조"지만, 음악을 모르는 사용자에게는 암호에 가깝고
  // 피아노롤이 음이름을 F#4처럼 표시하므로 화면과 글자가 맞아떨어지는 쪽을 골랐다.
  return { name: `${n} ${mode}`, ko: `${n} ${mode === "major" ? "장조" : "단조"}` };
}

// 판정 불가 — tonic이 null인 것으로 알아본다. name·ko에는 그대로 화면에 찍어도 되는 말을 넣어 둔다.
const unknownKey = (warning = "음높이 있는 노트가 없습니다 — 드럼만 있는 곡은 조성을 판정할 수 없습니다") => ({
  tonic: null, mode: null, name: "unknown", ko: "조성 불명",
  confidence: 0, profile: new Array(12).fill(0), profileName: null,
  score: 0, alt: null, notes: 0, weight: 0, warning
});

/**
 * 곡 전체에서 조성 하나를 추정한다.
 * opts: profile("kk"|"temperley") · minNotes(이보다 적으면 confidence를 깎는다) ·
 *       durCap(한 노트가 행사할 수 있는 무게 상한, 박) · tracks(이 트랙 이름들만 본다)
 * tonic이 null이면 판정 불가다.
 */
export function detectKey(song, opts = {}) {
  const { profile = "kk", minNotes = 12, durCap = 8, tracks = null } = opts;
  if (!song || !Array.isArray(song.tracks))
    throw new Error("detectKey에는 곡 객체가 필요합니다 — get_song이 돌려주는 {tracks:[...]} 형태를 넘기세요");
  const prof = Object.hasOwn(PROFILES, profile) ? PROFILES[profile] : null;
  if (!prof)
    throw new Error(`알 수 없는 조성 프로파일 "${profile}" — 사용 가능: ${Object.keys(PROFILES).join(", ")}`);

  const only = tracks ? new Set(tracks.map(t => String(t).toLowerCase())) : null;
  // 필터에 오타가 나면 "드럼만 있는 곡"이라는 엉뚱한 안내가 나가던 자리 — 두 경우를 갈라 준다
  if (only && !song.tracks.some(t => only.has(String(t.name).toLowerCase())))
    return unknownKey(`지정한 트랙(${tracks.join(", ")})이 곡에 없습니다 — 현재 트랙: ${song.tracks.map(t => t.name).join(", ") || "(없음)"}`);
  const { hist, count, total, distinct } = weighNotes(song, { durCap, only });
  if (count === 0) return unknownKey();

  const cands = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ["major", "minor"]) {
      const p = prof[mode];
      // 프로파일을 으뜸음 자리로 돌려서 곡의 분포와 비교
      const rotated = new Array(12);
      for (let pc = 0; pc < 12; pc++) rotated[pc] = p[(pc - tonic + 12) % 12];
      cands.push({ tonic, mode, score: pearson(hist, rotated) });
    }
  }
  cands.sort((a, b) => b.score - a.score);

  // 나란한조(C장조 ↔ A단조)는 구성음이 같아 헷갈리기 쉽지만, 여기서 따로 손대지 않는다.
  // KK 프로파일이 으뜸음(6.35/6.33)과 딸림음(5.19/4.75)에 몰아 준 비중이 곧 "어디에 머무느냐"를
  // 재는 자라서, 울린 시간으로 무게를 잡으면 대개 상관계수만으로 갈린다.
  // (으뜸화음 무게로 동점을 가르는 규칙을 얹어 무작위 288곡에 대 봤지만 79.5%→77.8~80.6%로
  //  잡음 수준이었다. 값을 못 하는 특별 규칙은 두지 않는다.)
  const [best, second] = cands;

  // 세 가지를 곱한다.
  //  ① 1등이 프로파일에 얼마나 맞는가 — 무조면 상관계수가 0 근처라 여기서 떨어진다
  //  ② 24개 후보 중 1등이 차지하는 몫 — 2등만 보면 3~5등이 다닥다닥 붙은 판을 놓친다
  //  ③ 쓰인 음이 몇 종류인가 — C와 G만 나오는 곡은 상관계수가 아무리 높아도 조를 못 좁힌다
  const cover = clamp01((distinct - 2) / (COVER_FULL - 2));
  let confidence = clamp01(best.score) * share(cands, best.score) * cover;
  let warning = null;
  if (count < minNotes) {
    // 노트가 몇 개 없으면 상관계수가 아무리 높아도 우연이다 — 상한을 눌러 둔다
    confidence = clamp01(confidence * (count / minNotes)) * 0.25;
    warning = `노트가 ${count}개뿐이라 조성 판정을 믿을 수 없습니다 — ${minNotes}개 이상 있어야 의미가 있습니다`;
  } else if (distinct < COVER_FULL) {
    warning = `서로 다른 음이 ${distinct}종류뿐이라 조를 좁힐 수 없습니다 — 음계가 더 드러나야 판정이 의미 있습니다`;
  } else if (best.score < ATONAL) {
    warning = "어떤 조에도 잘 맞지 않습니다 — 12음이 고르게 쓰였거나 조성 음악이 아닙니다";
  } else if (confidence < SHAKY) {
    warning = `조성이 뚜렷하지 않습니다 — ${label(second.tonic, second.mode).ko}일 가능성도 비슷합니다`;
  }

  const named = label(best.tonic, best.mode);
  return {
    tonic: best.tonic, mode: best.mode, ...named,
    confidence: Math.round(confidence * 1000) / 1000,
    // 곡의 실제 음 분포(합이 1). 화면이 어떤 음을 얼마나 썼는지 그대로 보여줄 수 있다.
    profile: hist.map(w => (total > 0 ? w / total : 0)),
    profileName: prof.label,
    score: Math.round(best.score * 1000) / 1000,
    alt: { tonic: second.tonic, mode: second.mode, ...label(second.tonic, second.mode),
      score: Math.round(second.score * 1000) / 1000 },
    notes: count, weight: total, warning
  };
}

/**
 * 조성에서 벗어난 노트를 트랙 이름 → Set(노트 키)로 모은다. 벗어난 음이 하나도 없는 트랙은
 * 아예 넣지 않으므로 화면은 `map.get(name)?.has(noteKey(n))`로 조회하면 된다.
 * opts: strict(차용음도 전부 표시) · minConfidence(이보다 낮은 조성이면 빈 Map) ·
 *       borrowShare·borrowBars(차용으로 봐줄 재등장 기준) · tracks(이 트랙들만) · durCap
 */
export function outOfKey(song, key, opts = {}) {
  const out = new Map();
  if (!song || !Array.isArray(song.tracks))
    throw new Error("outOfKey에는 곡 객체가 필요합니다 — get_song이 돌려주는 {tracks:[...]} 형태를 넘기세요");
  // 판정 불가인 조성으로는 아무것도 표시하지 않는다 — 근거 없는 빨간 표시가 제일 나쁘다
  if (!key || key.tonic === null || key.tonic === undefined) return out;
  if (!Number.isInteger(key.tonic) || key.tonic < 0 || key.tonic > 11 || !Object.hasOwn(SCALE, key.mode))
    throw new Error("outOfKey의 조성 인자가 이상합니다 — detectKey가 돌려준 객체를 그대로 넘기세요");

  const { strict = false, minConfidence = 0, borrowShare = 0.02, borrowBars = 3,
    durCap = 8, tracks = null } = opts;
  if ((key.confidence ?? 0) < minConfidence) return out;

  const only = tracks ? new Set(tracks.map(t => String(t).toLowerCase())) : null;
  const { hist, bars, total } = weighNotes(song, { durCap, only });

  // 허용 음높이 클래스를 미리 12칸 배열로 펴 둔다 — 노트마다 하는 일은 배열 조회 한 번뿐이다
  const allowed = new Array(12).fill(false);
  for (const i of SCALE[key.mode]) allowed[(key.tonic + i) % 12] = true;
  for (const i of ALTERED[key.mode]) allowed[(key.tonic + i) % 12] = true;
  if (!strict) {
    for (const i of BORROWED[key.mode]) {
      const pc = (key.tonic + i) % 12;
      // 여러 마디에 걸쳐 되풀이되거나 곡에서 차지하는 시간이 무시할 수 없으면 의도된 색채로 본다.
      // 한 번 스치고 마는 반음계음만 실수로 남긴다.
      const recurring = (bars[pc]?.size ?? 0) >= borrowBars || (total > 0 && hist[pc] / total >= borrowShare);
      if (recurring) allowed[pc] = true;
    }
  }

  for (const track of song.tracks) {
    if (isDrumPreset(track.preset)) continue;
    if (only && !only.has(String(track.name).toLowerCase())) continue;
    let set = null;
    for (const n of track.notes ?? []) {
      const midi = noteToMidi(n.pitch);
      if (midi === null || allowed[midi % 12]) continue;
      (set ??= new Set()).add(noteKey(n));
    }
    if (set) out.set(track.name, set);
  }
  return out;
}

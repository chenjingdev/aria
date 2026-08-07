// aria — 트랙 3밴드 EQ: 저역 셸빙 · 중역 피킹 · 고역 셸빙
// "이 악기가 답답하다 / 쨍하다"를 트랙 단위로 고치는 채널 스트립. 렌더된 트랙 버퍼를 제자리에서 고친다.
// 전역 상태 없음 — 필터 상태는 호출 하나 안에서만 살아 있으므로 같은 입력이면 항상 같은 출력이다.

// 밴드 주파수. 셸빙의 f0는 RBJ 정의상 "지정한 이득의 절반이 걸리는" 지점이고, 이득 전량은 그 바깥(DC/나이키스트)에서 난다.
// 200Hz = 베이스·킥의 무게가 사는 곳, 1kHz = 답답함(박스톤)이 뭉치는 중역, 4kHz = 자음·심벌의 쨍함.
export const EQ_FREQ = { low: 200, mid: 1000, high: 4000 };
// 중역 벨 폭 — Q 0.9는 약 1.7옥타브. 더 좁으면 특정 음만 튀고, 더 넓으면 톤 전체가 같이 끌려간다.
export const EQ_MID_Q = 0.9;
// 셸프 기울기 S=1 ⇔ Q=1/√2 — 통과대역에 오버슈트(코너 너머의 딥/피크)가 생기지 않는 최대 평탄 기울기.
const SHELF_S = 1;
// ±12dB를 넘기면 EQ가 아니라 음색 파괴다. 이 상한 덕에 극값에서도 극점이 단위원 안에 머문다.
export const EQ_DB_LIMIT = 12;
export const EQ_KEYS = ["low", "mid", "high"];

// 항등 섹션 — 0dB 밴드에 꽂으면 y=b0·x=x가 비트 단위로 성립해 "0이면 통과"가 계수 차원에서 보장된다.
const IDENT = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };

// RBJ Audio EQ Cookbook(Robert Bristow-Johnson)의 lowShelf/peakingEQ/highShelf 공식을 그대로 옮기고
// a0으로 미리 정규화한다 — 샘플 루프에서 나눗셈을 없애려고 계수 단계에서 한 번만 나눈다.
function bandCoefs(kind, f0, dB, sr) {
  const A = Math.pow(10, dB / 40); // 셸빙·피킹은 진폭이 아니라 √이득으로 들어간다(쿡북 정의)
  // 나이키스트에 붙은 코너는 계수가 퇴화한다(cos w0 → -1) — 낮은 샘플레이트에서도 안전하도록 0.45·sr로 묶는다
  const w = 2 * Math.PI * Math.min(f0, sr * 0.45) / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const alpha = kind === "mid"
    ? sw / (2 * EQ_MID_Q)
    : (sw / 2) * Math.sqrt((A + 1 / A) * (1 / SHELF_S - 1) + 2);
  const sa = 2 * Math.sqrt(A) * alpha;
  let b0, b1, b2, a0, a1, a2;
  if (kind === "mid") {
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else if (kind === "low") {
    b0 = A * ((A + 1) - (A - 1) * cw + sa);
    b1 = 2 * A * ((A - 1) - (A + 1) * cw);
    b2 = A * ((A + 1) - (A - 1) * cw - sa);
    a0 = (A + 1) + (A - 1) * cw + sa;
    a1 = -2 * ((A - 1) + (A + 1) * cw);
    a2 = (A + 1) + (A - 1) * cw - sa;
  } else {
    b0 = A * ((A + 1) + (A - 1) * cw + sa);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - sa);
    a0 = (A + 1) - (A - 1) * cw + sa;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - sa;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// 밴드 하나를 검증해 dB로 — 값이 없으면 0(통과). 조용히 무시하면 오타 난 EQ가 아무 일도 안 한 채 넘어간다.
function bandDb(eq, key) {
  if (eq === undefined || eq === null) return 0;
  if (typeof eq !== "object" || Array.isArray(eq))
    throw new Error(`EQ 설정은 {low, mid, high} 객체여야 합니다 (각 값은 dB) — 받은 값: ${JSON.stringify(eq)}`);
  const v = eq[key];
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isFinite(v) || v < -EQ_DB_LIMIT || v > EQ_DB_LIMIT)
    throw new Error(`EQ의 ${key}는 -${EQ_DB_LIMIT}~+${EQ_DB_LIMIT} 사이 숫자(dB)여야 합니다 — 0이면 그 밴드는 통과입니다 (받은 값: ${JSON.stringify(v)})`);
  return v;
}

// 세 밴드 중 하나라도 0이 아닌가. 호출부가 "이 트랙만 따로 버퍼에 모을지"를 정하는 데 쓴다 —
// 지금 곡의 트랙 대부분은 여기서 false가 나와 EQ 경로 자체를 타지 않는다. (값이 이상하면 여기서 바로 throw)
export function eqActive(eq) {
  // 단락평가를 쓰면 앞 밴드가 0이 아닌 순간 뒤 밴드는 검증조차 안 된다 —
  // 값 순서에 따라 어떤 잘못된 값은 잡히고 어떤 건 렌더 한참 뒤에 터졌다. 셋 다 먼저 읽는다
  const low = bandDb(eq, "low"), mid = bandDb(eq, "mid"), high = bandDb(eq, "high");
  return low !== 0 || mid !== 0 || high !== 0;
}

// 트랙 버퍼(모노 채널 하나)에 3밴드 EQ를 걸어 같은 버퍼를 돌려준다. buf는 제자리에서 바뀐다.
// 스테레오는 좌·우를 따로 부르면 된다(채널마다 상태가 독립이라야 위상이 어긋나지 않는다).
export function eq3(buf, sr, eq) {
  if (!(buf instanceof Float32Array))
    throw new Error(`eq3의 buf는 Float32Array여야 합니다 — 트랙 렌더 결과 버퍼를 그대로 넘기세요 (받은 값: ${buf === null ? "null" : typeof buf})`);
  if (typeof sr !== "number" || !Number.isFinite(sr) || sr <= 0)
    throw new Error(`eq3의 sr(샘플레이트)은 0보다 큰 숫자여야 합니다 — 렌더에 쓴 sr을 그대로 넘기세요 (받은 값: ${JSON.stringify(sr)})`);
  const low = bandDb(eq, "low"), mid = bandDb(eq, "mid"), high = bandDb(eq, "high");
  // 빠른 경로 — 세 밴드가 모두 0이면 샘플을 하나도 건드리지 않는다. 곡 대부분이 이 경우다.
  if (low === 0 && mid === 0 && high === 0) return buf;

  const s0 = low !== 0 ? bandCoefs("low", EQ_FREQ.low, low, sr) : IDENT;
  const s1 = mid !== 0 ? bandCoefs("mid", EQ_FREQ.mid, mid, sr) : IDENT;
  const s2 = high !== 0 ? bandCoefs("high", EQ_FREQ.high, high, sr) : IDENT;

  // 세 섹션을 한 번의 패스에서 직렬로 통과시킨다(전치형 직접형 II). 계수·상태는 전부 지역 스칼라라
  // 샘플당 할당이 없다. 섹션마다 버퍼를 훑는 3패스보다 실측 2.4배 빠르고, 중간 결과가 float32로
  // 반올림되는 지점도 샘플당 한 번뿐이다. 비활성 밴드는 항등 계수라 결과를 바꾸지 않는다.
  const b00 = s0.b0, b01 = s0.b1, b02 = s0.b2, a01 = s0.a1, a02 = s0.a2;
  const b10 = s1.b0, b11 = s1.b1, b12 = s1.b2, a11 = s1.a1, a12 = s1.a2;
  const b20 = s2.b0, b21 = s2.b1, b22 = s2.b2, a21 = s2.a1, a22 = s2.a2;
  let z01 = 0, z02 = 0, z11 = 0, z12 = 0, z21 = 0, z22 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y0 = b00 * x + z01; z01 = b01 * x - a01 * y0 + z02; z02 = b02 * x - a02 * y0;
    const y1 = b10 * y0 + z11; z11 = b11 * y0 - a11 * y1 + z12; z12 = b12 * y0 - a12 * y1;
    const y2 = b20 * y1 + z21; z21 = b21 * y1 - a21 * y2 + z22; z22 = b22 * y1 - a22 * y2;
    buf[i] = y2;
  }
  return buf;
}

// 이 EQ 설정이 hz에서 실제로 내는 이득(dB). H(e^jw)=(b0+b1z⁻¹+b2z⁻²)/(1+a1z⁻¹+a2z⁻²)를 그대로 계산한다.
// GUI가 EQ 곡선을 그릴 때, 그리고 테스트가 사인파 실측값과 대조할 때 쓴다.
export function eqResponseDb(eq, sr, hz) {
  // eq3와 같은 기준으로 sr·hz도 본다 — 화면에 그릴 곡선이라 NaN이나 "조용히 평평한 오답"이 에러보다 나쁘다
  if (typeof sr !== "number" || !Number.isFinite(sr) || sr <= 0)
    throw new Error(`eqResponseDb의 sr(샘플레이트)은 0보다 큰 숫자여야 합니다 (받은 값: ${JSON.stringify(sr)})`);
  if (typeof hz !== "number" || !Number.isFinite(hz) || hz < 0)
    throw new Error(`eqResponseDb의 hz(주파수)는 0 이상 숫자여야 합니다 (받은 값: ${JSON.stringify(hz)})`);
  const dbs = { low: bandDb(eq, "low"), mid: bandDb(eq, "mid"), high: bandDb(eq, "high") };
  const w = 2 * Math.PI * hz / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let db = 0;
  for (const k of EQ_KEYS) {
    if (dbs[k] === 0) continue;
    const { b0, b1, b2, a1, a2 } = bandCoefs(k, EQ_FREQ[k], dbs[k], sr);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return db;
}

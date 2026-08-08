// aria — 마스터 버스 한 곳: 리버브 리턴 합산 → 글루 컴프 → 룩어헤드 리미터 → 소프트 클립, 그리고 라우드니스 계측.
// 렌더 끝(renderer.js)에 인라인으로 박혀 있던 마스터 단을 순수 함수로 옮긴 것이다.
// 스템 합도 같은 함수를 통과시켜야 "스템을 전부 더한 것 = 완성 믹스"가 성립한다 —
// 예전에는 스템만 비선형(컴프·클립)을 건너뛰어 둘이 구조적으로 어긋났다.

// 기본값은 예전 인라인 체인과 비트 단위로 같은 소리를 낸다.
// 리미터만 기본 꺼짐 — 켜는 순간 소리가 (의도적으로) 달라지므로 부르는 쪽이 명시해야 한다.
export const MASTER_DEFAULTS = Object.freeze({
  wetGain: 0.9,   // 리버브 리턴을 드라이에 더할 때의 비율
  inGain: 0.85,   // 리버브를 더한 뒤의 버스 트림 (컴프 검출기가 보는 레벨)
  makeup: 1.1,    // 컴프 뒤 메이크업
  comp: Object.freeze({ threshold: 0.55, ratio: 2.5, attack: 0.005, release: 0.15 }),
  limiter: Object.freeze({ ceilingDb: -0.3, lookaheadMs: 2, releaseMs: 60 })
});

const err = m => { throw new Error(m); };
const isBuf = a => a instanceof Float32Array || a instanceof Float64Array;
const dbfs = v => (v > 0 ? 20 * Math.log10(v) : -Infinity);

function num(v, def, name, lo, hi) {
  if (v === undefined || v === null) return def;
  // Number() 강제변환을 쓰면 ""·[]·true가 조용히 통과해 마스터 레벨이 말없이 틀어진다 — 숫자만 받는다
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi)
    err(`masterChain: ${name}은(는) ${lo}~${hi} 사이 숫자여야 합니다 — 받은 값: ${JSON.stringify(v)}`);
  return v;
}

// x=±1.5에서 ±1로 수렴하는 3차 소프트 클립 (renderer.js에 있던 것과 같은 식)
export function softClip(x) {
  if (x > 1.5) return 1;
  if (x < -1.5) return -1;
  return x - (x * x * x) / 6.75;
}

// 소프트 클립이 "물리기 시작하는" 입력 — 이 위는 3차 항이 눈에 띄게 파형을 접는다.
// player.js의 levelReport가 출력 쪽에서 쓰는 0.8519가 곧 softClip(1.0)이다.
export const CLIP_ONSET = 1;

// 리포트에서 "눌렀다"고 셀 최소 감쇠 = 0.01dB. 컴프도 리미터도 게인이 1로 지수적으로 돌아오기 때문에
// 0보다 조금이라도 작으면 세는 식으로는 곡의 100%가 "눌림"으로 나와 수치가 아무 말도 못 하게 된다.
const GR_FLOOR = Math.pow(10, -0.01 / 20);

// 마스터 버스를 L·R에 제자리로 적용하고 리포트를 반환한다.
//   L, R : Float32Array (renderRange의 드라이 버스). 제자리 수정된다.
//   sr   : 샘플레이트
//   opts : { wetL, wetR, wetGain, inGain, makeup, fromStems,
//            comp: false | {threshold, ratio, attack, release},
//            limiter: false | true | {ceilingDb, lookaheadMs, releaseMs},
//            softClip: boolean }
// wetL/wetR을 주면 리버브 리턴 합산부터 이 함수가 맡는다 — 예전 인라인 체인이 리턴을
// 이중정밀도 레지스터 안에서 더했기 때문에, 그 지점을 함수 밖으로 빼면 중간값이 Float32Array에
// 한 번 담기면서 반올림이 끼어 소리가 비트 단위로 달라진다.
export function masterChain(L, R, sr, opts = {}) {
  if (!isBuf(L) || !isBuf(R))
    err("masterChain: L·R은 Float32Array여야 합니다 — renderRange가 만든 left/right를 그대로 넘기세요");
  if (L.length !== R.length)
    err(`masterChain: 좌우 길이가 다릅니다 (L=${L.length}, R=${R.length}) — 같은 렌더에서 나온 한 쌍이어야 합니다`);
  if (!Number.isFinite(sr) || sr <= 0)
    err(`masterChain: sr(샘플레이트)은 양수여야 합니다 — 받은 값: ${JSON.stringify(sr)}`);
  const n = L.length;
  const wetL = opts.wetL ?? null, wetR = opts.wetR ?? null;
  if (!!wetL !== !!wetR)
    err("masterChain: wetL·wetR은 둘 다 주거나 둘 다 빼야 합니다 (리버브 리턴은 스테레오 한 쌍)");
  if (wetL && (!isBuf(wetL) || !isBuf(wetR)))
    err("masterChain: wetL·wetR도 Float32Array여야 합니다 — reverbProcess가 돌려준 배열을 그대로 넘기세요");
  if (wetL && (wetL.length < n || wetR.length < n))
    err(`masterChain: 리버브 리턴이 드라이보다 짧습니다 (wet=${wetL.length}, dry=${n}) — 같은 길이로 렌더하세요`);

  const D = MASTER_DEFAULTS;
  const makeup = num(opts.makeup, D.makeup, "makeup", 0, 8);
  const wetGain = num(opts.wetGain, D.wetGain, "wetGain", 0, 4);
  // fromStems: 스템은 이미 makeup까지 곱해진 상태로 나온다 — 합쳐서 다시 넣을 땐 그만큼 되돌린다
  const inGain = opts.inGain !== undefined && opts.inGain !== null
    ? num(opts.inGain, D.inGain, "inGain", 0, 8)
    : (opts.fromStems ? 1 / makeup : D.inGain);
  const comp = opts.comp === false ? null : {
    threshold: num(opts.comp?.threshold, D.comp.threshold, "comp.threshold", 0.01, 2),
    ratio: num(opts.comp?.ratio, D.comp.ratio, "comp.ratio", 1, 20),
    attack: num(opts.comp?.attack, D.comp.attack, "comp.attack(초)", 0, 1),
    release: num(opts.comp?.release, D.comp.release, "comp.release(초)", 0.001, 5)
  };
  const lim = !opts.limiter ? null : {
    ceilingDb: num(opts.limiter === true ? undefined : opts.limiter.ceilingDb, D.limiter.ceilingDb, "limiter.ceilingDb", -24, 0),
    lookaheadMs: num(opts.limiter === true ? undefined : opts.limiter.lookaheadMs, D.limiter.lookaheadMs, "limiter.lookaheadMs", 0.1, 50),
    releaseMs: num(opts.limiter === true ? undefined : opts.limiter.releaseMs, D.limiter.releaseMs, "limiter.releaseMs", 1, 2000)
  };
  const clipOn = opts.softClip !== false;

  // 검출기 계수 — pk가 오르면 attack, 내리면 release 시정수로 따라간다
  const th = comp ? comp.threshold : 0;
  const ratio = comp ? comp.ratio : 1;
  const atkC = comp ? Math.exp(-1 / (comp.attack * sr)) : 0;
  const relC = comp ? Math.exp(-1 / (comp.release * sr)) : 0;
  let cenv = 0, compHits = 0, compGSum = 0, compMinG = 1, clipped = 0;
  let peak = 0, sumSq = 0;

  // 이 루프는 재생·내보내기가 매번 통과하는 곳이다 — 샘플마다 도는 계산은
  // 리포트용이라도 아낀다(dB 변환은 루프 밖에서 한 번에).
  for (let i = 0; i < n; i++) {
    const mixL = (L[i] + (wetL ? wetL[i] * wetGain : 0)) * inGain;
    const mixR = (R[i] + (wetR ? wetR[i] * wetGain : 0)) * inGain;
    let g = 1;
    if (comp) {
      const al = mixL < 0 ? -mixL : mixL, ar = mixR < 0 ? -mixR : mixR;
      const pk = al > ar ? al : ar;
      cenv = pk + (cenv - pk) * (pk > cenv ? atkC : relC);
      // 무릎 없는 하드니 — 임계 초과분만 ratio로 나눈다
      g = cenv > th ? (th + (cenv - th) / ratio) / cenv : 1;
      if (g < GR_FLOOR) { compHits++; compGSum += g; }
      if (g < compMinG) compMinG = g;
    }
    const yL = mixL * g * makeup, yR = mixR * g * makeup;
    // 리미터는 "다음에 올 피크"를 알아야 게인을 미리 내릴 수 있다 → 2패스로 넘긴다.
    // 리미터가 없을 때는 여기서 소프트 클립까지 끝낸다: 중간값을 Float32Array에 한 번
    // 담았다 꺼내면 그 자리에서 반올림이 생겨 예전 인라인 체인과 비트가 어긋난다.
    if (lim) { L[i] = yL; R[i] = yR; continue; }
    if (yL >= CLIP_ONSET || yL <= -CLIP_ONSET || yR >= CLIP_ONSET || yR <= -CLIP_ONSET) clipped++;
    const oL = clipOn ? softClip(yL) : yL, oR = clipOn ? softClip(yR) : yR;
    L[i] = oL; R[i] = oR;
    const al = oL < 0 ? -oL : oL, ar = oR < 0 ? -oR : oR;
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
    sumSq += oL * oL + oR * oR;
  }

  let limReport = null;
  if (lim) {
    const r = limitPass(L, R, sr, lim, clipOn);
    clipped = r.clipped; limReport = r.report; peak = r.peak; sumSq = r.sumSq;
  }
  const rms = Math.sqrt(sumSq / (2 * n || 1));
  return {
    peak, rms, peakDb: dbfs(peak), rmsDb: dbfs(rms),
    // clipped는 "소프트 클립이 물린 샘플 수" — 셰이퍼 입력이 ±1을 넘은 횟수다.
    // softClip:false로 꺼도 같은 기준으로 세므로 "껐다면 얼마나 물렸을까"를 그대로 비교할 수 있다.
    clipped, clipPct: n ? (clipped / n) * 100 : 0,
    // samples/pct는 0.01dB(GR_FLOOR) 넘게 눌린 샘플, maxGrDb는 그와 무관한 최대 감쇠.
    // avgGrDb는 눌린 구간 평균 게인의 dB — dB의 평균이 아니라 게인의 평균이라 아주 큰 순간 감쇠에 덜 휘둘린다.
    comp: comp ? {
      samples: compHits, pct: n ? (compHits / n) * 100 : 0,
      maxGrDb: -dbfs(compMinG), avgGrDb: compHits ? -dbfs(compGSum / compHits) : 0,
      threshold: th, ratio
    } : null,
    limiter: limReport,
    makeup, inGain, softClip: clipOn
  };
}

// ---------- 룩어헤드 리미터 ----------
// 목표: 피크가 "온 뒤에" 누르는 것이 아니라 오기 전에 미리 내려서, 소프트 클립이 물리는 일 자체를 없앤다.
// 오프라인 렌더라 버퍼 전체가 이미 손에 있다 — 실시간이라면 필요한 D 샘플 지연이 여기서는 공짜다.
//
// 게인 곡선: t[i]=천장/피크(필요 게인) → W=2D 창의 앞보기 최소 m[i] → 길이 D+1 이동평균 s[i].
// 이 조합은 s[i] ≤ t[i]를 보장한다(평균에 들어가는 모든 최소 창이 i를 품기 때문). 즉 오버슈트가 없고,
// 게인은 계단이 아니라 2D 샘플에 걸쳐 매끄럽게 내려간다 — 계단 자체가 새 왜곡을 만들기 때문이다.
function limitPass(L, R, sr, lim, clipOn) {
  const n = L.length;
  const ceiling = Math.pow(10, lim.ceilingDb / 20);
  const look = Math.max(1, Math.round(lim.lookaheadMs * 0.001 * sr));
  const W = look * 2;
  const report = {
    ceiling, ceilingDb: lim.ceilingDb, lookaheadMs: lim.lookaheadMs, releaseMs: lim.releaseMs,
    samples: 0, pct: 0, maxGrDb: 0, avgGrDb: 0
  };
  if (n === 0) return { clipped: 0, peak: 0, sumSq: 0, report };

  // 각 샘플이 천장을 넘지 않으려면 필요한 게인
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    const p = a > b ? a : b;
    t[i] = p > ceiling ? ceiling / p : 1;
  }
  // 앞을 내다보는 슬라이딩 최소 — 뒤에서 앞으로 훑으면 창이 뒤따라오는 모양이 되어 단조 덱으로 O(n)
  const cap = W + 2;
  const dqI = new Int32Array(cap), dqV = new Float64Array(cap);
  let head = 0, tail = 0; // 앞에서 뒤로: 인덱스는 감소, 값은 증가 → 최소는 항상 맨 앞
  const m = t;            // 덱이 값을 따로 들고 있으므로 t를 그대로 덮어쓴다(긴 곡에서 버퍼 하나를 아낀다)
  for (let i = n - 1; i >= 0; i--) {
    const v = t[i];
    while (tail > head && dqI[head % cap] > i + W) head++;
    while (tail > head && dqV[(tail - 1) % cap] >= v) tail--;
    dqI[tail % cap] = i; dqV[tail % cap] = v; tail++;
    m[i] = dqV[head % cap];
  }
  // 이동평균 + 릴리즈. 버퍼 앞쪽(j<0)은 m[0]으로 채운다 — 1로 채우면 첫 D 샘플에서 보장이 깨진다.
  const P = look + 1;
  const rise = 1 - Math.exp(-1 / (lim.releaseMs * 0.001 * sr)); // 게인이 1로 돌아가는 속도
  let sum = m[0] * P, prev = 1, minG = 1, hits = 0, gSum = 0, clipped = 0, peak = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) sum += m[i] - (i >= P ? m[i - P] : m[0]);
    const s = sum / P;
    // 내려갈 때는 이미 룩어헤드가 매끄럽게 만들어 둔 s를 그대로 쓰고, 올라갈 때만 릴리즈로 늦춘다.
    // (회복이 빠르면 저역에서 게인이 파형을 따라 출렁여 그 자체가 왜곡이 된다)
    const g = s < prev ? s : prev + (s - prev) * rise;
    prev = g;
    const yL = L[i] * g, yR = R[i] * g;
    if (yL >= CLIP_ONSET || yL <= -CLIP_ONSET || yR >= CLIP_ONSET || yR <= -CLIP_ONSET) clipped++;
    const oL = clipOn ? softClip(yL) : yL, oR = clipOn ? softClip(yR) : yR;
    L[i] = oL; R[i] = oR;
    const al = oL < 0 ? -oL : oL, ar = oR < 0 ? -oR : oR;
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
    sumSq += oL * oL + oR * oR;
    if (g < GR_FLOOR) { hits++; gSum += g; }
    if (g < minG) minG = g;
  }
  report.samples = hits;
  report.pct = (hits / n) * 100;
  report.maxGrDb = -dbfs(minG);
  report.avgGrDb = hits ? -dbfs(gSum / hits) : 0;
  return { clipped, peak, sumSq, report };
}

// ---------- 라우드니스 (ITU-R BS.1770-4) ----------
// K-웨이팅(하이셸프 + RLB 하이패스) → 400ms 블록(75% 겹침) → 절대 게이트 -70 LUFS → 상대 게이트 -10 LU.
// 규격의 계수표는 48kHz 전용이다. 기본 렌더가 44.1kHz라 sr마다 다시 이산화해야 하는데,
// 흔한 RBJ 쿡북 셸프 식으로는 48kHz에서 규격표가 재현되지 않는다(997Hz에서 0.43dB — 0.691dB여야 한다).
// 아래 파라미터화(De Man)는 48kHz에서 규격표를 1e-13까지 되살리고, 그때 K(997Hz)=0.691dB가 되어
// -0.691 오프셋과 정확히 상쇄된다 — 좌우 동시 0dBFS 997Hz 사인이 0 LKFS라는 규격의 기준점이다.
const K_SHELF = { g: 3.999843853973347, q: 0.7071752369554196, f: 1681.974450955533 };
const K_HPF = { q: 0.5003270373238773, f: 38.13547087602444 };

function kWeighting(sr) {
  let K = Math.tan(Math.PI * K_SHELF.f / sr);
  const vh = Math.pow(10, K_SHELF.g / 20), vb = Math.pow(vh, 0.499666774155);
  let d = 1 + K / K_SHELF.q + K * K;
  const shelf = {
    b0: (vh + (vb * K) / K_SHELF.q + K * K) / d,
    b1: (2 * (K * K - vh)) / d,
    b2: (vh - (vb * K) / K_SHELF.q + K * K) / d,
    a1: (2 * (K * K - 1)) / d,
    a2: (1 - K / K_SHELF.q + K * K) / d
  };
  K = Math.tan(Math.PI * K_HPF.f / sr);
  d = 1 + K / K_HPF.q + K * K;
  const hpf = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / d, a2: (1 - K / K_HPF.q + K * K) / d };
  return [shelf, hpf];
}

// 채널 하나를 K-웨이팅하며 100ms 서브블록마다 제곱합을 적는다.
// 400ms 블록은 서브블록 4칸, 3초 단구간은 30칸 — 필터 출력을 통째로 들고 있지 않아도 된다.
function kSubBlocks(x, sub, step, shelf, hpf) {
  let s1a = 0, s1b = 0, s2a = 0, s2b = 0; // 전치형 II 상태
  for (let k = 0; k < sub.length; k++) {
    let acc = 0;
    const end = (k + 1) * step;
    for (let i = k * step; i < end; i++) {
      const v = x[i];
      let y = shelf.b0 * v + s1a;
      s1a = shelf.b1 * v - shelf.a1 * y + s1b;
      s1b = shelf.b2 * v - shelf.a2 * y;
      const u = y;
      y = hpf.b0 * u + s2a;
      s2a = hpf.b1 * u - hpf.a1 * y + s2b;
      s2b = hpf.b2 * u - hpf.a2 * y;
      acc += y * y;
    }
    sub[k] = acc;
  }
}

const LUFS_OFFSET = -0.691; // 997Hz 사인이 좌우 동시에 0dBFS일 때 0 LKFS가 되도록 하는 규격 상수
const loud = z => (z > 0 ? LUFS_OFFSET + 10 * Math.log10(z) : -Infinity);

// 통합 라우드니스. R에 null을 주면 모노로 잰다. 입력은 건드리지 않는다(마스터 뒤에서 재는 계측기).
// 반환: { integrated, shortTermMax, momentaryMax, lra } — 단위는 LUFS, LRA만 LU.
// 측정할 블록이 없으면(0.4초 미만) 전부 null. 무음이면 integrated는 -Infinity(절대 게이트).
export function lufs(L, R, sr) {
  if (!isBuf(L)) err("lufs: L은 Float32Array여야 합니다");
  if (R !== null && R !== undefined && (!isBuf(R) || R.length !== L.length))
    err(`lufs: R은 L과 같은 길이의 Float32Array이거나 null(모노)이어야 합니다 (L=${L.length}, R=${R?.length})`);
  if (!Number.isFinite(sr) || sr <= 0) err(`lufs: sr(샘플레이트)은 양수여야 합니다 — 받은 값: ${JSON.stringify(sr)}`);
  const step = Math.round(sr * 0.1); // 100ms — 400ms 블록의 75% 겹침이 정확히 4칸이 된다
  const nSub = Math.floor(L.length / step);
  const empty = { integrated: null, shortTermMax: null, momentaryMax: null, lra: null };
  if (nSub < 4) return empty;

  const [shelf, hpf] = kWeighting(sr);
  const subL = new Float64Array(nSub);
  kSubBlocks(L, subL, step, shelf, hpf);
  let subR = null;
  if (R) { subR = new Float64Array(nSub); kSubBlocks(R, subR, step, shelf, hpf); }
  // 누적합 — 400ms·3초 창을 몇 번을 잡아도 O(1)
  const cL = prefix(subL), cR = subR ? prefix(subR) : null;
  const meanSq = (from, cells) => {
    const d = cells * step;
    return (cL[from + cells] - cL[from]) / d + (cR ? (cR[from + cells] - cR[from]) / d : 0);
  };

  // 400ms 블록(momentary) — 통합 라우드니스의 재료
  const zs = [];
  let momentaryMax = -Infinity;
  for (let j = 0; j + 4 <= nSub; j++) {
    const z = meanSq(j, 4);
    zs.push(z);
    const l = loud(z);
    if (l > momentaryMax) momentaryMax = l;
  }
  // 절대 게이트 -70 LUFS → 남은 블록의 평균에서 -10 LU 상대 게이트
  const passA = zs.filter(z => loud(z) > -70);
  let integrated = -Infinity;
  if (passA.length) {
    const relGate = loud(mean(passA)) - 10;
    const passR = passA.filter(z => loud(z) > relGate);
    integrated = loud(mean(passR.length ? passR : passA));
  }

  // 3초 단구간(short-term) — 창이 한 번도 안 차면(3초 미만 렌더) null
  const st = [];
  let shortTermMax = null;
  for (let j = 0; j + 30 <= nSub; j++) {
    const l = loud(meanSq(j, 30));
    st.push(l);
    if (shortTermMax === null || l > shortTermMax) shortTermMax = l;
  }

  return { integrated, shortTermMax, momentaryMax, lra: computeLra(st) };
}

function prefix(sub) {
  const c = new Float64Array(sub.length + 1);
  for (let i = 0; i < sub.length; i++) c[i + 1] = c[i] + sub[i];
  return c;
}

function mean(a) { let s = 0; for (const v of a) s += v; return s / a.length; }

// LRA (EBU Tech 3342): 3초 단구간 분포에서 상위 95% - 하위 10%.
// 게이트는 절대 -70 LUFS, 상대는 통과분 평균의 -20 LU.
function computeLra(st) {
  if (st.length < 2) return null;
  const passA = st.filter(l => l > -70);
  if (passA.length < 2) return null;
  // 라우드니스 평균은 dB가 아니라 에너지에서 내야 한다
  const relGate = loud(mean(passA.map(l => Math.pow(10, (l - LUFS_OFFSET) / 10)))) - 20;
  const kept = passA.filter(l => l > relGate).sort((a, b) => a - b);
  if (kept.length < 2) return null;
  return pct(kept, 0.95) - pct(kept, 0.10);
}

// 정렬된 배열의 백분위 — 규격 구현은 히스토그램을 쓰지만 여기서는 선형 보간으로 근사한다
function pct(sorted, p) {
  const x = (sorted.length - 1) * p;
  const i = Math.floor(x), f = x - i;
  return i + 1 < sorted.length ? sorted[i] + (sorted[i + 1] - sorted[i]) * f : sorted[i];
}

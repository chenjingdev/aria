// aria — 결정적 난수: 같은 곡은 몇 번을 렌더해도 같은 파형이 나와야 한다.
// (예전에는 오실레이터 초기 위상·드럼 노이즈가 Math.random이라 play와 export의 파형이 서로 달랐다)

// FNV-1a — 문자열/숫자 조각들을 32비트 시드로 접는다
export function hashSeed(...parts) {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x5f; // 조각 구분자 — "ab"+"c"와 "a"+"bc"가 같은 시드가 되지 않게
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 — 작고 빠르고 통계적으로 충분한 PRNG
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

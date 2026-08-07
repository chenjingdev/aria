// aria — SoundFont(.sf2) 파서 + 샘플 보이스 렌더러
// 지원 범위: 볼륨 엔벨로프(DAHDSR 근사)·키/벨로시티 존·루프·튜닝·감쇠.
// 모듈레이터·필터·LFO는 v1에서 생략 — GM 사운드폰트의 기본 재생 품질에는 이 부분집합으로 충분하다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GEN = {
  startAddrsOffset: 0, startloopAddrsOffset: 2, endloopAddrsOffset: 3, startAddrsCoarseOffset: 4,
  pan: 17,
  attackVolEnv: 34, holdVolEnv: 35, decayVolEnv: 36, sustainVolEnv: 37, releaseVolEnv: 38,
  instrument: 41, keyRange: 43, velRange: 44,
  startloopAddrsCoarseOffset: 45, initialAttenuation: 48,
  endloopAddrsCoarseOffset: 50, coarseTune: 51, fineTune: 52,
  sampleID: 53, sampleModes: 54, overridingRootKey: 58
};
// 프리셋 존의 값이 악기 존에 "더해지는" 제너레이터들 (SF2 스펙 8.5)
const ADDITIVE = new Set([GEN.attackVolEnv, GEN.holdVolEnv, GEN.decayVolEnv, GEN.sustainVolEnv,
  GEN.releaseVolEnv, GEN.initialAttenuation, GEN.coarseTune, GEN.fineTune, GEN.pan]);

const tc2sec = tc => Math.pow(2, tc / 1200); // timecents → 초
const cb2gain = cb => Math.pow(10, -cb / 200); // centibel 감쇠 → 선형 게인

function readChunks(buf, start, end) {
  const chunks = [];
  let p = start;
  while (p + 8 <= end) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    chunks.push({ id, start: p + 8, size });
    p += 8 + size + (size & 1); // RIFF는 워드 정렬
  }
  return chunks;
}

function parseRecords(buf, chunk, recSize, fn) {
  const out = [];
  for (let p = chunk.start; p + recSize <= chunk.start + chunk.size; p += recSize) out.push(fn(p));
  return out;
}

export function parseSf2(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "sfbk")
    throw new Error("sf2 형식이 아닙니다 (RIFF/sfbk 헤더 없음)");
  let smpl = null;
  const pdta = {};
  for (const list of readChunks(buf, 12, 8 + buf.readUInt32LE(4))) {
    if (list.id !== "LIST") continue;
    const kind = buf.toString("ascii", list.start, list.start + 4);
    for (const c of readChunks(buf, list.start + 4, list.start + list.size)) {
      if (kind === "sdta" && c.id === "smpl") smpl = c;
      if (kind === "pdta") pdta[c.id] = c;
    }
  }
  if (!smpl || !pdta.phdr || !pdta.pbag || !pdta.pgen || !pdta.inst || !pdta.ibag || !pdta.igen || !pdta.shdr)
    throw new Error("sf2에 필요한 청크가 없습니다");

  // 샘플 데이터는 복사 없이 Int16 뷰로 (smpl.start는 RIFF 정렬 덕에 짝수)
  const samples = new Int16Array(buf.buffer, buf.byteOffset + smpl.start, smpl.size >> 1);

  const shdr = parseRecords(buf, pdta.shdr, 46, p => ({
    start: buf.readUInt32LE(p + 20), end: buf.readUInt32LE(p + 24),
    loopStart: buf.readUInt32LE(p + 28), loopEnd: buf.readUInt32LE(p + 32),
    sampleRate: buf.readUInt32LE(p + 36), origPitch: buf.readUInt8(p + 40),
    correction: buf.readInt8(p + 41), type: buf.readUInt16LE(p + 44)
  })).slice(0, -1); // 마지막은 EOS 터미네이터

  const pbag = parseRecords(buf, pdta.pbag, 4, p => ({ gen: buf.readUInt16LE(p), }));
  const ibag = parseRecords(buf, pdta.ibag, 4, p => ({ gen: buf.readUInt16LE(p), }));
  const readGen = p => ({ op: buf.readUInt16LE(p), raw: buf.readUInt16LE(p + 2), signed: buf.readInt16LE(p + 2) });
  const pgen = parseRecords(buf, pdta.pgen, 4, readGen);
  const igen = parseRecords(buf, pdta.igen, 4, readGen);
  const instRecs = parseRecords(buf, pdta.inst, 22, p => ({ bagIdx: buf.readUInt16LE(p + 20) }));
  const phdr = parseRecords(buf, pdta.phdr, 38, p => ({
    name: buf.toString("ascii", p, p + 20).replace(/\0.*$/, ""),
    program: buf.readUInt16LE(p + 20), bank: buf.readUInt16LE(p + 22),
    bagIdx: buf.readUInt16LE(p + 24)
  }));

  // bag 구간 → 존 목록(제너레이터 맵)으로
  const zonesOf = (bags, gens, from, to) => {
    const zones = [];
    for (let b = from; b < to; b++) {
      const g0 = bags[b].gen, g1 = b + 1 < bags.length ? bags[b + 1].gen : gens.length;
      const z = { gens: new Map() };
      for (let g = g0; g < g1; g++) z.gens.set(gens[g].op, gens[g]);
      zones.push(z);
    }
    return zones;
  };

  // 악기: 글로벌 존 흡수 → [{keyLo,keyHi,velLo,velHi, gens}] (sampleID 필수)
  const instruments = instRecs.slice(0, -1).map((rec, i) => {
    const raw = zonesOf(ibag, igen, rec.bagIdx, instRecs[i + 1].bagIdx);
    let global = new Map();
    const zones = [];
    for (const [zi, z] of raw.entries()) {
      if (!z.gens.has(GEN.sampleID)) { if (zi === 0) global = z.gens; continue; }
      const merged = new Map(global);
      for (const [k, v] of z.gens) merged.set(k, v);
      zones.push(makeZone(merged));
    }
    return zones;
  });

  // 프리셋: (bank<<8)|program → [{범위, instIndex, 프리셋측 가산 제너레이터}]
  const presets = new Map();
  for (let i = 0; i < phdr.length - 1; i++) {
    const raw = zonesOf(pbag, pgen, phdr[i].bagIdx, phdr[i + 1].bagIdx);
    let global = new Map();
    const pzones = [];
    for (const [zi, z] of raw.entries()) {
      if (!z.gens.has(GEN.instrument)) { if (zi === 0) global = z.gens; continue; }
      const merged = new Map(global);
      for (const [k, v] of z.gens) merged.set(k, v);
      const kr = merged.get(GEN.keyRange), vr = merged.get(GEN.velRange);
      pzones.push({
        keyLo: kr ? kr.raw & 0xff : 0, keyHi: kr ? kr.raw >> 8 : 127,
        velLo: vr ? vr.raw & 0xff : 0, velHi: vr ? vr.raw >> 8 : 127,
        instIndex: merged.get(GEN.instrument).raw,
        add: merged // ADDITIVE만 골라 쓴다
      });
    }
    presets.set((phdr[i].bank << 8) | phdr[i].program, { name: phdr[i].name, zones: pzones });
  }

  return { samples, shdr, instruments, presets, file: filePath, size: buf.length };
}

function makeZone(gens) {
  const kr = gens.get(GEN.keyRange), vr = gens.get(GEN.velRange);
  const num = (op, dflt) => gens.has(op) ? gens.get(op).signed : dflt;
  return {
    keyLo: kr ? kr.raw & 0xff : 0, keyHi: kr ? kr.raw >> 8 : 127,
    velLo: vr ? vr.raw & 0xff : 0, velHi: vr ? vr.raw >> 8 : 127,
    sampleID: gens.get(GEN.sampleID).raw,
    modes: gens.has(GEN.sampleModes) ? gens.get(GEN.sampleModes).raw & 3 : 0,
    rootKey: gens.has(GEN.overridingRootKey) && gens.get(GEN.overridingRootKey).signed >= 0
      ? gens.get(GEN.overridingRootKey).signed : null,
    attack: num(GEN.attackVolEnv, -12000), hold: num(GEN.holdVolEnv, -12000),
    decay: num(GEN.decayVolEnv, -12000), sustain: num(GEN.sustainVolEnv, 0),
    release: num(GEN.releaseVolEnv, -12000),
    attenuation: num(GEN.initialAttenuation, 0),
    coarse: num(GEN.coarseTune, 0), fine: num(GEN.fineTune, 0),
    // 샘플/루프 시작·끝 오프셋 (더블링 레이어 등에 쓰임)
    startOff: num(GEN.startAddrsOffset, 0) + 32768 * num(GEN.startAddrsCoarseOffset, 0),
    loopStartOff: num(GEN.startloopAddrsOffset, 0) + 32768 * num(GEN.startloopAddrsCoarseOffset, 0),
    loopEndOff: num(GEN.endloopAddrsOffset, 0) + 32768 * num(GEN.endloopAddrsCoarseOffset, 0)
  };
}

// ---------- 로드 (다중 폰트 레지스트리) ----------
export const SF2_PATH = process.env.ARIA_SF2 ||
  path.join(os.homedir(), ".aria", "soundfonts", "default.sf2");
export const SF_DIR = path.dirname(SF2_PATH);

// 경로 → {inst, sig}. 파일 서명(mtime:size)이 바뀌면 자동 재시도 —
// "파일을 두면 열립니다"라는 안내가 재시작 없이도 참이 되게 한다.
const fonts = new Map();
export function getFont(fileName) {
  const p = path.isAbsolute(fileName) ? fileName : path.join(SF_DIR, fileName);
  let st = null;
  try { st = fs.statSync(p); } catch { /* 파일 없음 */ }
  const sig = st ? `${st.mtimeMs}:${st.size}` : null;
  const c = fonts.get(p);
  if (c && c.sig === sig) return c.inst;
  let inst = null;
  if (st) {
    try { inst = parseSf2(p); }
    catch (e) { console.error(`[aria] 사운드폰트 로드 실패(${p}):`, e.message); }
  }
  fonts.set(p, { inst, sig });
  return inst;
}

export function getSf2() { return getFont(SF2_PATH); }
export function sf2Available() { return getSf2() !== null; }
// 프리셋 스펙의 font 필드(예: "salamander.sf2")를 우선하고, 없으면 기본 폰트로 폴백
export function resolveFont(spec) {
  return (spec?.font && getFont(spec.font)) || getSf2();
}
export function sf2Info() {
  const sf = getSf2();
  if (!sf) return null;
  const extras = [...fonts.values()].filter(f => f.inst && f.inst !== sf).map(f => path.basename(f.inst.file));
  return `${path.basename(sf.file)} (${(sf.size / 1048576).toFixed(1)}MB, 프리셋 ${sf.presets.size}개)`
    + (extras.length ? ` + ${extras.join(", ")}` : "");
}

// ---------- 보이스 렌더 ----------
// (bank, program)의 key/vel에 해당하는 존들을 모노 합으로 렌더
export function renderSf2Voice(sf, bank, program, key, vel, gateSec, sr, { track, detuneCents = 0, pitchMod = null } = {}) {
  const preset = sf.presets.get((bank << 8) | program) ?? (bank === 128 ? sf.presets.get(128 << 8) : null);
  if (!preset) return new Float32Array(64);
  const vel127 = Math.round(vel * 127);
  const voices = [];
  for (const pz of preset.zones) {
    if (key < pz.keyLo || key > pz.keyHi || vel127 < pz.velLo || vel127 > pz.velHi) continue;
    for (const iz of sf.instruments[pz.instIndex] ?? []) {
      if (key < iz.keyLo || key > iz.keyHi || vel127 < iz.velLo || vel127 > iz.velHi) continue;
      // 프리셋 존 값은 악기 존 값에 가산
      const adj = op => pz.add.has(op) && ADDITIVE.has(op) ? pz.add.get(op).signed : 0;
      voices.push({
        iz,
        attack: iz.attack + adj(GEN.attackVolEnv), hold: iz.hold + adj(GEN.holdVolEnv),
        decay: iz.decay + adj(GEN.decayVolEnv), sustain: iz.sustain + adj(GEN.sustainVolEnv),
        release: iz.release + adj(GEN.releaseVolEnv),
        attenuation: iz.attenuation + adj(GEN.initialAttenuation),
        coarse: iz.coarse + adj(GEN.coarseTune), fine: iz.fine + adj(GEN.fineTune)
      });
    }
  }
  if (!voices.length) return new Float32Array(64);
  // 우리가 재현하지 않는 파라미터(모듈레이터 등)만 다른 중복 보이스 제거 —
  // GeneralUser처럼 변형 존이 많은 사운드폰트에서 같은 샘플이 4겹씩 쌓여 음량이 튀는 것 방지
  const seen = new Set();
  const unique = voices.filter(v => {
    // 우리가 재현하는 파라미터 전부를 키에 — 실제로 다르게 들릴 변형만 남긴다
    const k = `${v.iz.sampleID}:${v.coarse}:${v.fine}:${v.attenuation}:${v.attack}:${v.release}` +
      `:${v.sustain}:${v.hold}:${v.decay}:${v.iz.modes}:${v.iz.startOff}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  voices.length = 0;
  voices.push(...unique);

  // 트랙 오버라이드는 SF 엔벨로프 위에 얹힌다
  const relOverride = track?.release;
  const pm = pitchMod; // 샘플 재생 속도에 곱해 휘어 오르내림·떨림을 만든다
  const atkOverride = track?.attack;
  const maxRel = Math.max(...voices.map(v => relOverride ?? clamp(tc2sec(v.release), 0.01, 8)));
  // 버퍼는 어택도 담아야 한다 — 긴 attack 오버라이드가 게이트보다 길면 잘리거나 무음이 된다
  const maxAtk = Math.max(...voices.map(v => clamp(atkOverride ?? tc2sec(v.attack), 0.001, 10)));
  const len = Math.ceil((Math.max(gateSec, maxAtk) + maxRel + 0.05) * sr);
  const out = new Float32Array(len);
  const norm = voices.length > 1 ? 1 / Math.sqrt(voices.length) : 1;

  for (const v of voices) {
    const s = sf.shdr[v.iz.sampleID];
    if (!s || s.end <= s.start) continue;
    const root = v.iz.rootKey ?? (s.origPitch <= 127 ? s.origPitch : 60);
    const semis = key - root + v.coarse + (v.fine + s.correction) / 100;
    const step = Math.pow(2, semis / 12) * s.sampleRate / sr;
    const att = clamp(v.attenuation, 0, 1440) * 0.4; // FluidSynth 관례: 명목 cB의 0.4배
    const gain = cb2gain(att) * norm;
    const a = clamp(atkOverride ?? tc2sec(v.attack), 0.001, 10);
    const holdDec = clamp(tc2sec(v.hold), 0, 10) + clamp(tc2sec(v.decay), 0.001, 25);
    const susLevel = cb2gain(clamp(v.sustain, 0, 1440));
    const rel = clamp(relOverride ?? tc2sec(v.release), 0.01, 8);
    // 존 오프셋을 반영한 유효 경계 — 손상 파일이 와도 샘플 배열 밖을 읽지 않게 클램프
    const sStart = clamp(s.start + v.iz.startOff, s.start, s.end - 1);
    const loopStart = clamp(s.loopStart + v.iz.loopStartOff, sStart, s.end);
    const loopEnd = clamp(s.loopEnd + v.iz.loopEndOff, sStart, s.end);
    const loop = (v.iz.modes === 1 || v.iz.modes === 3) && loopEnd > loopStart + 2;
    const loopLen = loopEnd - loopStart;

    const aN = Math.max(1, (a * sr) | 0);
    const gateN = Math.min(len, Math.max(aN, (gateSec * sr) | 0));
    const dN = Math.max(1, (holdDec * sr) | 0);
    const rN = Math.max(1, (rel * sr) | 0);
    let pos = sStart;
    for (let i = 0; i < len; i++) {
      // 엔벨로프 (synth.js와 같은 곡선 — raised-cosine 어택, 멱곡선 감쇠)
      let env;
      if (i < aN) env = 0.5 - 0.5 * Math.cos(Math.PI * (i / aN));
      else {
        const dd = i - aN;
        env = dd < dN ? susLevel + (1 - susLevel) * Math.pow(1 - dd / dN, 1.6) : susLevel;
      }
      if (i >= gateN) {
        const rr = (i - gateN) / rN;
        if (rr >= 1) break;
        env *= Math.pow(1 - rr, 1.4);
      }
      // 샘플 보간 — 4점 Catmull-Rom. 선형 보간은 32kHz 샘플을 올릴 때 고역에 거친 앨리어싱을 남긴다.
      // 이웃 인덱스는 루프 경계를 감아 읽어서 반복 지점 클릭도 없앤다.
      const i0 = pos | 0;
      if (!loop && i0 + 1 >= s.end) break;
      const frac = pos - i0;
      let ym1, y0, y1, y2;
      if (loop && i0 + 2 >= loopEnd) {
        const wrap = j => { while (j >= loopEnd) j -= loopLen; return j; };
        ym1 = sf.samples[wrap(i0 - 1 < sStart ? i0 : i0 - 1)];
        y0 = sf.samples[wrap(i0)]; y1 = sf.samples[wrap(i0 + 1)]; y2 = sf.samples[wrap(i0 + 2)];
      } else {
        ym1 = sf.samples[i0 > sStart ? i0 - 1 : i0];
        y0 = sf.samples[i0];
        y1 = sf.samples[i0 + 1 < s.end ? i0 + 1 : i0];
        y2 = sf.samples[i0 + 2 < s.end ? i0 + 2 : i0 + 1 < s.end ? i0 + 1 : i0];
      }
      const c1 = 0.5 * (y1 - ym1);
      const c2 = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2;
      const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
      const y = ((c3 * frac + c2) * frac + c1) * frac + y0;
      out[i] += (y / 32768) * env * gain;
      pos += step * (pm ? pm[i] : 1);
      // step이 루프 길이보다 커도 폭주하지 않게 while로 되감는다
      if (loop) while (pos >= loopEnd) pos -= loopLen;
    }
  }
  return out;
}

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

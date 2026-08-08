// aria — SoundFont(.sf2) 파서 + 샘플 보이스 렌더러
// 지원 범위: 볼륨 엔벨로프(DAHDSR 근사)·키/벨로시티 존·루프·튜닝·감쇠.
// 모듈레이터·필터·LFO·linked stereo는 v1에서 생략한다. 악보 스케치 재생은 가능하지만
// 원본 SoundFont의 공간감·음색 변화·연주 표현을 일부 잃으므로 완전한 SF2 엔진은 아니다.
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
  if ((smpl.start & 1) || (smpl.size & 1) || smpl.start + smpl.size > buf.length)
    throw new Error("sf2 sample data 경계가 올바르지 않습니다");

  // 샘플 데이터는 복사 없이 Int16 뷰로 (smpl.start는 RIFF 정렬 덕에 짝수)
  const samples = new Int16Array(buf.buffer, buf.byteOffset + smpl.start, smpl.size >> 1);

  const shdr = parseRecords(buf, pdta.shdr, 46, p => ({
    start: buf.readUInt32LE(p + 20), end: buf.readUInt32LE(p + 24),
    loopStart: buf.readUInt32LE(p + 28), loopEnd: buf.readUInt32LE(p + 32),
    sampleRate: buf.readUInt32LE(p + 36), origPitch: buf.readUInt8(p + 40),
    correction: buf.readInt8(p + 41), type: buf.readUInt16LE(p + 44)
  })).slice(0, -1); // 마지막은 EOS 터미네이터
  for (const [i, s] of shdr.entries()) {
    if (!Number.isInteger(s.sampleRate) || s.sampleRate <= 0 || s.sampleRate > 768000)
      throw new Error(`sf2 sample ${i}의 sampleRate가 올바르지 않습니다: ${s.sampleRate}`);
    if (s.start >= s.end || s.end > samples.length)
      throw new Error(`sf2 sample ${i}의 start/end가 sample data 범위를 벗어납니다`);
  }

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
  for (const [ii, zones] of instruments.entries()) {
    for (const zone of zones) {
      if (!Number.isInteger(zone.sampleID) || zone.sampleID < 0 || zone.sampleID >= shdr.length)
        throw new Error(`sf2 instrument ${ii}가 없는 sampleID ${zone.sampleID}를 참조합니다`);
      const sample = shdr[zone.sampleID];
      if ((zone.modes === 1 || zone.modes === 3) &&
          (sample.loopStart < sample.start || sample.loopEnd <= sample.loopStart + 2 || sample.loopEnd > sample.end))
        throw new Error(`sf2 instrument ${ii}의 loop sampleID ${zone.sampleID} 경계가 올바르지 않습니다`);
    }
  }

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
      const instIndex = merged.get(GEN.instrument).raw;
      if (instIndex >= instruments.length)
        throw new Error(`sf2 preset ${phdr[i].bank}:${phdr[i].program}이 없는 instrument ${instIndex}를 참조합니다`);
      pzones.push({
        keyLo: kr ? kr.raw & 0xff : 0, keyHi: kr ? kr.raw >> 8 : 127,
        velLo: vr ? vr.raw & 0xff : 0, velHi: vr ? vr.raw >> 8 : 127,
        instIndex,
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
const fontIndexes = new Map();
export function getFont(fileName) {
  const p = path.isAbsolute(fileName) ? fileName : path.join(SF_DIR, fileName);
  let st = null;
  try { st = fs.statSync(p); } catch { /* 파일 없음 */ }
  const sig = st ? `${st.mtimeMs}:${st.size}` : null;
  const c = fonts.get(p);
  if (c && c.sig === sig) return c.inst;
  let inst = null, error = null;
  if (st) {
    try { inst = parseSf2(p); }
    catch (e) { error = e.message; console.error(`[aria] 사운드폰트 로드 실패(${p}):`, e.message); }
  }
  fonts.set(p, { inst, sig, error });
  return inst;
}

export function getSf2() { return getFont(SF2_PATH); }
export function sf2Available() { return getSf2() !== null; }

export function requiredFontPath(spec) {
  // default.sf2는 ARIA_SF2 오버라이드를 포함한 '기본 폰트'의 논리 이름이다.
  if (!spec?.font || spec.font === "default.sf2") return SF2_PATH;
  const ref = spec.font;
  return path.isAbsolute(ref) ? ref : path.join(SF_DIR, ref);
}

export function requiredFontName(spec) { return path.basename(requiredFontPath(spec)); }

// 수백 MB~1GB의 PCM 전체를 메모리에 올리지 않고 RIFF/pdta 헤더만 읽어 bank/program 목록을 검사한다.
// GUI가 뜰 때 손상 파일이나 잘못된 폰트를 활성 선택지로 표시하지 않기 위한 가벼운 사전 검사다.
function inspectFontIndex(file) {
  let st;
  try { st = fs.statSync(file); }
  catch { return { state: "missing", sig: null, error: "파일 미설치", programs: null }; }
  const sig = `${st.mtimeMs}:${st.size}`;
  const cached = fontIndexes.get(file);
  if (cached?.sig === sig) return cached;
  let fd;
  const exact = (position, length) => {
    const out = Buffer.alloc(length);
    const read = fs.readSync(fd, out, 0, length, position);
    if (read !== length) throw new Error("파일이 중간에서 잘렸습니다");
    return out;
  };
  let result;
  try {
    fd = fs.openSync(file, "r");
    const head = exact(0, 12);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "sfbk")
      throw new Error("sf2 형식이 아닙니다 (RIFF/sfbk 헤더 없음)");
    const riffEnd = 8 + head.readUInt32LE(4);
    if (riffEnd > st.size) throw new Error("RIFF가 선언한 크기보다 파일이 짧습니다");
    let smplWords = null;
    const pdtaChunks = new Map();
    const requiredPdta = new Set(["phdr", "pbag", "pgen", "inst", "ibag", "igen", "shdr"]);
    for (let p = 12; p + 8 <= riffEnd;) {
      const h = exact(p, 8), id = h.toString("ascii", 0, 4), size = h.readUInt32LE(4);
      const start = p + 8, end = start + size;
      if (end > st.size) throw new Error(`청크 ${id}가 파일 크기를 넘습니다`);
      if (id === "LIST" && size >= 4) {
        const kind = exact(start, 4).toString("ascii");
        if (kind === "sdta") {
          for (let q = start + 4; q + 8 <= end;) {
            const sh = exact(q, 8), sid = sh.toString("ascii", 0, 4), ssize = sh.readUInt32LE(4);
            const send = q + 8 + ssize;
            if (send > end) throw new Error(`sdta/${sid} 청크가 LIST를 넘습니다`);
            if (sid === "smpl") {
              if (ssize < 2 || (ssize & 1)) throw new Error("sdta/smpl 크기가 올바르지 않습니다");
              smplWords = ssize >> 1;
            }
            q = send + (ssize & 1);
          }
        } else if (kind === "pdta") {
          for (let q = start + 4; q + 8 <= end;) {
            const sh = exact(q, 8), sid = sh.toString("ascii", 0, 4), ssize = sh.readUInt32LE(4);
            const sstart = q + 8, send = sstart + ssize;
            if (send > end) throw new Error(`pdta/${sid} 청크가 LIST를 넘습니다`);
            requiredPdta.delete(sid);
            pdtaChunks.set(sid, { start: sstart, size: ssize });
            q = send + (ssize & 1);
          }
        }
      }
      p = end + (size & 1);
    }
    if (smplWords === null || requiredPdta.size)
      throw new Error(`필수 SoundFont 청크가 없습니다${requiredPdta.size ? `: ${[...requiredPdta].join(", ")}` : ""}`);
    const layout = {
      phdr: [38, 2], pbag: [4, 1], pgen: [4, 1], inst: [22, 2],
      ibag: [4, 1], igen: [4, 1], shdr: [46, 2]
    };
    const bodies = {}, counts = {};
    for (const [id, [recordSize, minRecords]] of Object.entries(layout)) {
      const chunk = pdtaChunks.get(id);
      if (!chunk || chunk.size % recordSize !== 0 || chunk.size / recordSize < minRecords)
        throw new Error(`${id} 크기가 올바르지 않습니다`);
      bodies[id] = exact(chunk.start, chunk.size);
      counts[id] = chunk.size / recordSize;
    }

    const sampleCount = counts.shdr - 1; // 마지막 EOS 제외
    for (let i = 0; i < sampleCount; i++) {
      const p = i * 46, start = bodies.shdr.readUInt32LE(p + 20), end = bodies.shdr.readUInt32LE(p + 24);
      const loopStart = bodies.shdr.readUInt32LE(p + 28), loopEnd = bodies.shdr.readUInt32LE(p + 32);
      const rate = bodies.shdr.readUInt32LE(p + 36);
      if (start >= end || end > smplWords)
        throw new Error(`sample ${i}의 start/end가 sample data 범위를 벗어납니다`);
      if (rate <= 0 || rate > 768000) throw new Error(`sample ${i}의 sampleRate가 올바르지 않습니다: ${rate}`);
    }
    const instCount = counts.inst - 1;
    for (let p = 0; p + 4 <= bodies.igen.length; p += 4) {
      if (bodies.igen.readUInt16LE(p) === GEN.sampleID && bodies.igen.readUInt16LE(p + 2) >= sampleCount)
        throw new Error(`igen이 없는 sampleID ${bodies.igen.readUInt16LE(p + 2)}를 참조합니다`);
    }
    for (let p = 0; p + 4 <= bodies.pgen.length; p += 4) {
      if (bodies.pgen.readUInt16LE(p) === GEN.instrument && bodies.pgen.readUInt16LE(p + 2) >= instCount)
        throw new Error(`pgen이 없는 instrument ${bodies.pgen.readUInt16LE(p + 2)}를 참조합니다`);
    }
    for (let p = 0; p < bodies.pbag.length; p += 4)
      if (bodies.pbag.readUInt16LE(p) >= counts.pgen) throw new Error("pbag generator index가 범위를 벗어납니다");
    for (let p = 0; p < bodies.ibag.length; p += 4)
      if (bodies.ibag.readUInt16LE(p) >= counts.igen) throw new Error("ibag generator index가 범위를 벗어납니다");
    for (let p = 0; p < bodies.phdr.length; p += 38)
      if (bodies.phdr.readUInt16LE(p + 24) >= counts.pbag) throw new Error("phdr bag index가 범위를 벗어납니다");
    for (let p = 0; p < bodies.inst.length; p += 22)
      if (bodies.inst.readUInt16LE(p + 20) >= counts.ibag) throw new Error("inst bag index가 범위를 벗어납니다");

    const programs = new Set();
    for (let p = 0; p + 38 < bodies.phdr.length; p += 38) {
      const program = bodies.phdr.readUInt16LE(p + 20), bank = bodies.phdr.readUInt16LE(p + 22);
      programs.add((bank << 8) | program);
    }
    result = { state: "installed", sig, error: null, programs };
  } catch (e) {
    result = { state: "corrupt", sig, error: e.message, programs: null };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fontIndexes.set(file, result);
  return result;
}

// UI·MCP가 음원 누락·손상·악기 미포함을 숨기지 않도록 프리셋별 상태를 돌려준다.
export function fontStatus(spec) {
  const file = requiredFontPath(spec);
  const index = inspectFontIndex(file);
  const base = { file, name: path.basename(file) };
  if (index.state === "missing") return { ...base, available: false, state: "missing", reason: "파일 미설치" };
  if (index.state === "corrupt") return { ...base, available: false, state: "corrupt", reason: index.error ?? "파일 손상 또는 지원하지 않는 형식" };
  const parsed = fonts.get(file);
  if (parsed?.sig === index.sig && !parsed.inst)
    return { ...base, available: false, state: "corrupt", reason: parsed.error ?? "파일 손상 또는 지원하지 않는 형식" };
  const bank = spec?.bank ?? 0;
  const program = spec?.program ?? spec?.gm;
  if (Number.isInteger(program) && !index.programs.has((bank << 8) | program)) {
    return { ...base, available: false, state: "program-missing", reason: `bank ${bank}, program ${program} 악기 미포함` };
  }
  return { ...base, available: true, state: parsed?.inst ? "loaded" : "installed", reason: null };
}

// 명시한 폰트가 없거나 손상되면 null. 다른 폰트로 몰래 대체하지 않는다.
export function resolveFont(spec) {
  return getFont(requiredFontPath(spec));
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
  if (!Number.isFinite(key) || !Number.isFinite(vel) || !Number.isFinite(gateSec) || !Number.isFinite(sr) || sr <= 0)
    throw new Error("SoundFont 렌더 인자가 올바르지 않습니다");
  if (!Number.isFinite(detuneCents)) throw new Error("detuneCents가 유한한 숫자가 아닙니다");
  const preset = sf.presets.get((bank << 8) | program);
  if (!preset)
    throw new Error(`사운드폰트 ${path.basename(sf.file)}에 bank ${bank}, program ${program} 악기가 없습니다`);
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
  if (!voices.length)
    throw new Error(`사운드폰트 ${path.basename(sf.file)}의 bank ${bank}, program ${program}에는 MIDI ${key}, velocity ${vel127} 샘플이 없습니다`);
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
    const wantsLoop = v.iz.modes === 1 || v.iz.modes === 3;
    if (!s || s.start < 0 || s.start >= s.end || s.end > sf.samples.length ||
        (wantsLoop && (s.loopStart < s.start || s.loopEnd <= s.loopStart + 2 || s.loopEnd > s.end)) ||
        !Number.isFinite(s.sampleRate) || s.sampleRate <= 0)
      throw new Error(`사운드폰트 ${path.basename(sf.file)}의 sampleID ${v.iz.sampleID} 경계가 손상되었습니다`);
    const root = v.iz.rootKey ?? (s.origPitch <= 127 ? s.origPitch : 60);
    const semis = key - root + v.coarse + (v.fine + s.correction + detuneCents) / 100;
    const step = Math.pow(2, semis / 12) * s.sampleRate / sr;
    if (!Number.isFinite(step) || step <= 0)
      throw new Error(`사운드폰트 ${path.basename(sf.file)}의 sampleID ${v.iz.sampleID} 재생 속도가 올바르지 않습니다`);
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
    const loop = wantsLoop;
    const loopLen = loopEnd - loopStart;
    if (!Number.isFinite(sStart) || !Number.isFinite(loopStart) || !Number.isFinite(loopEnd) ||
        (loop && loopEnd <= loopStart + 2))
      throw new Error(`사운드폰트 ${path.basename(sf.file)}의 sampleID ${v.iz.sampleID}가 zone offset 적용 후 올바르지 않은 loop 경계를 가집니다`);

    const aN = Math.max(1, (a * sr) | 0);
    const gateN = Math.min(len, Math.max(aN, (gateSec * sr) | 0));
    const dN = Math.max(1, (holdDec * sr) | 0);
    const rN = Math.max(1, (rel * sr) | 0);
    let pos = sStart;
    for (let i = 0; i < len; i++) {
      // 엔벨로프 — raised-cosine 어택, 멱곡선 감쇠
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
      const i0 = Math.floor(pos);
      if (!loop && i0 + 1 >= s.end) break;
      const frac = pos - i0;
      let ym1, y0, y1, y2;
      if (loop && i0 + 2 >= loopEnd) {
        const wrap = j => j >= loopEnd ? loopStart + ((j - loopStart) % loopLen) : j;
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
      if (!Number.isFinite(y))
        throw new Error(`사운드폰트 ${path.basename(sf.file)}의 sampleID ${v.iz.sampleID}에서 유효하지 않은 PCM을 읽었습니다`);
      out[i] += (y / 32768) * env * gain;
      const mod = pm ? (typeof pm === "function" ? pm(i) : (pm[i] ?? pm[pm.length - 1] ?? 1)) : 1;
      if (!Number.isFinite(mod) || mod <= 0)
        throw new Error("SoundFont pitch modulation에 유효하지 않은 값이 있습니다");
      const advance = step * mod;
      if (!Number.isFinite(advance) || advance <= 0)
        throw new Error("SoundFont pitch modulation이 유효하지 않은 재생 속도를 만들었습니다");
      pos += advance;
      // 큰 재생 간격도 반복 횟수에 비례하지 않는 한 번의 modulo 연산으로 안전하게 되감는다.
      if (loop && pos >= loopEnd) pos = loopStart + ((pos - loopStart) % loopLen);
    }
  }
  return out;
}

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

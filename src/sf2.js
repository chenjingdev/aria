// aria — SoundFont 파일의 설치·구조·bank/program 상태를 가볍게 검사한다.
//
// 이 모듈은 샘플 PCM을 읽거나 악기 소리를 만들지 않는다. 실제 SF2 재생은 검증된
// 오픈소스 엔진 SpessaSynth(src/spessa-engine.js)가 담당한다. 여기서는 수 GB 음원을
// UI 목록 때문에 전부 메모리에 올리지 않도록 RIFF/pdta 색인만 읽는다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GEN_INSTRUMENT = 41;
const GEN_SAMPLE_ID = 53;

export const SF2_PATH = process.env.ARIA_SF2 ||
  path.join(os.homedir(), ".aria", "soundfonts", "default.sf2");
export const SF_DIR = path.dirname(SF2_PATH);

const fontIndexes = new Map();

export function requiredFontPath(spec) {
  // default.sf2는 ARIA_SF2 오버라이드를 포함한 '기본 폰트'의 논리 이름이다.
  if (!spec?.font || spec.font === "default.sf2") return SF2_PATH;
  const ref = spec.font;
  return path.isAbsolute(ref) ? ref : path.join(SF_DIR, ref);
}

export function requiredFontName(spec) { return path.basename(requiredFontPath(spec)); }

// 수백 MB~수 GB의 PCM 전체를 메모리에 올리지 않고 RIFF/pdta 헤더만 읽어
// 손상 파일과 bank/program 누락을 UI·MCP에서 먼저 보여 준다.
function inspectFontIndex(file) {
  let stat;
  try { stat = fs.statSync(file); }
  catch { return { state: "missing", sig: null, error: "파일 미설치", programs: null }; }
  const sig = `${stat.mtimeMs}:${stat.size}`;
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
    if (riffEnd > stat.size) throw new Error("RIFF가 선언한 크기보다 파일이 짧습니다");

    let sampleWords = null;
    const pdtaChunks = new Map();
    const requiredPdta = new Set(["phdr", "pbag", "pgen", "inst", "ibag", "igen", "shdr"]);
    for (let position = 12; position + 8 <= riffEnd;) {
      const header = exact(position, 8);
      const id = header.toString("ascii", 0, 4), size = header.readUInt32LE(4);
      const start = position + 8, end = start + size;
      if (end > stat.size) throw new Error(`청크 ${id}가 파일 크기를 넘습니다`);
      if (id === "LIST" && size >= 4) {
        const kind = exact(start, 4).toString("ascii");
        if (kind === "sdta") {
          for (let p = start + 4; p + 8 <= end;) {
            const h = exact(p, 8), subId = h.toString("ascii", 0, 4), subSize = h.readUInt32LE(4);
            const subEnd = p + 8 + subSize;
            if (subEnd > end) throw new Error(`sdta/${subId} 청크가 LIST를 넘습니다`);
            if (subId === "smpl") {
              if (subSize < 2 || (subSize & 1)) throw new Error("sdta/smpl 크기가 올바르지 않습니다");
              sampleWords = subSize >> 1;
            }
            p = subEnd + (subSize & 1);
          }
        } else if (kind === "pdta") {
          for (let p = start + 4; p + 8 <= end;) {
            const h = exact(p, 8), subId = h.toString("ascii", 0, 4), subSize = h.readUInt32LE(4);
            const subStart = p + 8, subEnd = subStart + subSize;
            if (subEnd > end) throw new Error(`pdta/${subId} 청크가 LIST를 넘습니다`);
            requiredPdta.delete(subId);
            pdtaChunks.set(subId, { start: subStart, size: subSize });
            p = subEnd + (subSize & 1);
          }
        }
      }
      position = end + (size & 1);
    }
    if (sampleWords === null || requiredPdta.size)
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
      const p = i * 46;
      const start = bodies.shdr.readUInt32LE(p + 20), end = bodies.shdr.readUInt32LE(p + 24);
      const rate = bodies.shdr.readUInt32LE(p + 36);
      if (start >= end || end > sampleWords)
        throw new Error(`sample ${i}의 start/end가 sample data 범위를 벗어납니다`);
      if (rate <= 0 || rate > 768000)
        throw new Error(`sample ${i}의 sampleRate가 올바르지 않습니다: ${rate}`);
    }

    const instrumentCount = counts.inst - 1;
    for (let p = 0; p + 4 <= bodies.igen.length; p += 4) {
      if (bodies.igen.readUInt16LE(p) === GEN_SAMPLE_ID && bodies.igen.readUInt16LE(p + 2) >= sampleCount)
        throw new Error(`igen이 없는 sampleID ${bodies.igen.readUInt16LE(p + 2)}를 참조합니다`);
    }
    for (let p = 0; p + 4 <= bodies.pgen.length; p += 4) {
      if (bodies.pgen.readUInt16LE(p) === GEN_INSTRUMENT && bodies.pgen.readUInt16LE(p + 2) >= instrumentCount)
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
  } catch (error) {
    result = { state: "corrupt", sig, error: error.message, programs: null };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fontIndexes.set(file, result);
  return result;
}

// 누락·손상·악기 미포함을 다른 소리로 감추지 않고 프리셋별로 그대로 돌려준다.
export function fontStatus(spec) {
  const file = requiredFontPath(spec);
  const index = inspectFontIndex(file);
  const base = { file, name: path.basename(file) };
  if (index.state === "missing")
    return { ...base, available: false, state: "missing", reason: "파일 미설치" };
  if (index.state === "corrupt")
    return { ...base, available: false, state: "corrupt", reason: index.error ?? "파일 손상 또는 지원하지 않는 형식" };
  const bank = spec?.bank ?? 0;
  const program = spec?.program ?? spec?.gm;
  if (Number.isInteger(program) && !index.programs.has((bank << 8) | program)) {
    return {
      ...base, available: false, state: "program-missing",
      reason: `bank ${bank}, program ${program} 악기 미포함`
    };
  }
  return { ...base, available: true, state: "installed", reason: null };
}

export function sf2Available() {
  return fontStatus({ font: "default.sf2", bank: 0, program: 0 }).available;
}

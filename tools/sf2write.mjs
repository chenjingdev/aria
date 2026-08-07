// 최소 SF2 인코더 — aria의 sf2.js 파서(및 SF2.01 스펙)와 호환되는 파일을 생성한다.
// 지원: 모노 16비트 샘플, 악기별 글로벌 존(엔벨로프), 키/벨로시티 존, 루프(sampleModes 1).
import fs from "node:fs";

const GEN = { keyRange: 43, velRange: 44, sampleModes: 54, sampleID: 53, instrument: 41,
  attackVolEnv: 34, releaseVolEnv: 38, initialAttenuation: 48 };

const padName = s => { const b = Buffer.alloc(20); b.write(String(s).slice(0, 19), "ascii"); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const genRec = (op, amount) => { const b = Buffer.alloc(4); b.writeUInt16LE(op); b.writeUInt16LE(amount & 0xffff, 2); return b; };
const chunk = (id, data) => {
  const body = Buffer.concat(Array.isArray(data) ? data : [data]);
  const pad = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(id, "ascii"), u32(body.length), body, pad]);
};
const list = (kind, chunks) => chunk("LIST", [Buffer.from(kind, "ascii"), ...chunks]);

// samples: [{name, pcm:Int16Array, sampleRate, origPitch, loopStart, loopEnd, loop:bool}] (loop*는 샘플 내 상대 인덱스)
// instruments: [{name, globalGens:[[op,amount]...], zones:[{keyLo,keyHi,velLo,velHi,sampleIdx,loop:bool}]}]
// presets: [{name, bank, program, instIdx}]
export function writeSf2({ outPath, infoName, samples, instruments, presets }) {
  // ── sdta: 샘플 병합 (각 샘플 뒤 46 제로워드 — 스펙 요구) ──
  const GUARD = 46;
  const totalWords = samples.reduce((s, x) => s + x.pcm.length + GUARD, 0);
  const smpl = Buffer.alloc(totalWords * 2);
  const offsets = [];
  let cur = 0;
  for (const s of samples) {
    offsets.push(cur);
    Buffer.from(s.pcm.buffer, s.pcm.byteOffset, s.pcm.length * 2).copy(smpl, cur * 2);
    cur += s.pcm.length + GUARD;
  }

  // ── shdr (46B × (샘플수+1)) ──
  const shdrRecs = samples.map((s, i) => {
    const start = offsets[i], end = start + s.pcm.length;
    const b = Buffer.alloc(46);
    padName(s.name).copy(b, 0);
    b.writeUInt32LE(start, 20); b.writeUInt32LE(end, 24);
    b.writeUInt32LE(start + Math.min(s.loopStart, s.pcm.length - 1), 28);
    b.writeUInt32LE(start + Math.min(s.loopEnd, s.pcm.length), 32); // 스펙상 dwEndloop == dwEnd 허용

    b.writeUInt32LE(s.sampleRate, 36);
    b.writeUInt8(s.origPitch, 40); b.writeInt8(0, 41);
    b.writeUInt16LE(0, 42); b.writeUInt16LE(1, 44); // link=0, type=1(mono)
    return b;
  });
  const eos = Buffer.alloc(46); padName("EOS").copy(eos, 0);
  shdrRecs.push(eos);

  // ── inst/ibag/igen ──
  const igen = [], ibag = [], instRecs = [];
  for (const inst of instruments) {
    const rec = Buffer.alloc(22);
    padName(inst.name).copy(rec, 0);
    rec.writeUInt16LE(ibag.length, 20);
    instRecs.push(rec);
    if (inst.globalGens?.length) { // 글로벌 존: sampleID 없는 첫 존
      ibag.push([igen.length, 0]);
      for (const [op, amt] of inst.globalGens) igen.push(genRec(op, amt));
    }
    for (const z of inst.zones) {
      ibag.push([igen.length, 0]);
      // 생략된 범위는 전체(0~127)로 — undefined|<<8 이 [0,0]이 되어 존 전체가 무음이 되는 함정 방지
      igen.push(genRec(GEN.keyRange, (z.keyLo ?? 0) | ((z.keyHi ?? 127) << 8))); // keyRange는 반드시 첫 번째
      igen.push(genRec(GEN.velRange, (z.velLo ?? 0) | ((z.velHi ?? 127) << 8)));
      if (z.loop) igen.push(genRec(GEN.sampleModes, 1));
      igen.push(genRec(GEN.sampleID, z.sampleIdx)); // sampleID는 반드시 마지막
    }
  }
  const eoi = Buffer.alloc(22); padName("EOI").copy(eoi, 0); eoi.writeUInt16LE(ibag.length, 20);
  instRecs.push(eoi);
  ibag.push([igen.length, 0]); // 터미널 bag
  const ibagBuf = ibag.map(([g, m]) => Buffer.concat([u16(g), u16(m)]));

  // ── phdr/pbag/pgen ──
  const pgen = [], pbag = [], phdrRecs = [];
  for (const p of presets) {
    const b = Buffer.alloc(38);
    padName(p.name).copy(b, 0);
    b.writeUInt16LE(p.program, 20); b.writeUInt16LE(p.bank, 22);
    b.writeUInt16LE(pbag.length, 24); // library/genre/morphology = 0
    phdrRecs.push(b);
    pbag.push([pgen.length, 0]);
    pgen.push(genRec(GEN.instrument, p.instIdx)); // instrument는 마지막(유일) 제너레이터
  }
  const eop = Buffer.alloc(38); padName("EOP").copy(eop, 0); eop.writeUInt16LE(pbag.length, 24);
  phdrRecs.push(eop);
  pbag.push([pgen.length, 0]);
  const pbagBuf = pbag.map(([g, m]) => Buffer.concat([u16(g), u16(m)]));

  const termGen = genRec(0, 0);               // pgen/igen 터미널(4B 제로)
  const termMod = Buffer.alloc(10);           // pmod/imod 터미널(10B 제로)

  const ifil = Buffer.concat([u16(2), u16(1)]);
  const ztext = s => { const b = Buffer.from(s + "\0", "ascii"); return b.length % 2 ? Buffer.concat([b, Buffer.alloc(1)]) : b; };

  const out = chunk("RIFF", [
    Buffer.from("sfbk", "ascii"),
    list("INFO", [
      chunk("ifil", ifil),
      chunk("isng", ztext("EMU8000")),
      chunk("INAM", ztext(infoName)),
      chunk("ICOP", ztext("Philharmonia Orchestra samples (philharmonia.co.uk) - free for use in projects"))
    ]),
    list("sdta", [chunk("smpl", smpl)]),
    list("pdta", [
      chunk("phdr", phdrRecs),
      chunk("pbag", pbagBuf),
      chunk("pmod", termMod),
      chunk("pgen", [...pgen, termGen]),
      chunk("inst", instRecs),
      chunk("ibag", ibagBuf),
      chunk("imod", termMod),
      chunk("igen", [...igen, termGen]),
      chunk("shdr", shdrRecs)
    ])
  ]);
  fs.writeFileSync(outPath, out);
  return { bytes: out.length, samples: samples.length, sampleWords: totalWords };
}

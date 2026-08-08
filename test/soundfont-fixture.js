// 테스트 전용 초소형 SoundFont. 외부 다운로드·사용자 홈 디렉터리에 의존하지 않는다.
// 음질을 평가하는 자산이 아니라 parser/renderer/control-flow 회귀를 재현하는 CC0 생성 톤이다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSf2 } from "../tools/sf2write.mjs";

export function createTestSoundfonts(label = "aria-test-sf2") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-${process.pid}-`));
  const sampleRate = 44100;
  const length = 2048;
  const pcm = new Int16Array(length);
  // 정확히 16주기가 들어가 루프 경계가 이어지는 작은 사인 톤.
  for (let i = 0; i < length; i++) pcm[i] = Math.round(Math.sin(2 * Math.PI * 16 * i / length) * 12000);
  const defaultPath = path.join(root, "default.sf2");
  const samples = [{
    name: "AriaTestTone", pcm, sampleRate, origPitch: 60,
    loopStart: 0, loopEnd: length, loop: true
  }];
  const instruments = [{
    name: "AriaTestInstrument", globalGens: [],
    zones: [{ keyLo: 0, keyHi: 127, velLo: 0, velHi: 127, sampleIdx: 0, loop: true }]
  }];
  const presets = [
    ...Array.from({ length: 128 }, (_, program) => ({ name: `GM${program}`, bank: 0, program, instIdx: 0 })),
    ...[0, 24, 25, 26, 32, 40].map(program => ({ name: `Drum${program}`, bank: 128, program, instIdx: 0 }))
  ];
  writeSf2({
    outPath: defaultPath,
    infoName: "Aria Generated Test SoundFont",
    copyright: "Generated test tone dedicated to the public domain under CC0-1.0",
    samples, instruments, presets
  });
  for (const name of [
    "salamander.sf2", "salamander-kit.sf2", "vsco.sf2",
    "philharmonia.sf2", "phil-winds.sf2", "phil-brass.sf2", "phil-perc.sf2"
  ])
    fs.copyFileSync(defaultPath, path.join(root, name));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    root,
    defaultPath,
    dataDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

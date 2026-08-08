import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  augmentAllSfz,
  analyzeRuntimeSfz,
  detachRawTake,
  normalizeOfficialSfz,
  prepareSalamanderPack,
  repairRuntimeSfz,
  safeTarEntry,
  sfzSampleReferences,
  verifyPreparedSalamander
} from "../tools/prepare-salamander-sfz.mjs";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

function run(program, args, options = {}) {
  const child = spawnSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  assert.equal(child.status, 0, `${program} ${args.join(" ")}\n${child.stderr}`);
}

function tinyWav(file, frequency = 440) {
  const rate = 8000, frames = 800, channels = 1, bytes = frames * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + bytes, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * channels * 2, 28); buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(bytes, 40);
  for (let index = 0; index < frames; index++)
    buffer.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * frequency / rate) * 8000), 44 + index * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
}

function fixtureArchive(root) {
  const source = path.join(root, "source");
  const wav = [
    "OH/kick_OH_F_1.wav",
    "OH/kick_OH_F_2.wav",
    "OH/hihatOpen_OH_FF_1.wav",
    "OH/hihatOpen_OH_FF_2.wav",
    "OH/snare_OH_F_1.wav"
  ];
  wav.forEach((file, index) => tinyWav(path.join(source, file), 220 + index * 40));
  const all = [
    "// fixture based on the official grouping shape",
    "<group> key=36 loop_mode=one_shot lovel=1 hivel=127 off_by=1 off_mode=fast",
    "<region> sample=OH\\kick_OH_F_1.wav lorand=0 hirand=1",
    "<group> key=46 loop_mode=one_shot lovel=1 hivel=127 group=1",
    "<region> sample=OH\\hihatOpen_OH_FF_1.wav lorand=0 hirand=1",
    "<group> key=38 loop_mode=one_shot lovel=1 hivel=127 seq_length=1",
    "<region> sample=OH\\snare_OH_F_1.wav seq_position=1",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(source, "ALL.sfz"), all);
  fs.writeFileSync(path.join(source, "REAMDE"), "Licence: CC-by-sa\nhttp://creativecommons.org/licenses/by-sa/3.0/\n");
  const archive = path.join(root, "salamander.tar.bz2");
  run("tar", ["-cjf", archive, "OH", "ALL.sfz", "REAMDE"], { cwd: source });
  return { archive, wav, all };
}

await test("tar path traversal과 특수 경로를 거부한다", () => {
  for (const unsafe of ["../escape.wav", "/tmp/escape.wav", "C:/escape.wav", "OH\\escape.wav", "OH//escape.wav", "OH/./escape.wav"])
    assert.throws(() => safeTarEntry(unsafe), error => error.code === "ARCHIVE_PATH_UNSAFE");
  assert.deepEqual(safeTarEntry("OH/snare_OH_F_1.wav"), {
    path: "OH/snare_OH_F_1.wav", directory: false
  });
});

await test("공식 Windows sample 경로를 sfizz용 POSIX 상대 경로로 바꾼다", () => {
  const normalized = normalizeOfficialSfz("<region> sample=OH\\kick_OH_F_1.wav lorand=0 hirand=1\r\n");
  assert.match(normalized, /sample=\.\.\/samples\/OH\/kick_OH_F_1\.wav/);
  assert.deepEqual(sfzSampleReferences(normalized), ["../samples/OH/kick_OH_F_1.wav"]);
  for (const unsafe of [
    "<region> sample=../../outside.wav", "<region> sample=/tmp/outside.wav",
    "#include outside.sfz", "<control> default_path=../../"
  ]) assert.throws(() => normalizeOfficialSfz(unsafe), error => error.code === "SFZ_PATH_UNSAFE" || error.code === "ARCHIVE_PATH_UNSAFE");
});

await test("잘못된 random 숫자·공백·겹침과 velocity 무음을 일반 규칙으로 교정한다", () => {
  const broken = normalizeOfficialSfz([
    "<group> key=64 lovel=60 hivel=127 loop_mode=one_shot",
    "<region> sample=OH\\bellchime_F_1.wav lorand=0 hirand=0.33",
    "<region> sample=OH\\bellchime_F_2.wav lorand=0.33 hirand=0.66s",
    "<region> sample=OH\\bellchime_F_3.wav lorand=0.66 hirand=60",
    ""
  ].join("\n"));
  const before = analyzeRuntimeSfz(broken);
  assert.ok(before.invalidRandomValues > 0 || before.randomOverlaps > 0);
  assert.equal(before.velocityGaps, 59);
  const repaired = repairRuntimeSfz(broken);
  for (const [name, value] of Object.entries(repaired.analysis))
    if (!["groups", "regions"].includes(name)) assert.equal(value, 0, name);
  assert.match(repaired.text, /lovel=1 hivel=127/);
  assert.match(repaired.text, /lorand=0\.33333333 hirand=0\.66666667/);
});

await test("닫힌 하이햇과 반열림 7단계를 CC64 0~127에서 겹치지 않게 분리한다", () => {
  const ranges = [[2,18],[19,36],[37,54],[55,72],[73,90],[91,108],[109,127]];
  const source = [
    "<group> key=42 lovel=1 hivel=127 loop_mode=one_shot",
    "<region> sample=../samples/OH/hihatClosed_OH_P_1.wav",
    ...ranges.flatMap(([lo, hi], index) => [
      `<group> key=42 lovel=1 hivel=127 loop_mode=one_shot locc64=${lo} hicc64=${hi}`,
      `<region> sample=../samples/OH/hihatSemiOpen${index + 1}_OH_P_1.wav`
    ]),
    ""
  ].join("\n");
  const repaired = repairRuntimeSfz(source);
  assert.equal(repaired.repairs.closedHiHatCcRanges, 1);
  assert.match(repaired.text, /hivel=127[^\n]*locc64=0 hicc64=1/);
  assert.equal(repaired.analysis.cc64Gaps, 0);
  assert.equal(repaired.analysis.cc64Overlaps, 0);
  assert.equal(repaired.analysis.velocityGaps, 0);
  assert.equal(repaired.analysis.velocityOverlaps, 0);
});

await test("공식 ALL에서 빠진 take를 같은 random 그룹에 균등 편입한다", () => {
  const normalized = normalizeOfficialSfz([
    "<group> key=36 loop_mode=one_shot",
    "<region> sample=OH\\kick_OH_F_1.wav lorand=0 hirand=0.5",
    "<region> sample=OH\\kick_OH_F_2.wav lorand=0.5 hirand=1",
    ""
  ].join("\n"));
  const all = [
    "../samples/OH/kick_OH_F_1.wav",
    "../samples/OH/kick_OH_F_2.wav",
    "../samples/OH/kick_OH_F_3.wav"
  ];
  const result = augmentAllSfz(normalized, all);
  assert.deepEqual(result.beforeMissing, ["../samples/OH/kick_OH_F_3.wav"]);
  assert.equal(new Set(sfzSampleReferences(result.text)).size, 3);
  assert.match(result.text, /lorand=0\.33333333 hirand=0\.66666667/);
});

await test("44초 미편집 kick raw take를 kit RR에서 분리하고 나머지 random 구간을 복구한다", () => {
  const normalized = normalizeOfficialSfz([
    "<group> key=35 loop_mode=one_shot lovel=1 hivel=39",
    "<region> sample=OH\\kick_OH_P_1.wav lorand=0 hirand=0.5",
    "<region> sample=OH\\kick_OH_P_2.wav lorand=0.5 hirand=1",
    ""
  ].join("\n"));
  const detached = detachRawTake(normalized);
  assert.equal(detached.removed, 1);
  assert.doesNotMatch(detached.text, /kick_OH_P_1/);
  const repaired = repairRuntimeSfz(detached.text);
  assert.match(repaired.text, /kick_OH_P_2\.wav lorand=0 hirand=1/);
  assert.equal(repaired.analysis.randomGaps, 0);
  assert.equal(repaired.analysis.randomOverlaps, 0);
});

const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aria-salamander-prepare-test-")));
try {
  const fixture = fixtureArchive(temporary);
  await test("WAV 전수·공식 SFZ·RR/choke를 보존하고 ALL-full에 누락 0개를 만든다", async () => {
    const output = path.join(temporary, "prepared-a");
    const result = await prepareSalamanderPack({
      archive: fixture.archive,
      output,
      expectedWavCount: fixture.wav.length,
      expectedOfficialSfz: ["ALL.sfz"],
      skipEngineSmoke: true
    });
    assert.equal(result.manifest.counts.wav, 5);
    assert.equal(result.manifest.counts.officialSfz, 1);
    assert.equal(result.manifest.counts.officialAllUniqueSamples, 3);
    assert.equal(result.manifest.counts.fullAllUniqueSamples, 5);
    assert.equal(result.manifest.counts.initiallyUnreferenced, 2);
    assert.ok(fs.existsSync(path.join(output, "official", "ALL.sfz")));
    assert.ok(fs.existsSync(path.join(output, "official", "REAMDE")));
    const verification = verifyPreparedSalamander(output, fixture.wav.length);
    assert.equal(verification.missingSamples, 0);
    assert.equal(verification.missingReferences, 0);
    assert.equal(verification.unmappedFull, 0);
    assert.equal(verification.foreignReferences, 0);
    assert.equal(verification.invalidRandomValues, 0);
    assert.equal(verification.randomGaps, 0);
    assert.equal(verification.randomOverlaps, 0);
    assert.equal(verification.velocityGaps, 0);
    assert.equal(verification.velocityOverlaps, 0);
    assert.equal(verification.invalidSequenceGroups, 0);
    assert.equal(verification.cc64Gaps, 0);
    assert.equal(verification.cc64Overlaps, 0);
    assert.ok(verification.randomRegions > 0);
    assert.ok(verification.roundRobinRegions > 0);
    assert.ok(verification.chokeGroups > 0);
    assert.ok(verification.chokeModes > 0);
  });

  await test("준비 결과의 payload checksum이 반복 실행에서도 같다", async () => {
    const output = path.join(temporary, "prepared-b");
    await prepareSalamanderPack({
      archive: fixture.archive,
      output,
      expectedWavCount: fixture.wav.length,
      expectedOfficialSfz: ["ALL.sfz"],
      skipEngineSmoke: true
    });
    assert.equal(
      fs.readFileSync(path.join(temporary, "prepared-a", "catalog", "checksums.json"), "utf8"),
      fs.readFileSync(path.join(output, "catalog", "checksums.json"), "utf8")
    );
  });

  await test("기존 output을 덮어쓰지 않는다", async () => {
    await assert.rejects(() => prepareSalamanderPack({
      archive: fixture.archive, output: path.join(temporary, "prepared-a")
    }), error => error.code === "OUTPUT_EXISTS");
  });
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`\nSalamander pack preparation: ${passed}/${passed} tests passed`);

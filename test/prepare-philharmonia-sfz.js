import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  classifyPhilharmoniaSample,
  parsePhilharmoniaFilename,
  preparePhilharmoniaPack,
  safeArchiveEntry,
  verifyPreparedPhilharmonia
} from "../tools/prepare-philharmonia-sfz.mjs";

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

function makeMp3(file) {
  run("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:duration=0.08", "-ar", "22050", "-ac", "1",
    "-codec:a", "libmp3lame", "-b:a", "64k", "-map_metadata", "-1", "-y", file
  ]);
}

function zipDirectory(source, output, entries = ["."]) {
  run("zip", ["-q", "-X", "-r", output, ...entries], { cwd: source });
}

function makeOuterArchive(root, instruments, emptyFiles = new Set()) {
  const outerRoot = path.join(root, "outer");
  const allSamples = path.join(outerRoot, "all-samples");
  fs.mkdirSync(allSamples, { recursive: true });
  for (const [name, files] of Object.entries(instruments)) {
    const source = path.join(root, `source-${name.replaceAll(" ", "-")}`);
    fs.mkdirSync(source, { recursive: true });
    const seed = path.join(source, ".seed.mp3");
    makeMp3(seed);
    for (const file of files) {
      const target = path.join(source, ...file.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (emptyFiles.has(file)) fs.writeFileSync(target, "");
      else fs.copyFileSync(seed, target);
    }
    fs.rmSync(seed);
    zipDirectory(source, path.join(allSamples, `${name}.zip`), files);
  }
  const archive = path.join(root, "all-samples.zip");
  zipDirectory(outerRoot, archive, ["all-samples"]);
  return archive;
}

await test("archive path traversal과 링크형 경로를 사전에 거부한다", () => {
  for (const unsafe of ["../escape.mp3", "/tmp/escape.mp3", "C:/escape.mp3", "safe\\..\\escape.mp3", "a//b.mp3", "a/./b.mp3"])
    assert.throws(() => safeArchiveEntry(unsafe), error => error.code === "ARCHIVE_PATH_UNSAFE");
  assert.deepEqual(safeArchiveEntry("all-samples/violin.zip"), {
    path: "all-samples/violin.zip", directory: false
  });
});

await test("Philharmonia 파일명에서 음정·길이·셈여림·주법을 해석한다", () => {
  assert.deepEqual(parsePhilharmoniaFilename("violin_Cs4_15_mezzo-forte_arco-normal.mp3"), {
    instrument: "violin", note: "Cs4", midi: 61, duration: "15",
    dynamic: "mezzo-forte", articulation: "arco-normal"
  });
  const percussion = parsePhilharmoniaFilename("snare drum/snare-drum__025_forte_with-snares.mp3");
  assert.equal(percussion.note, null);
  assert.equal(classifyPhilharmoniaSample(percussion).reason, "unpitched-one-shot");
  assert.equal(classifyPhilharmoniaSample(parsePhilharmoniaFilename("violin_C4_phrase_forte_arco-legato.mp3")).reason, "recorded-phrase");
  assert.equal(classifyPhilharmoniaSample(parsePhilharmoniaFilename("violin_C4_1_forte_arco-glissando.mp3")).reason, "moving-pitch-or-effect");
});

const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aria-phil-prepare-test-")));
try {
  const archive = makeOuterArchive(temporary, {
    violin: [
      "violin_C4_1_piano_arco-normal.mp3",
      "violin_D4_1_forte_arco-normal.mp3",
      "violin_C4_phrase_mezzo-forte_arco-legato.mp3",
      "violin_C4_very-long_crescendo_arco-normal.mp3",
      "violin_C4_1_mezzo-forte_arco-glissando.mp3"
    ],
    percussion: ["snare drum/snare-drum__025_forte_with-snares.mp3"]
  });

  await test("nested ZIP 전수를 보존하고 playable SFZ와 clip catalog를 분리한다", async () => {
    const output = path.join(temporary, "prepared-mp3");
    const result = await preparePhilharmoniaPack({
      archive, output, expectedNestedArchives: 2, expectedSamples: 6,
      engineProbe: { supported: true, engine: "sfizz", binarySha256: "fixture", ffmpeg: "fixture" }
    });
    assert.equal(result.manifest.counts.sourceMp3, 6);
    assert.equal(result.manifest.counts.playableSfzSamples, 3);
    assert.equal(result.manifest.counts.clipCatalogSamples, 3);
    assert.equal(result.manifest.counts.instrumentSfzFiles, 2);
    assert.equal(result.manifest.counts.recordedClipSfzFiles, 3);
    assert.equal(result.manifest.counts.sfzFiles, 5);
    assert.equal(result.manifest.audio.playableFormat, "mp3");
    assert.deepEqual(verifyPreparedPhilharmonia(output), result.verification);
    assert.equal(result.verification.missingOriginals, 0);
    assert.equal(result.verification.missingPlayable, 0);
    assert.equal(result.verification.missingSfzSamples, 0);
    assert.equal(result.verification.unmappedPlayable, 0);
    assert.equal(result.verification.velocityHoles, 0);
    assert.equal(result.verification.clipsPlayable, 3);
    const terms = fs.readFileSync(path.join(output, "official", "SOURCE_TERMS.txt"), "utf8");
    assert.match(terms, /philharmonia\.co\.uk\/resources\/sound-samples/);
    assert.match(terms, /must not be sold or made available as-is/);
    const clips = JSON.parse(fs.readFileSync(path.join(output, "catalog", "clips.json"), "utf8"));
    assert.ok(clips.every(clip => clip.sfz && fs.existsSync(path.join(output, ...clip.sfz.split("/")))));
    assert.deepEqual([...new Set(clips.map(clip => clip.reason))].sort(), [
      "moving-pitch-or-effect", "recorded-dynamic-curve", "recorded-phrase"
    ]);
  });

  const oneArchive = makeOuterArchive(path.join(temporary, "fallback-fixture"), {
    flute: ["flute_C4_1_piano_normal.mp3"]
  });
  await test("MP3 미지원 probe에서는 원본을 남기고 재현 가능한 FLAC을 만든다", async () => {
    const common = {
      archive: oneArchive, expectedNestedArchives: 1, expectedSamples: 1,
      engineProbe: { supported: false, engine: "sfizz", binarySha256: "fixture", ffmpeg: "fixture" }
    };
    const first = await preparePhilharmoniaPack({ ...common, output: path.join(temporary, "prepared-flac-a") });
    const second = await preparePhilharmoniaPack({ ...common, output: path.join(temporary, "prepared-flac-b") });
    assert.equal(first.manifest.audio.playableFormat, "flac");
    const a = JSON.parse(fs.readFileSync(path.join(first.output, "catalog", "samples.json"), "utf8"))[0];
    const b = JSON.parse(fs.readFileSync(path.join(second.output, "catalog", "samples.json"), "utf8"))[0];
    assert.match(a.playable, /^audio\/.*\.flac$/);
    assert.ok(fs.existsSync(path.join(first.output, ...a.original.split("/"))), "원본 MP3가 보존되어야 한다");
    assert.equal(a.originalSha256, b.originalSha256);
    assert.equal(a.playableSha256, b.playableSha256);
    assert.equal(
      fs.readFileSync(path.join(first.output, "catalog", "checksums.json"), "utf8"),
      fs.readFileSync(path.join(second.output, "catalog", "checksums.json"), "utf8")
    );
  });

  await test("기존 output을 덮어쓰지 않는다", async () => {
    await assert.rejects(() => preparePhilharmoniaPack({ archive, output: path.join(temporary, "prepared-mp3") }),
      error => error.code === "OUTPUT_EXISTS");
  });

  const defectArchive = makeOuterArchive(path.join(temporary, "source-defect-fixture"), {
    viola: [
      "viola_C4_05_piano_arco-normal.mp3",
      "viola_D4_05_piano_arco-normal.mp3",
      "viola_D4_05_forte_arco-normal.mp3"
    ]
  }, new Set(["viola_D4_05_piano_arco-normal.mp3"]));
  await test("공식 0바이트 MP3는 보존하되 SFZ에 연결하거나 재생 가능으로 세지 않는다", async () => {
    const result = await preparePhilharmoniaPack({
      archive: defectArchive,
      output: path.join(temporary, "prepared-source-defect"),
      expectedNestedArchives: 1,
      expectedSamples: 3,
      expectedSourceDefects: 1,
      engineProbe: { supported: true, engine: "sfizz", binarySha256: "fixture", ffmpeg: "fixture" }
    });
    assert.equal(result.manifest.counts.sourceMp3, 3);
    assert.equal(result.manifest.counts.playableSourceMp3, 2);
    assert.equal(result.manifest.counts.sourceDefects, 1);
    assert.equal(result.manifest.counts.sfzReferences, 2);
    assert.equal(result.verification.sourceDefects, 1);
    assert.equal(result.verification.invalidPlayable, 0);
    assert.equal(result.verification.unmappedPlayable, 0);
    const defects = JSON.parse(fs.readFileSync(path.join(result.output, "catalog", "source-defects.json"), "utf8"));
    assert.equal(defects.length, 1);
    assert.equal(defects[0].reason, "empty-source-file");
    assert.equal(defects[0].playable, undefined);
    const definitions = JSON.parse(fs.readFileSync(path.join(result.output, "catalog", "sfz.json"), "utf8"));
    const sfzText = fs.readFileSync(path.join(result.output, ...definitions[0].file.split("/")), "utf8");
    assert.doesNotMatch(sfzText, /viola_D4_05_piano_arco-normal/);
  });
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`\nPhilharmonia pack preparation: ${passed}/${passed} tests passed`);

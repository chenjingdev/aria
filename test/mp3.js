import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeMp3 } from "../src/mp3.js";
import { wavBuffer } from "../src/renderer.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aria-mp3-"));
const originalFfmpeg = process.env.ARIA_FFMPEG;
const originalPath = process.env.PATH;
let passed = 0;

function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function executable(name, directories) {
  return directories.map(directory => path.join(directory, name)).find(filename => {
    try { fs.accessSync(filename, fs.constants.X_OK); return fs.statSync(filename).isFile(); }
    catch { return false; }
  });
}

console.log("aria MP3 export tests");

try {
  const sampleRate = 44100;
  const left = Float32Array.from({ length: sampleRate }, (_, i) => Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.25);
  const right = Float32Array.from({ length: sampleRate }, (_, i) => Math.sin(2 * Math.PI * 660 * i / sampleRate) * 0.25);
  const wav = wavBuffer(left, right, sampleRate);
  const directory = path.join(root, "선택한 폴더 ' \" $ `");
  fs.mkdirSync(directory);
  const output = path.join(directory, "노래 ' \" $ `.mp3");
  const directories = [...(process.env.PATH || "").split(path.delimiter).filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin"];
  const ffmpeg = executable("ffmpeg", directories);
  const ffprobe = executable("ffprobe", ffmpeg ? [path.dirname(ffmpeg), ...directories] : directories);

  if (ffmpeg && ffprobe) {
    check("encodes real stereo MP3 at 320 kbps in a folder with special characters", () => {
      process.env.ARIA_FFMPEG = ffmpeg;
      writeMp3(wav, output);
      const probe = JSON.parse(execFileSync(ffprobe, [
        "-v", "error", "-show_streams", "-show_format", "-of", "json", output
      ], { encoding: "utf8" }));
      assert.equal(probe.format.format_name, "mp3");
      assert.equal(probe.streams.length, 1);
      assert.equal(probe.streams[0].codec_name, "mp3");
      assert.equal(probe.streams[0].sample_rate, String(sampleRate));
      assert.equal(probe.streams[0].channels, 2);
      assert.equal(probe.streams[0].bit_rate, "320000");
      assert.ok(Number(probe.format.duration) >= 1 && Number(probe.format.duration) < 1.1);
      assert.deepEqual(fs.readdirSync(directory), [path.basename(output)]);
    });

    check("rejects invalid WAV without overwriting an existing MP3 or leaking temporary files", () => {
      const before = fs.readFileSync(output);
      assert.throws(() => writeMp3(Buffer.from("invalid WAV"), output), /MP3 변환에 실패했습니다/);
      assert.deepEqual(fs.readFileSync(output), before);
      assert.deepEqual(fs.readdirSync(directory), [path.basename(output)]);
    });

    check("finds FFmpeg through PATH when no override is configured", () => {
      delete process.env.ARIA_FFMPEG;
      process.env.PATH = path.dirname(ffmpeg);
      writeMp3(wav, output);
      assert.ok(fs.statSync(output).size > 1000);
      assert.deepEqual(fs.readdirSync(directory), [path.basename(output)]);
    });
  } else {
    console.log("  - Real encoding checks skipped: FFmpeg and ffprobe are required");
  }

  check("an invalid encoder override reports setup guidance before creating output", () => {
    process.env.ARIA_FFMPEG = path.join(root, "missing-ffmpeg");
    const before = fs.readdirSync(directory);
    assert.throws(() => writeMp3(wav, output), /FFmpeg를 찾지 못했습니다.*ARIA_FFMPEG/);
    assert.deepEqual(fs.readdirSync(directory), before);
  });

  check("an encoder that leaves partial audio cannot damage an existing export", () => {
    const fakeEncoder = path.join(root, "failing encoder.cjs");
    fs.writeFileSync(fakeEncoder, `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.argv.at(-1), "partial MP3");\nprocess.stderr.write("fixture conversion failure");\nprocess.exit(42);\n`, { mode: 0o755 });
    process.env.ARIA_FFMPEG = fakeEncoder;
    fs.writeFileSync(output, "previous complete export");
    assert.throws(() => writeMp3(wav, output), /MP3 변환에 실패했습니다.*fixture conversion failure/);
    assert.equal(fs.readFileSync(output, "utf8"), "previous complete export");
    assert.deepEqual(fs.readdirSync(directory), [path.basename(output)]);
  });

  check("a missing libmp3lame encoder reports actionable Korean guidance", () => {
    const fakeEncoder = path.join(root, "no-lame.cjs");
    fs.writeFileSync(fakeEncoder, `#!${process.execPath}\nprocess.stderr.write("Unknown encoder 'libmp3lame'");\nprocess.exit(1);\n`, { mode: 0o755 });
    process.env.ARIA_FFMPEG = fakeEncoder;
    assert.throws(() => writeMp3(wav, output), /MP3 인코더\(libmp3lame\)가 없습니다/);
    assert.equal(fs.readFileSync(output, "utf8"), "previous complete export");
    assert.deepEqual(fs.readdirSync(directory), [path.basename(output)]);
  });

  console.log(`\n${passed} MP3 export checks passed`);
} finally {
  if (originalFfmpeg === undefined) delete process.env.ARIA_FFMPEG;
  else process.env.ARIA_FFMPEG = originalFfmpeg;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  fs.rmSync(root, { recursive: true, force: true });
}

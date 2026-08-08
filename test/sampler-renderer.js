import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GeneratorTypes, SampleTypes, SoundBankLoader } from "spessasynth_core";
import { writeSf2 } from "../tools/sf2write.mjs";
import { createTestSoundfonts } from "./soundfont-fixture.js";

let passed = 0;

function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function sinePcm(amplitude, cycles, length = 2048, phase = 0) {
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i++)
    pcm[i] = Math.round(Math.sin(phase + 2 * Math.PI * cycles * i / length) * amplitude);
  return pcm;
}

function exactArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function writeStereoGmFont(outPath) {
  const temporary = `${outPath}.mono-pairs`;
  const length = 2048;
  writeSf2({
    outPath: temporary,
    infoName: "Aria linked-stereo integration fixture",
    copyright: "Generated test tone dedicated to the public domain under CC0-1.0",
    samples: [
      {
        name: "StereoLeft", pcm: sinePcm(12000, 16, length), sampleRate: 44100,
        origPitch: 60, loopStart: 0, loopEnd: length, loop: true
      },
      {
        name: "StereoRight", pcm: sinePcm(6500, 24, length, Math.PI / 5), sampleRate: 44100,
        origPitch: 60, loopStart: 0, loopEnd: length, loop: true
      }
    ],
    instruments: [{
      name: "LinkedStereo", globalGens: [],
      zones: [
        { keyLo: 0, keyHi: 127, velLo: 0, velHi: 127, sampleIdx: 0, loop: true },
        { keyLo: 0, keyHi: 127, velLo: 0, velHi: 127, sampleIdx: 1, loop: true }
      ]
    }],
    presets: [
      ...Array.from({ length: 128 }, (_, program) => ({
        name: `GM${program}`, bank: 0, program, instIdx: 0
      })),
      ...[0, 24, 25, 26, 32, 40].map(program => ({
        name: `Drum${program}`, bank: 128, program, instIdx: 0
      }))
    ]
  });
  const bank = SoundBankLoader.fromArrayBuffer(exactArrayBuffer(fs.readFileSync(temporary)));
  try {
    bank.samples[0].setLinkedSample(bank.samples[1], SampleTypes.leftSample);
    // SF2 stereo pairs also author opposing pan generators on their two instrument zones.
    bank.instruments[0].zones[0].setGenerator(GeneratorTypes.pan, -500);
    bank.instruments[0].zones[1].setGenerator(GeneratorTypes.pan, 500);
    fs.writeFileSync(outPath, Buffer.from(bank.writeSF2()));
  } finally {
    bank.destroySoundBank();
    fs.rmSync(temporary, { force: true });
  }
}

function writeVelocityLimitedFont(outPath) {
  const length = 2048;
  writeSf2({
    outPath,
    infoName: "Aria velocity and missing-sample integration fixture",
    copyright: "Generated test tone dedicated to the public domain under CC0-1.0",
    samples: [
      {
        name: "QuietLayer", pcm: sinePcm(1500, 16, length), sampleRate: 44100,
        origPitch: 60, loopStart: 0, loopEnd: length, loop: true
      },
      {
        name: "LoudLayer", pcm: sinePcm(12000, 16, length), sampleRate: 44100,
        origPitch: 60, loopStart: 0, loopEnd: length, loop: true
      }
    ],
    instruments: [{
      name: "C4VelocityLayers", globalGens: [],
      zones: [
        { keyLo: 60, keyHi: 60, velLo: 0, velHi: 95, sampleIdx: 0, loop: true },
        { keyLo: 60, keyHi: 60, velLo: 96, velHi: 127, sampleIdx: 1, loop: true }
      ]
    }],
    presets: [{ name: "ExactViolin40", bank: 0, program: 40, instIdx: 0 }]
  });
}

function hashChannels(...channels) {
  const hash = crypto.createHash("sha256");
  for (const channel of channels)
    hash.update(Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength));
  return hash.digest("hex");
}

function peak(left, right = left) {
  let value = 0;
  for (let i = 0; i < left.length; i++)
    value = Math.max(value, Math.abs(left[i]), Math.abs(right[i]));
  return value;
}

function assertFiniteStereo(rendered) {
  assert.ok(rendered.left instanceof Float32Array);
  assert.ok(rendered.right instanceof Float32Array);
  assert.equal(rendered.left.length, rendered.right.length);
  for (let i = 0; i < rendered.left.length; i++) {
    assert.ok(Number.isFinite(rendered.left[i]), `left[${i}] is not finite`);
    assert.ok(Number.isFinite(rendered.right[i]), `right[${i}] is not finite`);
  }
}

function assertAllZero(channel) {
  for (const sample of channel) assert.equal(sample, 0);
}

const fixture = createTestSoundfonts("aria-sampler-renderer");

try {
  writeStereoGmFont(fixture.defaultPath);
  writeVelocityLimitedFont(path.join(fixture.root, "philharmonia.sf2"));
  fs.rmSync(path.join(fixture.root, "vsco.sf2"), { force: true });
  process.env.ARIA_SF2 = fixture.defaultPath;
  process.env.ARIA_DATA_DIR = fixture.dataDir;

  // SF2_PATH is fixed when sf2.js is evaluated, so all source imports must happen after ARIA_SF2.
  const { renderRange } = await import("../src/sampler-renderer.js");
  const { validateSong } = await import("../src/song.js");

  const neutralMaster = Object.freeze({
    comp: false,
    limiter: false,
    softClip: false,
    inGain: 1,
    makeup: 1,
    wetGain: 0
  });
  const cleanOptions = extra => ({
    sampleRate: 8000,
    tail: 0,
    master: neutralMaster,
    ...extra
  });
  const note = (pitch = "C4", extras = {}) => ({
    bar: 1, beat: 0, pitch, dur: 1, vel: 100, ...extras
  });
  const songOf = tracks => validateSong({
    title: "sampler integration", bpm: 120, timeSig: [4, 4], tempoMap: [], tracks
  });
  const melodicTrack = (name, preset, notes, extras = {}) => ({
    name, preset, volume: 1, pan: 0, reverb: 0, notes, ...extras
  });

  console.log("sampler-renderer / SpessaSynth integration tests");

  check("uses spessa-sf2 in the production render path and is deterministic", () => {
    const song = songOf([melodicTrack("Piano", "sf-piano-gm", [note()])]);
    const first = renderRange(song, 1, 1, cleanOptions());
    const second = renderRange(song, 1, 1, cleanOptions());
    assert.equal(typeof first?.then, "undefined", "production renderRange must remain synchronous");
    assertFiniteStereo(first);
    assert.ok(peak(first.left, first.right) > 0);
    assert.equal(hashChannels(first.left, first.right), hashChannels(second.left, second.right));
    assert.equal(first.diagnostics.length, 1);
    assert.equal(first.diagnostics[0].engine, "spessa-sf2");
    assert.equal(first.diagnostics[0].effectsEnabled, false);
    assert.equal(first.diagnostics[0].bankTrim.applied, true);
    assert.ok(first.diagnostics[0].maxProcessBlock <= 128);
  });

  check("preserves linked stereo at center and uses balance pan without collapsing it", () => {
    const centerSong = songOf([melodicTrack("Stereo", "sf-piano-gm", [note()], { pan: 0 })]);
    const rightSong = songOf([melodicTrack("Stereo", "sf-piano-gm", [note()], { pan: 1 })]);
    const center = renderRange(centerSong, 1, 1, cleanOptions());
    const hardRight = renderRange(rightSong, 1, 1, cleanOptions());
    assert.ok(center.diagnostics[0].stereoMeanDifference > 1e-5,
      `linked-stereo fixture was collapsed: ${center.diagnostics[0].stereoMeanDifference}`);
    assert.notEqual(hashChannels(center.left), hashChannels(center.right));
    assert.equal(hashChannels(center.right), hashChannels(hardRight.right),
      "pan=1 must preserve the original right channel");
    assert.ok(peak(hardRight.left) < peak(center.left) * 1e-6,
      "pan=1 must silence only the left side");
  });

  check("fails a missing font without falling back to the default font", () => {
    const song = songOf([melodicTrack("Missing", "sf-harp", [note()])]);
    assert.throws(() => renderRange(song, 1, 1, cleanOptions()), error => {
      assert.match(error.message, /vsco\.sf2/);
      assert.match(error.message, /파일 미설치/);
      assert.match(error.message, /자동 대체하지 않았습니다/);
      return true;
    });
  });

  check("fails an exact missing preset without selecting another program", () => {
    const song = songOf([melodicTrack("Missing preset", "sf-viola-phil", [note()])]);
    assert.throws(() => renderRange(song, 1, 1, cleanOptions()), error => {
      assert.match(error.message, /philharmonia\.sf2/);
      assert.match(error.message, /bank 0, program 41 악기 미포함/);
      assert.match(error.message, /자동 대체하지 않았습니다/);
      return true;
    });
  });

  check("fails an exact missing key/sample instead of returning silence", () => {
    const song = songOf([melodicTrack("Missing sample", "sf-violin-phil", [note("C#4")])]);
    assert.throws(() => renderRange(song, 1, 1, cleanOptions()), error => {
      assert.equal(error.code, "SAMPLE_MISSING");
      assert.equal(error.engine, "spessa-sf2");
      assert.match(error.message, /MIDI 61/);
      assert.match(error.message, /무음으로 넘기지 않았습니다/);
      return true;
    });
  });

  check("remaps velocity around 64 before SoundFont layer selection", () => {
    const make = (velocity, velRange) => songOf([melodicTrack(
      "Velocity", "sf-violin-phil", [note("C4", { vel: velocity })], { velRange }
    )]);
    const lowSourceCollapsed = renderRange(make(1, 0), 1, 1, cleanOptions());
    const highSourceCollapsed = renderRange(make(127, 0), 1, 1, cleanOptions());
    const fullRange = renderRange(make(127, 1), 1, 1, cleanOptions());
    assert.equal(hashChannels(lowSourceCollapsed.left, lowSourceCollapsed.right),
      hashChannels(highSourceCollapsed.left, highSourceCollapsed.right),
      "velRange=0 must map both source velocities to MIDI velocity 64");
    assert.ok(peak(fullRange.left, fullRange.right) > peak(highSourceCollapsed.left, highSourceCollapsed.right) * 4,
      "velRange=1 must reach the authored high velocity layer");
  });

  check("rejects unsupported legacy expression controls explicitly", () => {
    // Current song validation no longer persists these fields. Inject them after validation
    // to cover an old in-memory/saved track reaching the production renderer directly.
    const song = songOf([melodicTrack("Legacy", "sf-piano-gm", [note()])]);
    Object.assign(song.tracks[0], {
      attack: 0.1,
      release: 1,
      vibrato: 0.5,
      ensemble: 2
    });
    assert.throws(() => renderRange(song, 1, 1, cleanOptions()), error => {
      assert.equal(error.code, "CAPABILITY_UNSUPPORTED");
      assert.deepEqual(error.controls, ["attack", "release", "vibrato", "ensemble"]);
      assert.match(error.message, /자동으로 흉내 내지 않습니다/);
      return true;
    });
  });

  check("selects the exact GM drum bank through the production renderer", () => {
    const song = songOf([{
      name: "Drums", preset: "sf-band-kit", volume: 1, pan: 0, reverb: 0,
      notes: [note("kick", { dur: 0.25, vel: 120 })]
    }]);
    const rendered = renderRange(song, 1, 1, cleanOptions());
    assertFiniteStereo(rendered);
    assert.ok(peak(rendered.left, rendered.right) > 0);
    assert.equal(rendered.diagnostics.length, 1);
    assert.equal(rendered.diagnostics[0].engine, "spessa-sf2");
    assert.equal(rendered.diagnostics[0].preset, "Drum0");
    assert.equal(rendered.diagnostics[0].font, "salamander-kit.sf2");
  });

  check("groups tracks by exact font while retaining each exact program", () => {
    const song = songOf([
      melodicTrack("GM0", "sf-piano-gm", [note("C4")]),
      melodicTrack("GM4", "sf-epiano", [note("E4")]),
      {
        name: "Other font", preset: "sf-band-kit", volume: 1, pan: 0, reverb: 0,
        notes: [note("kick", { dur: 0.25 })]
      }
    ]);
    const rendered = renderRange(song, 1, 1, cleanOptions());
    const byTrack = new Map(rendered.diagnostics.map(item => [item.track, item]));
    assert.equal(byTrack.get("GM0").preset, "GM0");
    assert.equal(byTrack.get("GM4").preset, "GM4");
    assert.equal(byTrack.get("GM0").bankTrim.declaredPresets, 2);
    assert.equal(byTrack.get("GM4").bankTrim.declaredPresets, 2);
    assert.equal(byTrack.get("Other font").preset, "Drum0");
    assert.equal(byTrack.get("Other font").bankTrim.declaredPresets, 1);
  });

  check("renders exact ranges, intentional tail:0 cuts, and silent note-free ranges", () => {
    const song = songOf([melodicTrack("Range", "sf-piano-gm", [
      note("C4", { bar: 2, beat: 0, dur: 2 })
    ])]);
    const selected = renderRange(song, 2, 2, cleanOptions());
    assert.equal(selected.rangeSec, 2);
    assert.equal(selected.left.length, 16000);
    assert.ok(peak(selected.left, selected.right) > 0);
    assert.equal(selected.diagnostics.length, 1);

    const empty = renderRange(song, 3, 3, cleanOptions());
    assert.equal(empty.rangeSec, 2);
    assert.equal(empty.left.length, 16000);
    assert.equal(empty.diagnostics.length, 0);
    assertAllZero(empty.left);
    assertAllZero(empty.right);

    assert.throws(() => renderRange(song, 3, 2, cleanOptions()), /fromBar|렌더 구간|마디/);
  });

  check("mute, solo priority, and stem selection follow their public contracts", () => {
    const muted = melodicTrack("Muted", "sf-piano-gm", [note("C4")], {
      mute: true, volume: 0.05
    });
    const audible = melodicTrack("Audible", "sf-epiano", [note("E4")]);
    const normal = renderRange(songOf([muted, audible]), 1, 1, cleanOptions());
    assert.deepEqual(normal.diagnostics.map(item => item.track), ["Audible"]);

    const mutedSolo = renderRange(songOf([{ ...muted, name: "MutedSolo", solo: true }, audible]),
      1, 1, cleanOptions());
    assert.deepEqual(mutedSolo.diagnostics.map(item => item.track), ["MutedSolo"]);
    assert.ok(peak(mutedSolo.left, mutedSolo.right) > 0, "solo must take priority over mute");

    const stemQuiet = renderRange(songOf([muted, audible]), 1, 1,
      { sampleRate: 8000, tail: 0, stem: "Muted" });
    const stemLoud = renderRange(songOf([{ ...muted, volume: 1 }, audible]), 1, 1,
      { sampleRate: 8000, tail: 0, stem: "Muted" });
    assert.deepEqual(stemQuiet.diagnostics.map(item => item.track), ["Muted"]);
    assert.ok(peak(stemQuiet.left, stemQuiet.right) > 0, "stem must ignore mute");
    assert.equal(hashChannels(stemQuiet.left, stemQuiet.right),
      hashChannels(stemLoud.left, stemLoud.right), "stem must exclude track volume");
  });

  check("tail sizing only considers tracks selected for the render or stem", () => {
    const short = melodicTrack("Short", "sf-organ", [note("C4")]);
    const mutedLong = {
      name: "Muted long", preset: "sf-orch-kit", volume: 1, pan: 0, reverb: 0, mute: true,
      notes: [note("kick", { dur: 0.25 })]
    };
    const outsideLong = {
      name: "Outside long", preset: "sf-orch-kit", volume: 1, pan: 0, reverb: 0,
      notes: [note("kick", { bar: 2, dur: 0.25 })]
    };
    const song = songOf([short, mutedLong, outsideLong]);
    const full = renderRange(song, 1, 1, { sampleRate: 8000, master: neutralMaster });
    const stem = renderRange(song, 1, 1, { sampleRate: 8000, stem: "Short" });
    assert.ok(Math.abs(full.duration - 4.2) <= 1 / 8000,
      `muted high-release track lengthened full render to ${full.duration}s`);
    assert.ok(Math.abs(stem.duration - 4.2) <= 1 / 8000,
      `unselected high-release track lengthened stem to ${stem.duration}s`);
  });

  console.log(`\n${passed} sampler-renderer integration tests passed`);
} finally {
  fixture.cleanup();
}

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wavBuffer } from "../src/renderer.js";
import { createTestSoundfonts } from "./soundfont-fixture.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function tone(frames, amplitude, cycles, phase = 0) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++)
    out[i] = Math.sin(phase + Math.PI * 2 * cycles * i / frames) * amplitude;
  return out;
}

function writeStereo(file, left, right, sampleRate) {
  fs.writeFileSync(file, wavBuffer(left, right, sampleRate));
}

function peak(left, right = left) {
  let value = 0;
  for (let i = 0; i < left.length; i++) value = Math.max(value, Math.abs(left[i]), Math.abs(right[i]));
  return value;
}

function hashChannels(...channels) {
  const hash = crypto.createHash("sha256");
  for (const channel of channels)
    hash.update(Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength));
  return hash.digest("hex");
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

const sampleRate = 8000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aria-sfizz-renderer-test-"));
const soundfonts = createTestSoundfonts("aria-mixed-sampler-renderer");
const sfz = path.join(root, "instrument.sfz");
const keyswitchSfz = path.join(root, "keyswitch.sfz");
const stereo = path.join(root, "stereo.wav");
const quiet = path.join(root, "quiet.wav");
const loud = path.join(root, "loud.wav");
const drum = path.join(root, "drum.wav");
const longClip = path.join(root, "long-clip.wav");

try {
  process.env.ARIA_SF2 = soundfonts.defaultPath;
  process.env.ARIA_DATA_DIR = soundfonts.dataDir;
  writeStereo(stereo, tone(5000, 0.72, 37), tone(5000, 0.2, 53, 0.31), sampleRate);
  writeStereo(quiet, tone(1500, 0.07, 17), tone(1500, 0.035, 23), sampleRate);
  writeStereo(loud, tone(1500, 0.7, 17), tone(1500, 0.35, 23), sampleRate);
  writeStereo(drum, tone(800, 0.8, 7), tone(800, 0.5, 11), sampleRate);
  writeStereo(longClip, tone(32000, 0.45, 61), tone(32000, 0.2, 79), sampleRate);
  fs.writeFileSync(sfz, [
    "<control> default_path=./",
    "<group> loop_mode=one_shot ampeg_release=0.01",
    "<region> sample=stereo.wav key=60",
    "<region> sample=quiet.wav key=62 hivel=95",
    "<region> sample=loud.wav key=62 lovel=96",
    "<region> sample=drum.wav key=36",
    "<region> sample=quiet.wav key=42 locc64=0 hicc64=1",
    "<region> sample=loud.wav key=42 locc64=2 hicc64=18",
    "<region> sample=long-clip.wav key=63"
  ].join("\n"));
  fs.writeFileSync(keyswitchSfz, [
    "<control> default_path=./",
    "<global> sw_lokey=20 sw_hikey=21 sw_default=20 loop_mode=one_shot",
    "<group> sw_last=20",
    "<region> sample=quiet.wav key=60",
    "<group> sw_last=21",
    "<region> sample=loud.wav key=60"
  ].join("\n"));

  const { assertSfizzSongCoverage, renderRange } = await import("../src/sampler-renderer.js");
  const { validateSong } = await import("../src/song.js");
  const neutralMaster = Object.freeze({
    comp: false, limiter: false, softClip: false, inGain: 1, makeup: 1, wetGain: 0
  });
  const melodicSpec = {
    engine: "sfizz", name: "SFZ fixture", sfz, gm: 0,
    gain: 1 / 0.9, reverb: 0, release: 0.1, velRange: 1
  };
  const drumSpec = {
    engine: "sfizz", name: "SFZ drum fixture", sfz, drum: true,
    pieces: { kick: 36 }, gain: 1 / 0.9, reverb: 0, release: 0.1, velRange: 1
  };
  const clipSpec = {
    engine: "sfizz", name: "SFZ recorded clip fixture", sfz, drum: true, kind: "clip",
    pieces: { play: 63 }, durationSec: 4, tailHintSec: 0.25,
    gain: 1 / 0.9, reverb: 0, release: 0.1, velRange: 1
  };
  const measuredKitSpec = {
    engine: "sfizz", name: "SFZ measured kit fixture", sfz, drum: true, kind: "drum-kit",
    pieces: { kick: 36, long: 63 }, pieceDurationsSec: { kick: 0.1, long: 4 },
    durationSec: 4, maxSampleDurationSec: 4, tailHintSec: 0.25,
    gain: 1 / 0.9, reverb: 0, release: 0.1, velRange: 1
  };
  const controlledKitSpec = {
    engine: "sfizz", name: "SFZ controlled hi-hat fixture", sfz, drum: true, kind: "drum-module",
    pieces: { closed: 42, "semi-open": 42 },
    pieceControls: {
      closed: [{ controller: 64, value: 0 }],
      "semi-open": [{ controller: 64, value: 10 }]
    },
    pieceDurationsSec: { closed: 0.125, "semi-open": 0.125 },
    gain: 1 / 0.9, reverb: 0, release: 0.1, velRange: 1
  };
  const pitchedSourceMetadataSpec = {
    ...melodicSpec, name: "SFZ pitched source-duration fixture",
    maxSampleDurationSec: 77, tailHintSec: 0.5
  };
  const keyswitchSpec = {
    ...melodicSpec, name: "SFZ keyswitch fixture", sfz: keyswitchSfz,
    articulations: {
      sustain: { label: "Sustain (길게 이어 연주)", keyswitch: { key: 20, velocity: 90 } },
      staccato: { label: "Staccato (짧게 끊어 연주)", keyswitch: { key: 21, velocity: 90 } }
    },
    defaultArticulation: "sustain"
  };
  const samplerPresets = {
    "test-sfz": melodicSpec,
    "test-sfz-drums": drumSpec,
    "test-sfz-clip": clipSpec,
    "test-sfz-measured-kit": measuredKitSpec,
    "test-sfz-controlled-kit": controlledKitSpec,
    "test-sfz-pitched-source-metadata": pitchedSourceMetadataSpec,
    "test-sfz-keyswitch": keyswitchSpec
  };
  const options = extra => ({ sampleRate, tail: 0, master: neutralMaster, samplerPresets, ...extra });
  const note = (pitch = "C4", extras = {}) => ({ bar: 1, beat: 0, pitch, dur: 1, vel: 100, ...extras });
  const baseTrack = (name, notes, extras = {}) => ({
    name, preset: "sf-piano-gm", volume: 1, pan: 0, reverb: 0, notes, ...extras
  });
  const songOf = tracks => validateSong({
    title: "sfizz production integration", bpm: 120, timeSig: [4, 4], tempoMap: [], tracks
  });
  const inject = (song, names = song.tracks.map(() => "test-sfz")) => {
    song.tracks.forEach((track, index) => { track.preset = names[index]; });
    return song;
  };

  console.log("sampler-renderer / sfizz integration tests");

  check("routes a registered SFZ preset to sfizz synchronously and deterministically", () => {
    const song = inject(songOf([baseTrack("SFZ", [note()])]));
    const first = renderRange(song, 1, 1, options());
    const second = renderRange(song, 1, 1, options());
    assert.equal(typeof first?.then, "undefined");
    assertFiniteStereo(first);
    assert.ok(peak(first.left, first.right) > 0.01);
    assert.equal(hashChannels(first.left, first.right), hashChannels(second.left, second.right));
    assert.equal(first.diagnostics.length, 1);
    assert.equal(first.diagnostics[0].engine, "sfizz");
    assert.equal(first.diagnostics[0].asset, "instrument.sfz");
    assert.equal(first.diagnostics[0].invocations, 1);
  });

  check("rejects unsupported legacy track controls in SFZ preflight before rendering", () => {
    // validateSong no longer persists these fields. Inject them afterward to cover
    // an old in-memory track or an internal caller reaching preflight directly.
    const song = inject(songOf([baseTrack("Legacy SFZ controls", [note()])]));
    Object.assign(song.tracks[0], {
      attack: 0.1,
      release: 1,
      vibrato: 0.5,
      ensemble: 2
    });
    assert.throws(() => assertSfizzSongCoverage(song, { samplerPresets }), error => {
      assert.equal(error.code, "CAPABILITY_UNSUPPORTED");
      assert.deepEqual(error.controls, ["attack", "release", "vibrato", "ensemble"]);
      assert.match(error.message, /자동으로 흉내 내지 않습니다/);
      return true;
    });
  });

  check("routes SFZ and SF2 tracks to separate exact engines in one mix", () => {
    const song = songOf([
      baseTrack("SFZ", [note("C4")]),
      baseTrack("SF2", [note("E4")], { preset: "sf-epiano" })
    ]);
    song.tracks[0].preset = "test-sfz";
    const rendered = renderRange(song, 1, 1, options());
    const engines = new Map(rendered.diagnostics.map(item => [item.track, item.engine]));
    assert.equal(engines.get("SFZ"), "sfizz");
    assert.equal(engines.get("SF2"), "spessa-sf2");
    assert.ok(peak(rendered.left, rendered.right) > 0);
  });

  check("preserves authored stereo at center and applies balance pan afterward", () => {
    const center = renderRange(inject(songOf([baseTrack("Center", [note()], { pan: 0 })])), 1, 1, options());
    const right = renderRange(inject(songOf([baseTrack("Right", [note()], { pan: 1 })])), 1, 1, options());
    assert.ok(center.diagnostics[0].stereoMeanDifference > 1e-5);
    assert.notEqual(hashChannels(center.left), hashChannels(center.right));
    assert.ok(peak(right.left) < peak(center.left) * 1e-6);
    assert.equal(hashChannels(center.right), hashChannels(right.right));
  });

  check("applies Aria velocity remap before the SFZ velocity layer decision", () => {
    const make = (velocity, velRange) => inject(songOf([
      baseTrack("Velocity", [note("D4", { vel: velocity })], { velRange })
    ]));
    const sourceLowCollapsed = renderRange(make(1, 0), 1, 1, options());
    const sourceHighCollapsed = renderRange(make(127, 0), 1, 1, options());
    const fullHigh = renderRange(make(127, 1), 1, 1, options());
    assert.equal(hashChannels(sourceLowCollapsed.left, sourceLowCollapsed.right),
      hashChannels(sourceHighCollapsed.left, sourceHighCollapsed.right));
    assert.ok(peak(fullHigh.left, fullHigh.right) > peak(sourceHighCollapsed.left, sourceHighCollapsed.right) * 4);
  });

  check("carries a track's articulation through production renderRange to the selected keyswitch layer", () => {
    const make = articulation => {
      const song = inject(songOf([baseTrack("Keyswitch", [note("C4")])]), ["test-sfz-keyswitch"]);
      song.tracks[0].articulation = articulation;
      return song;
    };
    const sustain = renderRange(make("sustain"), 1, 1, options());
    const staccato = renderRange(make("staccato"), 1, 1, options());
    assert.equal(sustain.diagnostics[0].articulation, "sustain");
    assert.equal(staccato.diagnostics[0].articulation, "staccato");
    assert.notEqual(hashChannels(sustain.left, sustain.right), hashChannels(staccato.left, staccato.right),
      "different keyswitch articulations must produce different PCM");
    assert.ok(peak(staccato.left, staccato.right) > peak(sustain.left, sustain.right) * 4,
      "the production renderer did not reach the separately recorded keyswitch layer");
  });

  check("renders bar-scoped articulation overrides with the note-on articulation and one track mix", () => {
    const song = inject(songOf([baseTrack("Regional Keyswitch", [
      note("C4", { bar: 1 }),
      note("C4", { bar: 2 })
    ])]), ["test-sfz-keyswitch"]);
    song.tracks[0].articulationRegions = [{ from: 2, to: 2, articulation: "staccato" }];

    const rendered = renderRange(song, 1, 2, options());
    assert.equal(rendered.diagnostics.length, 1, "one authored track should keep one diagnostic entry");
    assert.deepEqual(rendered.diagnostics[0].articulations.map(layer => [layer.id, layer.notes]), [
      ["sustain", 1], ["staccato", 1]
    ]);
    assert.equal(rendered.diagnostics[0].invocations, 2);
    assert.equal(rendered.diagnostics[0].engine, "sfizz");
    assert.equal(rendered.diagnostics[0].sfz, "keyswitch.sfz");
    assert.equal(rendered.diagnostics[0].notes, 2);
    assert.equal(rendered.diagnostics[0].sourceEncoding, "pcm16");
    assert.ok(rendered.diagnostics[0].nonzeroSamples > 0);
    assert.ok(rendered.diagnostics[0].stereoMeanDifference > 0);

    const firstPeak = peak(
      rendered.left.subarray(0, 1500), rendered.right.subarray(0, 1500));
    const secondStart = 2 * sampleRate;
    const secondPeak = peak(
      rendered.left.subarray(secondStart, secondStart + 1500),
      rendered.right.subarray(secondStart, secondStart + 1500));
    assert.ok(secondPeak > firstPeak * 4,
      "bar 2 did not switch from the quiet sustain layer to the loud staccato layer");

    const selected = renderRange(song, 2, 2, options());
    assert.equal(selected.diagnostics.length, 1);
    assert.equal(selected.diagnostics[0].articulation, "staccato",
      "a partial render must retain the override active at the selected note onset");
  });

  check("routes a declared SFZ drum piece without an SF2 drum fallback", () => {
    const song = inject(songOf([baseTrack("Drum", [note("C4", { dur: 0.25 })])]), ["test-sfz-drums"]);
    song.tracks[0].notes[0].pitch = "kick";
    const rendered = renderRange(song, 1, 1, options());
    assertFiniteStereo(rendered);
    assert.ok(peak(rendered.left, rendered.right) > 0.01);
    assert.equal(rendered.diagnostics[0].engine, "sfizz");
  });

  check("passes a piece's CC state so same-key hi-hat openness remains selectable", () => {
    const make = piece => {
      const song = songOf([baseTrack("Controlled Hi-hat", [note("C4", { dur: 0.25 })])]);
      song.tracks[0].preset = "test-sfz-controlled-kit";
      song.tracks[0].notes[0].pitch = piece;
      return song;
    };
    const closed = renderRange(make("closed"), 1, 1, options());
    const semiOpen = renderRange(make("semi-open"), 1, 1, options());
    assert.ok(peak(semiOpen.left, semiOpen.right) > peak(closed.left, closed.right) * 4);
    assert.equal(semiOpen.diagnostics[0].controlledNotes, 1);
  });

  check("fails missing SFZ, sample, and exact key coverage without crossing engines", () => {
    const song = inject(songOf([baseTrack("Missing", [note()])]));
    const missingFile = { ...melodicSpec, sfz: path.join(root, "missing.sfz") };
    assert.throws(() => renderRange(song, 1, 1, options({ samplerPresets: { "test-sfz": missingFile } })), error => {
      assert.equal(error.code, "ASSET_MISSING");
      assert.equal(error.engine, "sfizz");
      return true;
    });

    const brokenSfz = path.join(root, "broken.sfz");
    fs.writeFileSync(brokenSfz, "<region> sample=missing.wav key=60\n");
    assert.throws(() => renderRange(song, 1, 1, options({
      samplerPresets: { "test-sfz": { ...melodicSpec, sfz: brokenSfz } }
    })), error => error.code === "SAMPLE_MISSING" && error.engine === "sfizz");

    const unmapped = inject(songOf([baseTrack("Unmapped", [note("G7")])]));
    assert.throws(() => renderRange(unmapped, 1, 1, options()), error => {
      assert.equal(error.code, "SAMPLE_MISSING");
      assert.equal(error.engine, "sfizz");
      assert.match(error.message, /MIDI 103/);
      return true;
    });
  });

  check("preserves exact range, mute/solo, and stem contracts on the sfizz route", () => {
    const selected = baseTrack("Selected", [note("C4", { bar: 2, dur: 2 })]);
    const muted = baseTrack("Muted", [note("C4", { bar: 2 })], { mute: true });
    const song = inject(songOf([selected, muted]));
    const range = renderRange(song, 2, 2, options());
    assert.equal(range.rangeSec, 2);
    assert.equal(range.left.length, 16000);
    assert.deepEqual(range.diagnostics.map(item => item.track), ["Selected"]);
    assert.ok(peak(range.left, range.right) > 0);

    const empty = renderRange(song, 3, 3, options());
    assert.equal(empty.diagnostics.length, 0);
    assert.equal(peak(empty.left, empty.right), 0);

    const stem = renderRange(song, 2, 2, options({ stem: "Muted" }));
    assert.deepEqual(stem.diagnostics.map(item => item.track), ["Muted"]);
    assert.ok(peak(stem.left, stem.right) > 0, "stem must ignore mute");

    const soloSong = inject(songOf([
      baseTrack("Solo", [note()], { solo: true, mute: true }),
      baseTrack("Other", [note()])
    ]));
    const solo = renderRange(soloSong, 1, 1, options());
    assert.deepEqual(solo.diagnostics.map(item => item.track), ["Solo"]);
  });

  check("renders a recorded clip to its real end and sizes only the remaining tail", () => {
    const make = beat => {
      const song = songOf([baseTrack("Recorded Clip", [note("C4", { beat, dur: 0.25 })])]);
      song.tracks[0].preset = "test-sfz-clip";
      song.tracks[0].notes[0].pitch = "play";
      return song;
    };
    const renderOptions = { sampleRate, master: neutralMaster, samplerPresets };
    const early = renderRange(make(0), 1, 1, renderOptions);
    const late = renderRange(make(3), 1, 1, renderOptions);
    assert.ok(Math.abs(early.duration - 4.25) <= 1 / sampleRate,
      `early clip duration mismatch: ${early.duration}`);
    assert.ok(Math.abs(late.duration - 5.75) <= 1 / sampleRate,
      `late clip duration mismatch: ${late.duration}`);
    assert.ok(peak(late.left.subarray(Math.floor(5.45 * sampleRate)),
      late.right.subarray(Math.floor(5.45 * sampleRate))) > 0,
      "late clip tail was truncated before the original recording ended");
  });

  check("rejects a range that starts inside a fixed recorded clip instead of returning silence", () => {
    const song = songOf([baseTrack("Recorded Clip", [note("C4", { dur: 0.25 })])]);
    song.tracks[0].preset = "test-sfz-clip";
    song.tracks[0].notes[0].pitch = "play";
    assert.throws(() => renderRange(song, 2, 2, options()), error => {
      assert.equal(error.code, "CAPABILITY_UNSUPPORTED");
      assert.equal(error.clipTriggerBar, 1);
      assert.equal(error.requestedFromBar, 2);
      assert.match(error.message, /from_bar를 1 이하/);
      return true;
    });

    // 4초 clip은 120bpm에서 정확히 2마디 끝에 종료한다. 종료 경계 뒤는
    // 진행 중인 clip이 아니므로 평소의 빈 range 계약을 유지한다.
    const after = renderRange(song, 3, 3, options());
    assert.equal(after.diagnostics.length, 0);
    assert.equal(peak(after.left, after.right), 0);
  });

  check("uses the triggered drum piece duration instead of the kit-global longest sample", () => {
    const make = piece => {
      const song = songOf([baseTrack("Measured Kit", [note("C4", { beat: 3, dur: 0.25 })])]);
      song.tracks[0].preset = "test-sfz-measured-kit";
      song.tracks[0].notes[0].pitch = piece;
      return song;
    };
    const renderOptions = { sampleRate, master: neutralMaster, samplerPresets };
    const kick = renderRange(make("kick"), 1, 1, renderOptions);
    const long = renderRange(make("long"), 1, 1, renderOptions);
    assert.ok(Math.abs(kick.duration - 4.2) <= 1 / sampleRate,
      `short kick inherited the longest kit sample: ${kick.duration}`);
    assert.ok(Math.abs(long.duration - 5.75) <= 1 / sampleRate,
      `long piece duration mismatch: ${long.duration}`);
    assert.ok(peak(long.left.subarray(Math.floor(5.45 * sampleRate)),
      long.right.subarray(Math.floor(5.45 * sampleRate))) > 0,
      "long kit piece was truncated before its measured sample ended");
  });

  check("does not treat a pitched preset's longest source file as note release", () => {
    const song = songOf([baseTrack("Pitched", [note("C4", { beat: 3, dur: 0.25 })])]);
    song.tracks[0].preset = "test-sfz-pitched-source-metadata";
    const rendered = renderRange(song, 1, 1, { sampleRate, master: neutralMaster, samplerPresets });
    assert.ok(Math.abs(rendered.duration - 4.2) <= 1 / sampleRate,
      `pitched source duration incorrectly extended the note: ${rendered.duration}`);
  });

  console.log(`\n${passed} sampler-renderer / sfizz integration tests passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  soundfonts.cleanup();
}

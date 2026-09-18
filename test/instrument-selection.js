import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectSfizzPreset } from "../src/sfizz-engine.js";
import { findPresetCandidates } from "../src/instrument-selection.js";
import { wavBuffer } from "../src/renderer.js";
import { measureNoteResponse, probeSfizzInstrument } from "../src/instrument-probe.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-instrument-selection-"));
let passed = 0;
const test = (name, run) => { run(); console.log(`  ✓ ${name}`); passed++; };
try {
  fs.writeFileSync(path.join(dir, "tone.wav"), wavBuffer(new Float32Array(64).fill(.1), new Float32Array(64).fill(.1), 44100));
  const region = '<region> sample=tone.wav lokey=60 hikey=62 lovel=1 hivel=70 ampeg_release=0.5\n<region> sample=tone.wav lokey=65 hikey=66 lovel=1 hivel=127 ampeg_release=0.5';
  const make = (name, contents, extra = {}) => {
    const file = path.join(dir, name + ".sfz"); fs.writeFileSync(file, contents);
    return { engine: "sfizz", sfz: file, ...extra };
  };
  const plain = make("plain", region);
  test("response measurements distinguish a late attack and a ringing tail", () => {
    const rate = 1000, late = new Float32Array(1500), immediate = new Float32Array(1500);
    late.fill(.2, 160, 400); immediate.fill(.2, 100, 350);
    const a = measureNoteResponse({ left: late, right: late }, 100, 350, rate);
    const b = measureNoteResponse({ left: immediate, right: immediate }, 100, 350, rate);
    assert.ok(b.earlyRelativeDb > a.earlyRelativeDb + 20);
    const ringing = new Float32Array(immediate); ringing.fill(.2, 350, 800);
    const c = measureNoteResponse({ left: ringing, right: ringing }, 100, 350, rate);
    assert.ok(c.spillRelativeDb > b.spillRelativeDb + 20);
    assert.throws(() => probeSfizzInstrument(plain, { pitch: 60, duration: 20 }), /0.05~2/);
  });
  const switched = make("switched", '<group> sw_last=36 sw_default=36\n' + region, {
    articulations: { sustain: { keyswitch: 36 } }, defaultArticulation: "sustain"
  });
  test("sample coverage preserves pitch holes and velocity-dependent gaps", () => {
    const v = inspectSfizzPreset(plain).articulations[0];
    assert.deepEqual(v.keyRanges, [[60, 62], [65, 66]]);
    assert.deepEqual(v.safeRanges, [[65, 66]]);
  });
  test("fixed keyswitch and standalone voices with identical playback definitions group together", () => {
    assert.equal(inspectSfizzPreset(plain).articulations[0].soundKey, inspectSfizzPreset(switched).articulations[0].soundKey);
  });
  test("same samples with a different release or gain are not collapsed", () => {
    const other = make("other", region.replaceAll("release=0.5", "release=1.5"));
    const key = inspectSfizzPreset(plain).articulations[0].soundKey;
    assert.notEqual(key, inspectSfizzPreset(other).articulations[0].soundKey);
    assert.notEqual(key, inspectSfizzPreset({ ...plain, gain: 2 }).articulations[0].soundKey);
  });
  test("unselected keyswitch and CC regions cannot advertise false coverage", () => {
    const spec = make("cc", '<group> sw_last=36 sw_default=36\n' + region
      + '\n<group> sw_last=37\n<region> sample=tone.wav key=80\n<group> locc1=64\n<region> sample=tone.wav key=90',
    { articulations: { a: { keyswitch: 36 } }, defaultArticulation: "a" });
    assert.deepEqual(inspectSfizzPreset(spec).articulations[0].keyRanges, [[60, 62], [65, 66]]);
  });
  test("fixed CC values affecting the same sample are distinct sounds", () => {
    const spec = make("cc-colors", region, { articulations: {
      dark: { cc: [{ controller: 1, value: 20 }] }, bright: { cc: [{ controller: 1, value: 100 }] }
    }, defaultArticulation: "dark" });
    const voices = inspectSfizzPreset(spec).articulations;
    assert.notEqual(voices[0].soundKey, voices[1].soundKey);
  });
  const node = id => ({ id, kind: "instrument", instrument: "Flute", unit: "solo", source: id, sourceRank: id === "preferred" ? 0 : 2, spec: { articulation: "sustain" } });
  const nodes = [node("preferred"), node("good"), node("duplicate"), { ...node("wrong-section"), unit: "section" }];
  const song = { title: "fixture", bpm: 120, timeSig: [4, 4], tracks: [{ name: "lead", preset: "preferred", velRange: 1,
    notes: [{ bar: 1, beat: 0, pitch: "C5", vel: 110, dur: 1 }] }] };
  const inspect = id => ({ coverageVerified: true, articulations: [{ id: null, variant: "sustain", soundKey: id === "preferred" ? "bad" : "same",
    range: "C4–C6", coverage: [{ keys: [60, 84], velocity: id === "preferred" ? [1, 70] : [1, 127] }] }] });
  test("passage coverage outranks source preference and duplicate aliases do not consume slots", () => {
    const before = JSON.stringify(song);
    const r = findPresetCandidates(song, { track: "lead" }, { nodes, inspect, isAvailable: () => true });
    assert.equal(r.rawCandidates, 3); assert.equal(r.uniqueSounds, 2); assert.equal(r.compatibleSounds, 1);
    assert.equal(r.candidates[0].missingNotes, 0); assert.equal(r.candidates[0].equivalents.length, 1);
    assert.equal(r.rejected[0].preset, "preferred"); assert.deepEqual(r.rejected[0].missingPitches, ["C5"]);
    assert.equal(JSON.stringify(song), before);
  });
  test("actual velocity range is used, and unknown coverage is not reported as verified", () => {
    const soft = structuredClone(song); soft.tracks[0].velRange = 0;
    const r = findPresetCandidates(soft, { track: "lead" }, { nodes, inspect: id => id === "duplicate" ? { coverageVerified: false } : inspect(id), isAvailable: () => true });
    assert.equal(r.rejected.length, 0); assert.deepEqual(r.unverified, ["duplicate"]);
    assert.throws(() => findPresetCandidates(song, { track: "lead", from_bar: 0 }), /구간/);
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${passed} instrument selection tests passed`);

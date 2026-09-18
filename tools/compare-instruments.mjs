// Apply only measured short-note articulation changes to a frozen score.
// Usage: node tools/compare-instruments.mjs <benchmark directory>
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { SF_PRESETS } from "../src/presets.js";
import { inspectInstrument } from "../src/instrument-selection.js";
import { openSfizzSession, resolveSfzPath } from "../src/sfizz-engine.js";
import { renderRange, assertSfizzSongCoverage } from "../src/sampler-renderer.js";
import { wavBuffer } from "../src/renderer.js";
import { writeMp3 } from "../src/mp3.js";
import { lufs } from "../src/master.js";
import { noteToMidi, tempoSegments, noteStartBeat, beatToSec, effectiveArticulation, totalBars, validateSong } from "../src/song.js";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: compare-instruments.mjs <benchmark directory>");
const renderOnly = process.env.ARIA_BENCH_RENDER_ONLY;
const original = JSON.parse(fs.readFileSync(path.join(dir, "baseline-song.json")));
const probes = JSON.parse(fs.readFileSync(path.join(dir, "probe-results.json")));
const improved = structuredClone(original);
improved.title = "크리스마스 마을 — 음원 선택 개선";
const report = { protocol: "Short gates ≤ 0.36s; median-pitch discovery, min/median/max pitch cross-register validation (can overlap discovery pitch); ≥2/3 pitches improve early response by 6dB and spill by 6dB. Calibrate changed parts on bars 9–40 only. Preserve every written note, velocity, tempo and section.", changes: [], comparisons: [] };
if (renderOnly && fs.existsSync(path.join(dir, "comparison-results.json")))
  report.comparisons = JSON.parse(fs.readFileSync(path.join(dir, "comparison-results.json"))).comparisons.filter(c => c.prefix !== renderOnly);
const sr = 22050, db = value => 20 * Math.log10(Math.max(value, 1e-12));
const median = xs => [...xs].sort((a,b) => a-b)[Math.floor(xs.length / 2)];
const rms = (pcm, from = 0, to = pcm.left.length) => {
  let sum = 0; for (let i = from; i < to; i++) sum += (pcm.left[i] ** 2 + pcm.right[i] ** 2) / 2;
  return Math.sqrt(sum / Math.max(1, to - from));
};
const segs = tempoSegments(original);
const seconds = note => { const start = noteStartBeat(original, note); return beatToSec(segs, start + note.dur) - beatToSec(segs, start); };
const isSustain = (track, note) => {
  const spec = SF_PRESETS[track.preset], id = effectiveArticulation(track, note.bar) ?? spec.defaultArticulation;
  const term = spec.articulations?.[id]?.originalTerm ?? spec.articulation ?? "sustain";
  return /sustain|vibrato/i.test(term) && !/staccato|spiccato/i.test(term);
};
const monoSong = track => ({ ...original, tracks: [{ ...structuredClone(track), reverb: 0 }] });
const dryOptions = { sampleRate: sr, tail: 1, master: { comp: false, limiter: false, softClip: false, inGain: 1, makeup: 1, wetGain: 0 } };
const scoreIdentity = song => song.tracks.flatMap(t => t.notes.map(n => JSON.stringify(n))).sort();

function holdout(presetId, articulation, pitches) {
  const spec = SF_PRESETS[presetId];
  const session = openSfizzSession(resolveSfzPath(spec).file, sr, { preset: spec });
  try {
    const events = pitches.map((key, i) => ({ key, velocity: 80, gain: 1,
      startSample: Math.round((.2 + i * 2) * sr), endSample: Math.round((.45 + i * 2) * sr) }));
    const pcm = session.renderTrack({ preset: spec, track: { articulation: articulation ?? undefined }, notes: events, length: Math.round((pitches.length * 2 + .5) * sr) });
    return events.map(n => {
      const gate = rms(pcm, n.startSample, n.endSample);
      return { pitch: n.key, early: db(rms(pcm, n.startSample, n.startSample + Math.round(.06 * sr)) / gate),
        spill: db(rms(pcm, n.endSample + Math.round(.1 * sr), n.endSample + Math.round(.3 * sr)) / gate) };
    });
  } finally { session.close(); }
}

for (const track of original.tracks) {
  if (!SF_PRESETS[track.preset] || SF_PRESETS[track.preset].engine !== "sfizz") continue;
  const selected = track.notes.filter(n => seconds(n) <= .36 && isSustain(track, n));
  if (selected.length < 16) continue;
  const discovery = probes.tones.filter(t => t.track === track.name && !t.error);
  const baseline = discovery.find(t => t.preset === track.preset && /sustain|vibrato/i.test(t.variant));
  if (!baseline) continue;
  const baseMeasurement = baseline.measurements.find(m => m.velocity === 80);
  const candidates = discovery.filter(t => /staccato|spiccato/i.test(t.variant) && t.pitch === baseline.pitch)
    .filter(t => { const m=t.measurements.find(m=>m.velocity===80); return m.earlyRelativeDb - baseMeasurement.earlyRelativeDb >= 6
      && baseMeasurement.spillRelativeDb - m.spillRelativeDb >= 6 && Math.abs(t.velocityBoundaryDb) < 6; })
    .sort((a,b) => b.measurements[3].earlyRelativeDb - a.measurements[3].earlyRelativeDb);
  if (!candidates.length) continue;
  const candidate = candidates[0];
  const pitches = selected.map(n => noteToMidi(n.pitch)).sort((a,b) => a-b);
  const holdoutPitches = [pitches[0], median(pitches), pitches.at(-1)];
  const before = holdout(track.preset, baseline.articulation, holdoutPitches);
  const after = holdout(candidate.preset, candidate.articulation, holdoutPitches);
  const wins = before.filter((b,i) => after[i].early - b.early >= 6 && b.spill - after[i].spill >= 6).length;
  const detail = { track: track.name, fromPreset: track.preset, fromArticulation: baseline.articulation, toPreset: candidate.preset, toArticulation: candidate.articulation,
    selectedNotes: selected.length, holdoutBefore: before, holdoutAfter: after, holdoutWins: wins, applied: false };
  report.changes.push(detail);
  if (wins < 2) { console.log(`${track.name}: holdout ${wins}/3, kept original`); continue; }
  const current = improved.tracks.find(t => t.name === track.name);
  const short = structuredClone(track);
  short.name += " · 짧은 주법";
  short.notes = selected;
  short.preset = candidate.preset;
  if (candidate.articulation) short.articulation = candidate.articulation; else delete short.articulation;
  delete short.articulationRegions;
  const selectedIndexes = new Set(track.notes.flatMap((n,i) => selected.includes(n) ? [i] : []));
  current.notes = current.notes.filter((_,i) => !selectedIndexes.has(i));
  const calibrationNotes = selected.filter(n => n.bar >= 9 && n.bar <= 40);
  if (!calibrationNotes.length) throw new Error(`No predefined calibration notes for ${track.name}`);
  const oldPart = { ...structuredClone(track), notes: calibrationNotes };
  const newPart = { ...structuredClone(short), notes: calibrationNotes };
  const oldPcm = renderRange(monoSong(oldPart), 9, 40, dryOptions);
  const newPcm = renderRange(monoSong(newPart), 9, 40, dryOptions);
  const gain = rms(oldPcm) / rms(newPcm);
  const desiredVolume = (short.volume ?? .8) * gain;
  short.volume = Math.min(2, desiredVolume);
  if (desiredVolume > 2) short.gains = [...(short.gains ?? []), { from: 1, to: totalBars(original), db: db(desiredVolume / 2) }];
  improved.tracks.push(short);
  Object.assign(detail, { applied: true, calibrationGainDb: db(gain), calibrationNotes: calibrationNotes.length });
  console.log(`${track.name}: holdout ${wins}/3, ${selected.length} notes, level match ${db(gain).toFixed(2)}dB`);
}
assert.deepEqual(scoreIdentity(improved), scoreIdentity(original), "Written notes changed");
for (const track of original.tracks) assert.deepEqual(
  scoreIdentity({ tracks: improved.tracks.filter(t => t.name === track.name || t.name === track.name + " · 짧은 주법") }),
  scoreIdentity({ tracks: [track] }), `Notes moved between instruments: ${track.name}`);
assert.deepEqual(improved.tempoMap, original.tempoMap);
assert.deepEqual(improved.sections, original.sections);
assertSfizzSongCoverage(improved);
const checked = validateSong(improved);
fs.writeFileSync(path.join(dir, "improved-song.json"), JSON.stringify(checked, null, 2));
report.noteCountPreserved = scoreIdentity(original).length;
report.appliedChanges = report.changes.filter(c => c.applied).length;
fs.writeFileSync(path.join(dir, "comparison-results.json"), JSON.stringify(report, null, 2));

function matchAndWrite(pcmA, pcmB, prefix) {
  const measureA = lufs(pcmA.left, pcmA.right, pcmA.sr), measureB = lufs(pcmB.left, pcmB.right, pcmB.sr);
  if (!Number.isFinite(measureA.integrated) || !Number.isFinite(measureB.integrated)) throw new Error("Cannot level-match silent audio");
  let target = prefix === "04-clarinet" ? -21 : Math.min(measureA.integrated, measureB.integrated);
  const peak = pcm => { let value=0; for(let i=0;i<pcm.left.length;i++)value=Math.max(value,Math.abs(pcm.left[i]),Math.abs(pcm.right[i]));return value; };
  const predictedPeak = Math.max(peak(pcmA) * 10 ** ((target-measureA.integrated)/20), peak(pcmB) * 10 ** ((target-measureB.integrated)/20));
  if (db(predictedPeak) > -1) target -= db(predictedPeak) + 1;
  for (const [kind, pcm, measure] of [["before",pcmA,measureA],["after",pcmB,measureB]]) {
    const gain = 10 ** ((target - measure.integrated) / 20);
    for(let i=0;i<pcm.left.length;i++){pcm.left[i]*=gain;pcm.right[i]*=gain;}
    writeMp3(wavBuffer(pcm.left,pcm.right,pcm.sr),path.join(dir,`${prefix}-${kind}.mp3`));
  }
  report.comparisons.push({ prefix, beforeLufs: measureA.integrated, afterLufs: measureB.integrated, matchedLufs: target,
    finalBeforeLufs: lufs(pcmA.left,pcmA.right,pcmA.sr).integrated, finalAfterLufs: lufs(pcmB.left,pcmB.right,pcmB.sr).integrated,
    beforePeakDb: db(peak(pcmA)), afterPeakDb: db(peak(pcmB)), duration: pcmA.duration });
  fs.writeFileSync(path.join(dir,"comparison-results.json"),JSON.stringify(report,null,2));
}
for (const [prefix,from,to] of [["01-opening",9,24],["02-woodwinds",25,40],["03-return",65,80],["full",1,totalBars(original)],["04-clarinet",33,40]]) {
  if (renderOnly && prefix !== renderOnly) continue;
  console.log(`Rendering ${prefix}: bars ${from}–${to}`);
  const opts = { sampleRate: 44100 };
  const focus = song => prefix === "04-clarinet" ? { ...song, tracks: song.tracks.filter(t => t.name === "클라리넷" || t.name === "클라리넷 · 짧은 주법") } : song;
  matchAndWrite(renderRange(focus(original),from,to,opts),renderRange(focus(checked),from,to,opts),prefix);
}
console.log(path.join(dir,"full-after.mp3"));

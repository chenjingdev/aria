// Reproducible, local sampler benchmark. No live app state or model API calls.
// Usage: node tools/bench-instruments.mjs <frozen-song.json> <output-directory>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SF_PRESETS } from "../src/presets.js";
import { findPresetCandidates, inspectInstrument } from "../src/instrument-selection.js";
import { openSfizzSession, resolveSfzPath } from "../src/sfizz-engine.js";
import { noteToMidi, effectiveArticulation } from "../src/song.js";

const [songFile, destination] = process.argv.slice(2);
if (!songFile || !destination) throw new Error("Usage: bench-instruments.mjs <frozen-song.json> <output-directory>");
fs.mkdirSync(destination, { recursive: true });
const raw = fs.readFileSync(songFile), song = JSON.parse(raw);
const resultsFile = path.join(destination, "probe-results.json");
const scoreSha256 = crypto.createHash("sha256").update(raw).digest("hex");
let previous = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile)) : null;
if (previous && previous.protocolVersion !== 2) {
  fs.renameSync(resultsFile, path.join(destination, `probe-results-protocol-${previous.protocolVersion ?? 1}.json`));
  previous = null;
}
if (previous && previous.scoreSha256 !== scoreSha256) throw new Error("Existing results belong to a different score");
// Rerender on every run: changing an installed sample must not reuse old audio measurements.
const results = { protocolVersion: 2, scoreSha256, probe: { sampleRate: 22050, velocities: [48, 62, 63, 80, 110], gateSeconds: .25, strideSeconds: 2 }, selection: [], tones: [] };
results.selection = [];
const save = () => fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
const db = x => 20 * Math.log10(Math.max(x, 1e-12));
const candidates = new Map();
for (const track of song.tracks) {
  if (!SF_PRESETS[track.preset] || !track.notes.length) continue;
  const trackPitches = track.notes.map(n => noteToMidi(n.pitch)).sort((a,b) => a-b);
  const pitch = trackPitches[Math.floor(trackPitches.length / 2)];
  const currentSpec = SF_PRESETS[track.preset];
  if (currentSpec.engine === "sfizz") {
    const profile = inspectInstrument(track.preset);
    for (const voice of profile.articulations) {
      const notes = track.notes.filter(n => (effectiveArticulation(track, n.bar) ?? currentSpec.defaultArticulation ?? null) === voice.id);
      if (!notes.length) continue;
      candidates.set(track.preset + ":" + voice.id + ":" + pitch, { preset: track.preset, articulation: voice.id, variant: voice.variant,
        source: currentSpec.source, soundKey: voice.soundKey, track: track.name, pitch, baseline: true });
    }
  }
  const bars = track.notes.map(n => n.bar), from_bar = Math.min(...bars), to_bar = Math.max(...bars);
  const requested = [...new Set(track.notes.map(n => {
    const id = effectiveArticulation(track, n.bar) ?? currentSpec.defaultArticulation;
    return currentSpec.articulations?.[id]?.originalTerm ?? currentSpec.articulation ?? "sustain";
  })), "staccato"];
  for (const articulation of [...new Set(requested)]) {
    try {
      const r = findPresetCandidates(song, { track: track.name, from_bar, to_bar, articulation, limit: 20 });
      results.selection.push(r);
      for (const c of r.candidates) {
        const key = c.preset + ":" + c.articulation + ":" + pitch;
        if (candidates.has(key)) continue;
        candidates.set(key, { ...c, track: track.name, pitch });
      }
    } catch (e) { results.selection.push({ track: track.name, articulation, error: e.message }); }
  }
}
save();
console.log(`Frozen score ${scoreSha256.slice(0, 12)}; ${candidates.size} distinct preset/articulation probes`);
for (const [key, candidate] of candidates) {
  if (results.tones.some(t => t.key === key)) continue;
  const spec = SF_PRESETS[candidate.preset], sr = results.probe.sampleRate;
  const events = results.probe.velocities.map((velocity, i) => ({ key: candidate.pitch, velocity,
    startSample: Math.round((.2 + i * 2) * sr), endSample: Math.round((.45 + i * 2) * sr), gain: 1 }));
  const length = Math.round(10.5 * sr);
  let session;
  try {
    session = openSfizzSession(resolveSfzPath(spec).file, sr, { preset: spec });
    const pcm = session.renderTrack({ preset: spec, track: { articulation: candidate.articulation ?? undefined }, notes: events, length });
    const measurements = events.map(event => {
      const rms = (a, b) => {
        let sum = 0; const count = Math.max(1, b - a);
        for (let i = a; i < b; i++) sum += (pcm.left[i] ** 2 + pcm.right[i] ** 2) / 2;
        return Math.sqrt(sum / count);
      };
      const gateRms = rms(event.startSample, event.endSample);
      const earlyRms = rms(event.startSample, event.startSample + Math.round(.06 * sr));
      const spillRms = rms(event.endSample + Math.round(.1 * sr), event.endSample + Math.round(.3 * sr));
      return { velocity: event.velocity, gateDb: db(gateRms), earlyRelativeDb: db(earlyRms / Math.max(1e-12, gateRms)), spillRelativeDb: db(spillRms / Math.max(1e-12, gateRms)) };
    });
    results.tones.push({ key, ...candidate, measurements,
      velocityBoundaryDb: measurements[2].gateDb - measurements[1].gateDb });
    console.log(`${candidate.preset} ${candidate.articulation ?? "default"}: gate ${measurements[3].gateDb.toFixed(1)}dB, early ${measurements[3].earlyRelativeDb.toFixed(1)}dB, spill ${measurements[3].spillRelativeDb.toFixed(1)}dB, 62→63 ${results.tones.at(-1).velocityBoundaryDb.toFixed(1)}dB`);
  } catch (error) {
    results.tones.push({ key, ...candidate, error: error.message });
    console.log(`${key}: ${error.message.slice(0, 160)}`);
  } finally { session?.close(); save(); }
}
console.log(resultsFile);

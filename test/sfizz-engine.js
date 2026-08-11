import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wavBuffer } from "../src/renderer.js";
import {
  assertSfizzCoverage,
  SfizzEngineError,
  openSfizzSession,
  resolveSfizzBinary,
  resolveSfzPath,
  sfzStatus
} from "../src/sfizz-engine.js";
import { assignSfizzChannels, MAX_SFIZZ_MIDI_CHANNELS } from "../src/sfizz-channels.js";

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

function constant(frames, value) {
  return Float32Array.from({ length: frames }, () => value);
}

function writeStereo(file, left, right, sampleRate) {
  fs.writeFileSync(file, wavBuffer(left, right, sampleRate));
}

function hashChannels(...channels) {
  const hash = crypto.createHash("sha256");
  for (const channel of channels)
    hash.update(Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength));
  return hash.digest("hex");
}

function peak(channel) {
  let value = 0;
  for (const sample of channel) value = Math.max(value, Math.abs(sample));
  return value;
}

function mean(channel, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += channel[i];
  return sum / Math.max(1, end - start);
}

function assertFiniteStereo(rendered, length) {
  assert.ok(rendered.left instanceof Float32Array);
  assert.ok(rendered.right instanceof Float32Array);
  assert.equal(rendered.left.length, length);
  assert.equal(rendered.right.length, length);
  for (let i = 0; i < length; i++) {
    assert.ok(Number.isFinite(rendered.left[i]), `left[${i}] is not finite`);
    assert.ok(Number.isFinite(rendered.right[i]), `right[${i}] is not finite`);
  }
}

const sampleRate = 8000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aria-sfizz-test-"));
const sfz = path.join(root, "fixture.sfz");
const keyswitchSfz = path.join(root, "keyswitch.sfz");
const stereo = path.join(root, "stereo.wav");
const rrPlus = path.join(root, "rr-plus.wav");
const rrMinus = path.join(root, "rr-minus.wav");
const soft = path.join(root, "soft.wav");
const loud = path.join(root, "loud.wav");
const drum = path.join(root, "drum.wav");

try {
  writeStereo(stereo, tone(4000, 0.72, 31), tone(4000, 0.21, 47, 0.4), sampleRate);
  writeStereo(rrPlus, constant(500, 0.35), constant(500, 0.12), sampleRate);
  writeStereo(rrMinus, constant(500, -0.35), constant(500, -0.12), sampleRate);
  writeStereo(soft, tone(1000, 0.08, 13), tone(1000, 0.04, 19), sampleRate);
  writeStereo(loud, tone(1000, 0.7, 13), tone(1000, 0.35, 19), sampleRate);
  writeStereo(drum, tone(600, 0.8, 7), tone(600, 0.55, 11), sampleRate);
  fs.writeFileSync(sfz, [
    "<control> default_path=./",
    "<group> loop_mode=one_shot ampeg_attack=0 ampeg_release=0.005",
    "<region> sample=stereo.wav key=60",
    "<region> sample=rr-plus.wav key=61 seq_length=2 seq_position=1",
    "<region> sample=rr-minus.wav key=61 seq_length=2 seq_position=2",
    "<region> sample=soft.wav key=62 hivel=63",
    "<region> sample=loud.wav key=62 lovel=64",
    "<region> sample=drum.wav key=36",
    "<region> sample=soft.wav key=42 locc64=0 hicc64=1",
    "<region> sample=loud.wav key=42 locc64=2 hicc64=18"
  ].join("\n"));
  fs.writeFileSync(keyswitchSfz, [
    "<control> default_path=./",
    "<global> sw_lokey=20 sw_hikey=21 sw_default=20 loop_mode=one_shot",
    "<group> sw_last=20",
    "<region> sample=soft.wav key=60",
    "<group> sw_last=21",
    "<region> sample=loud.wav key=60 hivel=80"
  ].join("\n"));

  console.log("sfizz CLI sidecar adapter tests");

  check("shared channel planner counts permanent bends and reusable straight-note lanes", () => {
    const bent = Array.from({ length: 15 }, (_, index) => ({
      startSample:index * 100, endSample:index * 100 + 50,
      key:60 + index % 12, bend:2, controls:[]
    }));
    const overlapping = assignSfizzChannels([
      ...structuredClone(bent),
      { startSample:0, endSample:200, key:84, bend:0, controls:[] },
      { startSample:100, endSample:300, key:84, bend:0, controls:[] }
    ]);
    assert.equal(overlapping.requiredChannels, 17);
    assert.ok(overlapping.requiredChannels > MAX_SFIZZ_MIDI_CHANNELS);

    const reusable = assignSfizzChannels([
      ...structuredClone(bent),
      { startSample:0, endSample:100, key:84, bend:0, controls:[] },
      { startSample:100, endSample:200, key:84, bend:0, controls:[] }
    ]);
    assert.equal(reusable.requiredChannels, 16);

    const differentKeys = assignSfizzChannels([
      ...structuredClone(bent),
      { startSample:0, endSample:200, key:84, bend:0, controls:[] },
      { startSample:0, endSample:200, key:85, bend:0, controls:[] }
    ]);
    assert.equal(differentKeys.requiredChannels, 16);
  });

  check("resolves and verifies the pinned installed sfizz_render binary", () => {
    const binary = resolveSfizzBinary();
    assert.ok(path.isAbsolute(binary.file));
    assert.equal(binary.commit.length, 40);
    assert.ok(fs.statSync(binary.file).isFile());
  });

  check("reports a standalone SFZ and every static sample as installed", () => {
    const spec = { engine: "sfizz", sfz };
    const resolved = resolveSfzPath(spec);
    assert.equal(resolved.file, fs.realpathSync(sfz));
    const status = sfzStatus(spec);
    assert.equal(status.available, true);
    assert.equal(status.state, "installed");
    assert.equal(status.regions, 8);
    assert.equal(status.samples, 6);
  });

  check("resolves a managed pack only through pinned manifest and entry checksum metadata", () => {
    const packHome = path.join(root, "managed-packs");
    const packRoot = path.join(packHome, "vsco2-ce-sfz");
    fs.mkdirSync(packRoot, { recursive: true });
    const entry = "BassoonSus.sfz";
    const entryFile = path.join(packRoot, entry);
    fs.copyFileSync(sfz, entryFile);
    for (const sample of [stereo, rrPlus, rrMinus, soft, loud, drum])
      fs.copyFileSync(sample, path.join(packRoot, path.basename(sample)));
    const manifestRaw = fs.readFileSync(new URL("../packs/vsco2-ce.json", import.meta.url));
    const manifest = JSON.parse(manifestRaw);
    const entryRaw = fs.readFileSync(entryFile);
    fs.writeFileSync(path.join(packRoot, ".aria-pack.json"), JSON.stringify({
      schemaVersion: 1,
      packId: manifest.id,
      name: manifest.name,
      format: manifest.format,
      installDir: manifest.installDir,
      manifestSha256: crypto.createHash("sha256").update(manifestRaw).digest("hex"),
      source: {
        type: manifest.source.type,
        repositoryUrl: manifest.source.repositoryUrl,
        branch: manifest.source.branch,
        commit: manifest.source.commit,
        tree: manifest.source.tree
      },
      license: {
        spdx: manifest.license.spdx,
        file: manifest.license.file,
        sha256: manifest.license.sha256
      },
      entries: [{
        path: entry,
        size: entryRaw.length,
        sha256: crypto.createHash("sha256").update(entryRaw).digest("hex")
      }]
    }));
    const previous = process.env.ARIA_PACKS_DIR;
    process.env.ARIA_PACKS_DIR = packHome;
    try {
      const spec = { engine: "sfizz", pack: "vsco2-ce", sfz: entry };
      const resolved = resolveSfzPath(spec);
      assert.equal(resolved.file, fs.realpathSync(entryFile));
      assert.equal(sfzStatus(spec).available, true);
      fs.appendFileSync(entryFile, "\n// changed after install\n");
      const changed = sfzStatus(spec);
      assert.equal(changed.available, false);
      assert.equal(changed.state, "pack-unverified");
      assert.equal(changed.code, "PACK_UNVERIFIED");
    } finally {
      if (previous === undefined) delete process.env.ARIA_PACKS_DIR;
      else process.env.ARIA_PACKS_DIR = previous;
    }
  });

  check("renders deterministic finite exact-length stereo and cleans each invocation", () => {
    const session = openSfizzSession(sfz, sampleRate);
    try {
      const request = {
        preset: { engine: "sfizz", sfz }, track: {}, length: 8000,
        notes: [{ startSample: 0, endSample: 2000, key: 60, velocity: 100, bend: 0, gain: 0.75 }]
      };
      const first = session.renderTrack(request);
      const second = session.renderTrack(request);
      assertFiniteStereo(first, 8000);
      assert.ok(peak(first.left) > 0.01);
      assert.notEqual(hashChannels(first.left), hashChannels(first.right));
      assert.equal(hashChannels(first.left, first.right), hashChannels(second.left, second.right));
      assert.equal(first.diagnostics.engine, "sfizz");
      assert.equal(first.diagnostics.sourceEncoding, "pcm16");
      assert.ok(first.diagnostics.sourceFrames >= 8000);
      assert.ok(first.diagnostics.sourceFrames < 8000 + 128);
      assert.equal(first.diagnostics.gain, 0.75);
      assert.deepEqual(fs.readdirSync(session.temporaryDirectory), []);
    } finally {
      const temporary = session.temporaryDirectory;
      session.close();
      assert.equal(fs.existsSync(temporary), false);
    }
  });

  check("keeps SFZ round-robin order inside one CLI render", () => {
    const session = openSfizzSession(sfz, sampleRate);
    try {
      const notes = [0, 1000, 2000, 3000].map(startSample => ({
        startSample, endSample: startSample + 400, key: 61, velocity: 100, bend: 0
      }));
      const rendered = session.renderTrack({ preset: { engine: "sfizz", sfz }, notes, length: 4000 });
      const signs = notes.map(note => Math.sign(mean(rendered.left, note.startSample + 40, note.startSample + 300)));
      assert.deepEqual(signs, [1, -1, 1, -1]);
      assert.equal(rendered.diagnostics.invocations, 1);
    } finally { session.close(); }
  });

  check("uses original velocity to select exact SFZ layers", () => {
    const session = openSfizzSession(sfz, sampleRate);
    try {
      const render = velocity => session.renderTrack({
        preset: { engine: "sfizz", sfz }, length: 2000,
        notes: [{ startSample: 0, endSample: 700, key: 62, velocity, bend: 0 }]
      });
      const low = render(40), high = render(110);
      assert.ok(peak(high.left) > peak(low.left) * 4);
    } finally { session.close(); }
  });

  check("renders a percussion key without a bank or program fallback", () => {
    const session = openSfizzSession(sfz, sampleRate);
    try {
      const rendered = session.renderTrack({
        preset: { engine: "sfizz", sfz, drum: true }, length: 1600,
        notes: [{ startSample: 0, endSample: 300, key: 36, velocity: 120, bend: 0 }]
      });
      assertFiniteStereo(rendered, 1600);
      assert.ok(peak(rendered.left) > 0.01);
      assert.equal(rendered.diagnostics.engine, "sfizz");
    } finally { session.close(); }
  });

  check("routes same-key drum pieces by per-note CC without layering or fallback", () => {
    const session = openSfizzSession(sfz, sampleRate);
    try {
      const render = value => session.renderTrack({
        preset: { engine: "sfizz", sfz, drum: true }, length: 1800,
        notes: [{
          startSample: 0, endSample: 300, key: 42, velocity: 100, bend: 0,
          controls: [{ controller: 64, value }]
        }]
      });
      const closed = render(0), semiOpen = render(10);
      assert.ok(peak(semiOpen.left) > peak(closed.left) * 4,
        "CC64 semi-open must select the loud region instead of layering the closed region");
      assert.notEqual(hashChannels(closed.left, closed.right), hashChannels(semiOpen.left, semiOpen.right));
      assert.equal(semiOpen.diagnostics.controlledNotes, 1);
      assert.throws(() => render(64), error => error.code === "SAMPLE_MISSING" && error.details.controls[0].value === 64);
    } finally { session.close(); }
  });

  check("schedules a basic bend ramp on an isolated MIDI channel", () => {
    const session = openSfizzSession(sfz, sampleRate);
    try {
      const rendered = session.renderTrack({
        preset: { engine: "sfizz", sfz }, length: 3000,
        notes: [{ startSample: 0, endSample: 1800, key: 60, velocity: 100, bend: 4 }]
      });
      const straight = session.renderTrack({
        preset: { engine: "sfizz", sfz }, length: 3000,
        notes: [{ startSample: 0, endSample: 1800, key: 60, velocity: 100, bend: 0 }]
      });
      assert.ok(rendered.diagnostics.bendEvents > 1);
      assert.equal(rendered.diagnostics.bendNotes, 1);
      assert.equal(rendered.diagnostics.pitchRangeSemitones, 12);
      assert.equal(rendered.diagnostics.channels, 1);
      assert.notEqual(hashChannels(rendered.left, rendered.right), hashChannels(straight.left, straight.right),
        "pitch-wheel ramp must change the rendered PCM");
    } finally { session.close(); }
  });

  check("supports declared keyswitch and CC articulation metadata", () => {
    const preset = {
      engine: "sfizz", sfz: keyswitchSfz,
      articulations: {
        sustain: { label: "Sustain (길게 이어 연주)", keyswitch: { key: 20, velocity: 90 }, cc: [{ controller: 1, value: 32 }] },
        staccato: { label: "Staccato (짧게 끊어 연주)", keyswitch: { key: 21, velocity: 90 }, cc: [{ controller: 1, value: 32 }] }
      },
      defaultArticulation: "sustain"
    };
    const session = openSfizzSession(keyswitchSfz, sampleRate, { preset });
    try {
      const sustain = session.renderTrack({
        preset, track: {}, length: 2000,
        notes: [{ startSample: 0, endSample: 600, key: 60, velocity: 100 }]
      });
      const staccato = session.renderTrack({
        preset, track: { articulation: "staccato" }, length: 2000,
        notes: [{ startSample: 0, endSample: 600, key: 60, velocity: 70 }]
      });
      assert.equal(sustain.diagnostics.articulation, "sustain");
      assert.equal(staccato.diagnostics.articulation, "staccato");
      assert.ok(peak(staccato.left) > peak(sustain.left) * 4,
        "keyswitch selection must reach the separately recorded layer");
    } finally { session.close(); }

    assert.equal(assertSfizzCoverage(preset, [{
      articulation: "sustain", notes: [{ key: 60, velocity: 100 }]
    }]).notes, 1);
    assert.throws(() => assertSfizzCoverage(preset, [{
      articulation: "staccato", notes: [{ key: 60, velocity: 100 }]
    }]), error => {
      assert.ok(error instanceof SfizzEngineError);
      assert.equal(error.code, "SAMPLE_MISSING");
      assert.equal(error.details.reason, "attack-region-missing");
      assert.equal(error.details.keyswitch, 21);
      assert.equal(error.details.layerIndex, 0);
      assert.equal(error.details.noteIndex, 0);
      return true;
    });
  });

  check("fails missing SFZ and missing referenced samples without fallback", () => {
    const missingSfz = path.join(root, "missing.sfz");
    assert.throws(() => openSfizzSession(missingSfz, sampleRate), error => {
      assert.ok(error instanceof SfizzEngineError);
      assert.equal(error.code, "ASSET_MISSING");
      return true;
    });
    const broken = path.join(root, "broken.sfz");
    fs.writeFileSync(broken, "<region> sample=not-installed.wav key=60\n");
    const status = sfzStatus({ engine: "sfizz", sfz: broken });
    assert.equal(status.available, false);
    assert.equal(status.state, "sample-missing");
    assert.throws(() => openSfizzSession(broken, sampleRate), error => {
      assert.equal(error.code, "SAMPLE_MISSING");
      assert.match(error.message, /not-installed\.wav/);
      return true;
    });

    const emptySample = path.join(root, "empty.wav");
    const emptyDefinition = path.join(root, "empty-sample.sfz");
    fs.writeFileSync(emptySample, Buffer.alloc(0));
    fs.writeFileSync(emptyDefinition, "<region> sample=empty.wav key=60\n");
    const emptyStatus = sfzStatus({ engine: "sfizz", sfz: emptyDefinition });
    assert.equal(emptyStatus.available, false);
    assert.equal(emptyStatus.state, "sample-corrupt");
    assert.equal(emptyStatus.code, "SAMPLE_CORRUPT");
    assert.throws(() => openSfizzSession(emptyDefinition, sampleRate), error => {
      assert.equal(error.code, "SAMPLE_CORRUPT");
      assert.match(error.message, /0 byte/);
      return true;
    });
  });

  check("fails an unmapped key or velocity before launching the CLI", () => {
    const session = openSfizzSession(sfz, sampleRate);
    try {
      assert.throws(() => session.renderTrack({
        preset: { engine: "sfizz", sfz }, length: 1000,
        notes: [{ startSample: 0, endSample: 400, key: 90, velocity: 100 }]
      }), error => {
        assert.equal(error.code, "SAMPLE_MISSING");
        assert.match(error.message, /MIDI 90/);
        return true;
      });
    } finally { session.close(); }
  });

  check("rejects missing binary and unsupported controls explicitly", () => {
    const original = process.env.ARIA_SFIZZ_RENDER;
    process.env.ARIA_SFIZZ_RENDER = path.join(root, "no-sfizz-render");
    try {
      assert.throws(() => resolveSfizzBinary(), error => error.code === "ENGINE_UNAVAILABLE");
    } finally {
      if (original === undefined) delete process.env.ARIA_SFIZZ_RENDER;
      else process.env.ARIA_SFIZZ_RENDER = original;
    }
    const session = openSfizzSession(sfz, sampleRate);
    try {
      assert.throws(() => session.renderTrack({
        preset: { engine: "sfizz", sfz }, track: { attack: 0.1 }, length: 1000,
        notes: [{ startSample: 0, endSample: 400, key: 60, velocity: 100 }]
      }), error => error.code === "CAPABILITY_UNSUPPORTED" && error.details.controls.includes("attack"));
      assert.throws(() => session.renderTrack({
        preset: { engine: "sfizz", sfz }, track: {}, length: 1000,
        notes: [
          { startSample: 0, endSample: 400, key: 60, velocity: 100, gain: 0.5 },
          { startSample: 500, endSample: 900, key: 60, velocity: 100, gain: 1 }
        ]
      }), error => error.code === "CAPABILITY_UNSUPPORTED" && error.details.capability === "varying-per-note-gain");
    } finally { session.close(); }
  });

  check("closed sessions reject rendering and close is idempotent", () => {
    const session = openSfizzSession(sfz, sampleRate);
    session.close();
    session.close();
    assert.throws(() => session.renderTrack({ notes: [], length: 1 }), error => error.code === "SESSION_CLOSED");
  });

  console.log(`\n${passed} sfizz-engine tests passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

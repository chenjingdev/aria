import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SoundBankLoader } from "spessasynth_core";
import { writeSf2 } from "../tools/sf2write.mjs";
import { createTestSoundfonts } from "./soundfont-fixture.js";
import {
  openSpessaSession,
  SPESSA_ENGINE_ID,
  SPESSA_QUANTUM
} from "../src/spessa-engine.js";

let passed = 0;

async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function expectCode(code) {
  return error => {
    assert.equal(error?.code, code, `expected ${code}, received ${error?.code}: ${error?.message}`);
    assert.equal(error?.engine, SPESSA_ENGINE_ID);
    return true;
  };
}

function request(overrides = {}) {
  return {
    preset: { bank: 0, program: 0 },
    track: {},
    length: 8192,
    notes: [{ startSample: 0, endSample: 4096, key: 60, velocity: 100 }],
    ...overrides
  };
}

function hashStereo({ left, right }) {
  return crypto.createHash("sha256")
    .update(Buffer.from(left.buffer, left.byteOffset, left.byteLength))
    .update(Buffer.from(right.buffer, right.byteOffset, right.byteLength))
    .digest("hex");
}

function peak({ left, right }) {
  let value = 0;
  for (let i = 0; i < left.length; i++)
    value = Math.max(value, Math.abs(left[i]), Math.abs(right[i]));
  return value;
}

function sinePcm(amplitude, length = 2048) {
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i++)
    pcm[i] = Math.round(Math.sin(2 * Math.PI * 16 * i / length) * amplitude);
  return pcm;
}

function writeLayeredFont(outPath, amplitudes) {
  const sampleRate = 44100;
  const samples = amplitudes.map((amplitude, index) => ({
    name: `Layer${index}`,
    pcm: sinePcm(amplitude),
    sampleRate,
    origPitch: 60,
    loopStart: 0,
    loopEnd: 2048,
    loop: true
  }));
  const zones = amplitudes.length === 1
    ? [{ keyLo: 60, keyHi: 60, velLo: 0, velHi: 127, sampleIdx: 0, loop: true }]
    : [
        { keyLo: 60, keyHi: 60, velLo: 0, velHi: 63, sampleIdx: 0, loop: true },
        { keyLo: 60, keyHi: 60, velLo: 64, velHi: 127, sampleIdx: 1, loop: true }
      ];
  writeSf2({
    outPath,
    infoName: "Aria Spessa adapter test",
    copyright: "Generated test tone dedicated to the public domain under CC0-1.0",
    samples,
    instruments: [{ name: "VelocityLayers", globalGens: [], zones }],
    presets: [{ name: "ExactPreset", bank: 0, program: 0, instIdx: 0 }]
  });
}

function writeDrumAliasFont(outPath) {
  writeSf2({
    outPath,
    infoName: "Aria Spessa drum-bank test",
    copyright: "Generated test tone dedicated to the public domain under CC0-1.0",
    samples: [{
      name: "Kick", pcm: sinePcm(8000), sampleRate: 44100, origPitch: 36,
      loopStart: 0, loopEnd: 2048, loop: false
    }],
    instruments: [{
      name: "Drum", globalGens: [],
      zones: [{ keyLo: 36, keyHi: 36, velLo: 0, velHi: 127, sampleIdx: 0, loop: false }]
    }],
    presets: [
      { name: "XG copy", bank: 120, program: 0, instIdx: 0 },
      { name: "GM exact", bank: 128, program: 0, instIdx: 0 }
    ]
  });
}

function writeTrimFont(outPath) {
  const keys = [60, 60, 61, 63, 62, 64];
  const amplitudes = [1800, 9000, 5000, 6000, 7000, 8000];
  const samples = amplitudes.map((amplitude, index) => ({
    name: `Trim${index}`,
    pcm: sinePcm(amplitude),
    sampleRate: 44100,
    origPitch: keys[index],
    loopStart: 0,
    loopEnd: 2048,
    loop: true
  }));
  writeSf2({
    outPath,
    infoName: "Aria Spessa trim test",
    copyright: "Generated test tone dedicated to the public domain under CC0-1.0",
    samples,
    instruments: [
      {
        name: "MultiKey", globalGens: [], zones: [
          { keyLo: 60, keyHi: 60, velLo: 0, velHi: 63, sampleIdx: 0, loop: true },
          { keyLo: 60, keyHi: 60, velLo: 64, velHi: 127, sampleIdx: 1, loop: true },
          { keyLo: 61, keyHi: 61, velLo: 0, velHi: 127, sampleIdx: 2, loop: true },
          { keyLo: 63, keyHi: 63, velLo: 0, velHi: 127, sampleIdx: 3, loop: true }
        ]
      },
      {
        name: "SecondPreset", globalGens: [], zones: [
          { keyLo: 62, keyHi: 62, velLo: 0, velHi: 127, sampleIdx: 4, loop: true }
        ]
      },
      {
        name: "UnusedPreset", globalGens: [], zones: [
          { keyLo: 64, keyHi: 64, velLo: 0, velHi: 127, sampleIdx: 5, loop: true }
        ]
      }
    ],
    presets: [
      { name: "MultiKey", bank: 0, program: 0, instIdx: 0 },
      { name: "SecondPreset", bank: 0, program: 1, instIdx: 1 },
      { name: "UnusedPreset", bank: 0, program: 2, instIdx: 2 }
    ]
  });
}

function writeCompressedMarkerFont(sourcePath, outPath) {
  const raw = fs.readFileSync(sourcePath);
  const arrayBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const bank = SoundBankLoader.fromArrayBuffer(arrayBuffer);
  try {
    // Valid Vorbis audio is unnecessary here: the adapter must reject the public
    // BasicSample.isCompressed flag before it ever attempts sample decoding.
    bank.samples[0].setCompressedData(Uint8Array.of(1, 2, 3, 4));
    fs.writeFileSync(outPath, Buffer.from(bank.writeSF2()));
  } finally {
    bank.destroySoundBank();
  }
}

const fixture = createTestSoundfonts("aria-spessa-engine");
const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), `aria-spessa-custom-${process.pid}-`));
const layeredPath = path.join(customRoot, "layered.sf2");
const silentPath = path.join(customRoot, "silent.sf2");
const drumAliasPath = path.join(customRoot, "drum-alias.sf2");
const trimPath = path.join(customRoot, "trim.sf2");
const compressedPath = path.join(customRoot, "compressed-marker.sf2");
const pcmNamedSf3Path = path.join(customRoot, "uncompressed-renamed.sf3");
writeLayeredFont(layeredPath, [1600, 12000]);
writeLayeredFont(silentPath, [0]);
writeDrumAliasFont(drumAliasPath);
writeTrimFont(trimPath);
writeCompressedMarkerFont(fixture.defaultPath, compressedPath);
fs.copyFileSync(fixture.defaultPath, pcmNamedSf3Path);

try {
  console.log("SpessaSynth adapter unit tests");

  await check("opens PCM SoundFonts synchronously while remaining await-compatible", () => {
    // Extension alone must not classify a bank as compressed.
    const session = openSpessaSession(pcmNamedSf3Path, 44100, []);
    try {
      assert.equal(typeof session?.then, "undefined");
      assert.equal(session.engine.id, SPESSA_ENGINE_ID);
    } finally {
      session.close();
    }
  });

  await check("renders finite, non-zero stereo buffers with effects disabled", async () => {
    const session = await openSpessaSession(fixture.defaultPath, 44100, [{
      preset: { bank: 0, program: 0 }, notes: [{ key: 60, velocity: 100 }]
    }]);
    try {
      const result = session.renderTrack(request());
      assert.ok(result.left instanceof Float32Array);
      assert.ok(result.right instanceof Float32Array);
      assert.equal(result.left.length, 8192);
      assert.equal(result.right.length, 8192);
      assert.equal(result.diagnostics.engine, SPESSA_ENGINE_ID);
      assert.equal(result.diagnostics.effectsEnabled, false);
      assert.equal(result.diagnostics.quantum, SPESSA_QUANTUM);
      assert.ok(result.diagnostics.processCalls > 0);
      assert.ok(result.diagnostics.maxProcessBlock > 0);
      assert.ok(result.diagnostics.maxProcessBlock <= 128);
      assert.ok(result.diagnostics.nonzeroSamples > 0);
      assert.ok(result.diagnostics.peak > 0);
      for (const channel of [result.left, result.right])
        for (const sample of channel) assert.ok(Number.isFinite(sample));
    } finally {
      session.close();
    }
  });

  await check("is bit-deterministic across repeated offline renders", async () => {
    const session = await openSpessaSession(fixture.defaultPath, 44100, []);
    try {
      const first = session.renderTrack(request());
      const second = session.renderTrack(request());
      assert.equal(hashStereo(first), hashStereo(second));
      assert.deepEqual(first.left, second.left);
      assert.deepEqual(first.right, second.right);
    } finally {
      session.close();
    }
  });

  await check("preserves the SoundFont's original velocity-layer boundary", async () => {
    const session = await openSpessaSession(layeredPath, 44100, [{
      preset: { bank: 0, program: 0 },
      notes: [{ key: 60, velocity: 63 }, { key: 60, velocity: 64 }]
    }]);
    try {
      const low = session.renderTrack(request({
        notes: [{ startSample: 0, endSample: 4096, key: 60, velocity: 63 }]
      }));
      const high = session.renderTrack(request({
        notes: [{ startSample: 0, endSample: 4096, key: 60, velocity: 64 }]
      }));
      // MIDI velocity differs by only one, while the selected samples differ 7.5x.
      // A large discontinuity therefore demonstrates that the engine did not flatten
      // the two authored velocity zones into one generic sample.
      assert.ok(peak(high) > peak(low) * 5, `${peak(low)} -> ${peak(high)}`);
    } finally {
      session.close();
    }
  });

  await check("trims multiple declared presets, keys, and velocity layers before manager ownership", () => {
    const session = openSpessaSession(trimPath, 44100, [
      {
        preset: { bank: 0, program: 0 },
        notes: [{ key: 60, velocity: 40 }, { key: 61, velocity: 90 }]
      },
      {
        // A second entry for the same preset must merge into its key/velocity map.
        preset: { bank: 0, program: 0 },
        notes: [{ key: 60, velocity: 100 }]
      },
      {
        preset: { bank: 0, program: 1 },
        notes: [{ key: 62, velocity: 80 }]
      }
    ]);
    try {
      assert.deepEqual(session.engine.bankTrim, {
        applied: true,
        declaredPresets: 2,
        declaredKeys: 3,
        declaredCombinations: 4,
        samplesBefore: 6,
        samplesAfter: 4,
        presetsBefore: 3,
        presetsAfter: 2,
        instrumentsBefore: 3,
        instrumentsAfter: 2
      });

      const firstPreset = session.renderTrack(request({
        notes: [
          { startSample: 0, endSample: 2048, key: 60, velocity: 40 },
          { startSample: 2048, endSample: 4096, key: 61, velocity: 90 }
        ]
      }));
      assert.ok(firstPreset.diagnostics.nonzeroSamples > 0);
      assert.equal(firstPreset.diagnostics.bankTrim.samplesAfter, 4);

      const secondPreset = session.renderTrack(request({
        preset: { bank: 0, program: 1 },
        notes: [{ startSample: 0, endSample: 2048, key: 62, velocity: 80 }]
      }));
      assert.equal(secondPreset.diagnostics.preset, "SecondPreset");
      assert.ok(secondPreset.diagnostics.nonzeroSamples > 0);

      assert.throws(() => session.renderTrack(request({
        notes: [{ startSample: 0, endSample: 2048, key: 63, velocity: 80 }]
      })), expectCode("USAGE_NOT_DECLARED"));
      assert.throws(() => session.renderTrack(request({
        notes: [{ startSample: 0, endSample: 2048, key: 60, velocity: 41 }]
      })), expectCode("USAGE_NOT_DECLARED"));
    } finally {
      session.close();
    }
  });

  await check("keeps usages=[] sessions untrimmed and general-purpose", () => {
    const session = openSpessaSession(trimPath, 44100, []);
    try {
      assert.equal(session.engine.bankTrim.applied, false);
      assert.equal(session.engine.bankTrim.samplesBefore, 6);
      assert.equal(session.engine.bankTrim.samplesAfter, 6);
      assert.equal(session.engine.bankTrim.presetsBefore, 3);
      assert.equal(session.engine.bankTrim.presetsAfter, 3);
      const undeclared = session.renderTrack(request({
        notes: [{ startSample: 0, endSample: 2048, key: 63, velocity: 77 }]
      }));
      assert.ok(undeclared.diagnostics.nonzeroSamples > 0);
    } finally {
      session.close();
    }
  });

  await check("applies optional KeyModifier gain without replacing note velocity", async () => {
    const session = await openSpessaSession(fixture.defaultPath, 44100, []);
    try {
      const full = session.renderTrack(request());
      const half = session.renderTrack(request({
        notes: [{ startSample: 0, endSample: 4096, key: 60, velocity: 100, gain: 0.5 }]
      }));
      const ratio = peak(half) / peak(full);
      assert.ok(ratio > 0.499 && ratio < 0.501, `gain ratio was ${ratio}`);
    } finally {
      session.close();
    }
  });

  await check("separates overlapping same-pitch bends into independent lanes", async () => {
    const session = await openSpessaSession(fixture.defaultPath, 44100, []);
    try {
      const samePitch = session.renderTrack(request({
        length: 8192,
        notes: [
          { startSample: 0, endSample: 4096, key: 60, velocity: 100, bend: 4 },
          { startSample: 1024, endSample: 5120, key: 60, velocity: 90, bend: -4 }
        ]
      }));
      assert.equal(samePitch.diagnostics.laneCount, 2);
      assert.equal(samePitch.diagnostics.bendNotes, 2);
      assert.ok(samePitch.diagnostics.nonzeroSamples > 0);

      const separateReleaseTails = session.renderTrack(request({
        notes: [
          { startSample: 0, endSample: 1024, key: 60, velocity: 100, bend: 4 },
          { startSample: 2048, endSample: 3072, key: 60, velocity: 90 },
          { startSample: 4096, endSample: 5120, key: 60, velocity: 80, bend: -4 }
        ]
      }));
      assert.equal(separateReleaseTails.diagnostics.laneCount, 3);
      assert.equal(separateReleaseTails.diagnostics.bendReleaseTail,
        "same-key-isolated-endpoint-held");

      const differentPitch = session.renderTrack(request({
        notes: [
          { startSample: 0, endSample: 4096, key: 60, velocity: 100, bend: 4 },
          { startSample: 1024, endSample: 5120, key: 64, velocity: 90, bend: -4 }
        ]
      }));
      assert.equal(differentPitch.diagnostics.laneCount, 1);
    } finally {
      session.close();
    }
  });

  await check("maps Aria drum bank 128 to an exact SoundFont drum preset", async () => {
    const session = await openSpessaSession(fixture.defaultPath, 44100, [{
      preset: { bank: 128, program: 0 }, notes: [{ key: 36, velocity: 100 }]
    }]);
    try {
      const result = session.renderTrack(request({
        preset: { bank: 128, program: 0 },
        notes: [{ startSample: 0, endSample: 1024, key: 36, velocity: 100 }]
      }));
      assert.equal(result.diagnostics.preset, "Drum0");
      assert.ok(result.diagnostics.nonzeroSamples > 0);
    } finally {
      session.close();
    }
  });

  await check("selects the explicit GM/GS drum bank when an XG copy has the same program", async () => {
    const session = await openSpessaSession(drumAliasPath, 44100, [{
      preset: { bank: 128, program: 0 }, notes: [{ key: 36, velocity: 100 }]
    }]);
    try {
      const result = session.renderTrack(request({
        preset: { bank: 128, program: 0 },
        notes: [{ startSample: 0, endSample: 1024, key: 36, velocity: 100 }]
      }));
      assert.equal(result.diagnostics.preset, "GM exact");
      assert.ok(result.diagnostics.nonzeroSamples > 0);
    } finally {
      session.close();
    }
  });

  await check("rejects a missing preset instead of silently substituting another", async () => {
    assert.throws(
      () => openSpessaSession(fixture.defaultPath, 44100, [{
        preset: { bank: 7, program: 0 }, notes: [{ key: 60, velocity: 100 }]
      }]),
      expectCode("PRESET_MISSING")
    );
  });

  await check("rejects a key without an authored sample instead of returning silence", async () => {
    assert.throws(
      () => openSpessaSession(layeredPath, 44100, [{
        preset: { bank: 0, program: 0 }, notes: [{ key: 61, velocity: 100 }]
      }]),
      expectCode("SAMPLE_MISSING")
    );
  });

  await check("rejects exactly flagged compressed samples in the synchronous opener", () => {
    assert.throws(
      () => openSpessaSession(compressedPath, 44100, []),
      error => {
        expectCode("CAPABILITY_UNSUPPORTED")(error);
        assert.equal(error.details?.capability, "compressed-soundfont-sample");
        assert.equal(error.details?.compressedSamples, 1);
        return true;
      }
    );
  });

  await check("reports unsupported attack/release overrides rather than approximating them", async () => {
    const session = await openSpessaSession(fixture.defaultPath, 44100, []);
    try {
      assert.throws(() => session.renderTrack(request({ track: { attack: 0.01 } })),
        expectCode("CAPABILITY_UNSUPPORTED"));
      assert.throws(() => session.renderTrack(request({ track: { release: 0.5 } })),
        expectCode("CAPABILITY_UNSUPPORTED"));
    } finally {
      session.close();
    }
  });

  await check("rejects all-zero PCM instead of reporting a successful render", async () => {
    const session = await openSpessaSession(silentPath, 44100, [{
      preset: { bank: 0, program: 0 }, notes: [{ key: 60, velocity: 100 }]
    }]);
    try {
      assert.throws(() => session.renderTrack(request()), expectCode("PCM_SILENT"));
    } finally {
      session.close();
    }
  });

  await check("keeps banks independently owned when another session closes", async () => {
    const first = await openSpessaSession(fixture.defaultPath, 44100, []);
    const second = await openSpessaSession(fixture.defaultPath, 44100, []);
    try {
      first.close();
      const result = second.renderTrack(request());
      assert.ok(result.diagnostics.nonzeroSamples > 0);
    } finally {
      first.close();
      second.close();
    }
  });

  await check("refuses work after close", async () => {
    const session = await openSpessaSession(fixture.defaultPath, 44100, []);
    session.close();
    assert.throws(() => session.renderTrack(request()), expectCode("SESSION_CLOSED"));
    session.close();
  });

  console.log(`\n${passed} SpessaSynth adapter tests passed`);
} finally {
  fixture.cleanup();
  fs.rmSync(customRoot, { recursive: true, force: true });
}

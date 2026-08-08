# Third-party code notices

Aria uses third-party open-source code. This file covers code dependencies; audio asset licenses and recording credits belong in each asset pack manifest.

This notice records third-party terms only. It does not choose or grant a license for Aria's own product code.

## SpessaSynth Core

- Project: [spessasynth_core](https://github.com/spessasus/spessasynth_core)
- Version: 4.3.16
- Copyright: © 2026 Spessasus
- License: Apache License 2.0
- License text: `node_modules/spessasynth_core/LICENSE`
- Purpose in Aria: active SoundFont parsing and stereo PCM rendering backend

The package README also credits its bundled `fflate` DEFLATE implementation and `stbvorbis.js` Vorbis decoder. Keep both the package `LICENSE` and README acknowledgements when producing a bundled distribution.

Aria does not treat this dependency as permission to redistribute any SoundFont or recorded sample. Every audio pack keeps its own source, author, attribution, license, and redistribution policy.

## sfizz

- Project: [sfizz](https://github.com/sfztools/sfizz)
- Pinned commit: `f5c6e29f23b8057867c08e88f5f6ac6738baa30b`
- License: BSD-2-Clause
- Purpose in Aria: active SFZ sidecar for round-robin, articulation, keyswitch/CC, choke, crossfade and streamed stereo sample playback
- Integration status: the pinned `sfizz_render` MIDI-to-WAV CLI is connected to Aria's playback, WAV export, and stem-render paths through a strict adapter. Pack identity, entry checksums, referenced samples, key/velocity coverage, and requested articulation are checked before rendering; missing assets are never silently replaced.

Aria keeps the exact commit, compatibility patches and build recipe in `engines/sfizz.json`, `patches/`, and `tools/install-sfizz.mjs`. The installer copies sfizz's root license, contributor list, dependency overview, and the license texts/notices for linked vendored dependencies into the local installation's `licenses/` directory. This includes Abseil, atomic_queue, Cephes, cxxopts, ghc::filesystem, fmidi, invoke.hpp, jsl, SIMDe, st_audiofile and its bundled codecs, cpuid, hiir, Kiss FFT, pugixml, spline, Surge tuning code, and relevant Faust DSP notices.

Audio libraries loaded by sfizz retain their own independent licenses; the engine's code license does not authorize redistribution of an SFZ pack or its samples.

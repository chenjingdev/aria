# Tool-free composition diagnostic

This experiment asks the installed `gpt-oss:20b` for scores, not software actions. Requests go directly to local Ollama with no tools. No generated code is executed. Score parsing and piano rendering happen afterward in fixed local code.

The primary protocol is frozen in `output/gpt-oss-20b-composition-2026-09-06/protocol.json`. It contains every exact prompt and seed:

- Two exact-copy notation controls, JSON and ABC.
- Twelve basic music-representation questions in one independent request.
- Eight-bar monophonic composition and sixteen-bar two-voice composition, each in JSON and ABC, each at seeds 101/202/303.
- Primary prompts are English. Conditional Korean transfer, a 32-bar extension, and one adaptive notation-repair test are separately labelled and never pooled with first-pass results.

Generation uses the installed model's temperature 1, `think: medium`, an 8,192-token prediction allowance, and its existing 131,072 context setting. Knowledge/copy controls use temperature 0. JSON requests use Ollama's JSON output mode; ABC is unconstrained text. The two formats therefore differ in decoder assistance as well as notation, and this is not a clean causal comparison of notation alone.

`evaluate.py` uses music21 8.3.0's ABC tokenizer to retain explicit bar boundaries, pitches and durations. It checks bar totals, requested length and voices, and records other musical properties without an aggregate aesthetic score. It does not fill missing music. Bass clef alone does not lower sounding pitch; explicit octave/transpose modifiers do, following the ABC 2.1 standard. Parser fixtures cover this distinction, chords, accidentals and equivalent JSON/ABC notes.

`render.mjs` converts only the emitted notes to fixed piano audio. Every note has velocity 80; no accompaniment, ornaments or humanization are added. Audio is level-matched near -21 LUFS with peak headroom. The live Aria song is not changed.

Secondary diagnostics and shuffled/looped controls are exploratory and explicitly labelled. They show why syntax or scale consistency alone cannot establish musical attractiveness. The first complete generated duet is used for the control comparison; it is not selected as the best-sounding output. All failures and responses are retained.

## Reproduce

```sh
python3 -m venv output/gpt-oss-20b-composition-2026-09-06/.venv
output/gpt-oss-20b-composition-2026-09-06/.venv/bin/python -m pip install music21==8.3.0 numpy==1.26.4
python3 experiments/composition-capability/run.py
output/gpt-oss-20b-composition-2026-09-06/.venv/bin/python -W ignore experiments/composition-capability/extend.py
output/gpt-oss-20b-composition-2026-09-06/.venv/bin/python -W ignore experiments/composition-capability/repair.py
output/gpt-oss-20b-composition-2026-09-06/.venv/bin/python -W ignore experiments/composition-capability/evaluate.py
output/gpt-oss-20b-composition-2026-09-06/.venv/bin/python -W ignore experiments/composition-capability/diagnostics.py
node experiments/composition-capability/render.mjs
```

Completed response files are preserved and skipped. Use a separate output directory in the script for an independent new experiment. `result.json` includes original responses and runtime metadata; `request.json` records the exact tool-free request. `parsed-score.json`, MIDI and MP3 are derivative artifacts. `environment.json` and `requirements-frozen.txt` record the local checkpoint and software.

## Qwen3.8-27B on AMD

The September 6 comparison restores `qwen3.8:27b` on the user's AMD Windows host and calls its native Ollama endpoint through an owned SSH loopback tunnel. `qwen_amd.py` records the exact checkpoint, runtime and loaded GPU state before running the same primary prompts and seeds. The context is 16,384, prediction allowance 8,192, requested thinking `medium`, and explicit temperature/top_p are 1/1. Quantization, native model defaults, reasoning implementation and hardware differ from GPT-OSS, so this is not an isolated comparison of model weights or inference speed.

Results are kept in `output/qwen3.8-27b-composition-2026-09-06`. `COMPOSITION_BENCH_OUT`, `COMPOSITION_MODEL`, `COMPOSITION_BASE_URL`, `COMPOSITION_CONTEXT`, `COMPOSITION_THINK`, `COMPOSITION_TIMEOUT`, `COMPOSITION_HOST` and `COMPOSITION_KEEP_ALIVE` configure the shared runner without changing the frozen musical prompts. `compare_models.py` writes the comparison report from recorded evaluations.

Three additional diagnostics remain separate from primary success rates:

- `retry_runtime.py` retries the original eight-minute client-deadline failures with twenty minutes, asserting identical model requests and preserving the first attempts. The prediction allowance remains unchanged. Later primary attempts use the longer client deadline too.
- `instruct_probe.py` repeats the four seed-101 composition requests with only `think:false`. This was added after observing reasoning exhaust the output budget. One example per condition is an exploratory ablation, not a stable success-rate estimate.
- `normalize_notation.py` groups explicitly alternating pitch/duration pairs within already declared JSON bars. The rule is applied to both models and asserts preservation of every scalar, its order, bar boundaries and other fields. A secondary render is allowed only if the resulting score passes. Missing music is never filled and primary results are never rescored.

The local controller was rescheduled at completed-result boundaries to adjust the client deadline and prioritize the thinking ablation. Started-but-unfinished requests are retained in `administratively-interrupted/` and excluded from model-failure counts. Recovery records distinguish these cancellations from model responses. Failed primary and retry responses are retained in full.

`verify_artifacts.py` checks tool-free requests, identical primary prompts, source hashes and full MP3 decoding with an independent loudness/duration check. It does not query either model. All music remains a fixed offline piano conversion; no test changes the user's live Aria song.

## Musical-content comparison after the format diagnostic

The user's follow-up asked for evidence about music itself. The free-ABC attempt in `music_quality.py` was preserved but superseded when notation failures again dominated. `grid_quality.py` registers a separate constrained task: three musical briefs times two seeds per model, sixteen bars of eighth-note slots. The decoder fixes shape; models choose every pitch, chord, onset, hold and rest. GPT-OSS uses low reasoning and Qwen uses no reasoning. This compares those practical configurations under a fixed representation, not intrinsic model weights or equal reasoning work.

`blind_music.py` removes source identities, assigns random IDs, and adds a pitch-shuffle control, one-bar loop and exact duplicate. `anonymous-ratings.json` contains the assistant's canonical-score readings; `rating-commitment.json` was saved before `unblind_quality.py` opened the identity map. These are AI score judgments, never represented as personal audio listening or human-panel preferences. The calibration thresholds were only partly met; the report explicitly preserves that limitation instead of treating six paired wins as proof of universal superiority.

Artifacts are in `output/music-quality-grid-2026-09-06`. `listening_page.py` serves six anonymous pairs locally and records only actual user-submitted listening choices. The user's first preference and reservation about repeated chord attacks are recorded separately. `density_ablation.py` creates labelled melody-only and merged-reattack controls with exact melody preservation; these intentional modifications never replace the model originals or frozen ratings. `audit_quality.py` verifies requests, score preservation, blind commitments and independent audio decoding. `report_quality.py` writes the complete report.

The grid renderer is specifically checked for cross-bar holds, rests, rearticulation and sustained chords. No rendered test changes the live Aria song. The model weights remain installed; the prior Mac model context and AMD embedding load are restored and the owned SSH tunnel is closed after inference. The local listening page remains available for the user.

## Research basis

[ABC-Eval](https://arxiv.org/abs/2509.23350) separates basic notation understanding from segment- and sequence-level reasoning. [LilyBench](https://arxiv.org/abs/2606.08722) evaluates both score generation and understanding, and reports disagreement among generation metrics. These motivated separate formal checks, musical diagnostics, and listening material here. This is a small custom diagnostic, not a reproduction of either official benchmark.

[ABC 2.1 §4.6](https://abcnotation.com/wiki/abc:standard:v2.1#clefs_and_transposition) distinguishes display clefs from explicit playback transposition. [Ollama thinking documentation](https://docs.ollama.com/capabilities/thinking) specifies GPT-OSS's low/medium/high settings, and the [chat API](https://docs.ollama.com/api/chat) documents optional tools and JSON output mode.

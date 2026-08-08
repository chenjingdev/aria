---
name: aria-compose
description: Use Aria's MCP tools to turn natural-language genre, mood, imagery, or emotional-arc requests into editable music, or to inspect, arrange, revise, audition, compare, save, and export an existing Aria song. Trigger for requests to compose a song, beat, melody, accompaniment, soundtrack, arrangement, or musical variation in Aria, and for feedback such as "더 벅차게", "드럼이 튄다", "후렴이 약하다", or "이 부분만 고쳐줘".
---

# Compose and revise music in Aria

Treat a user's sensory language as the brief. Keep technical decisions internal unless explaining them helps the user choose.

Create an editable musical idea, not a genre stereotype. Use research as a set of probabilistic cues, genre references as conventions, and listening as the final judge.

When explaining a musical or audio concept, put the original professional term first and immediately add a plain, sensory Korean explanation. Refer to people who do not make music as `비음악인`; they may still be expert listeners, critics, or experienced music lovers.

## Route the task

Read only the references needed for the request:

- Always read [aria-capabilities.md](references/aria-capabilities.md) before operating Aria in a new task.
- Read [brief-and-emotion.md](references/brief-and-emotion.md) for mood, imagery, emotional direction, or vague sensory language.
- Read [form-and-arc.md](references/form-and-arc.md) for a new whole song, structural revision, buildup, climax, or pacing.
- Read [rhythm-and-groove.md](references/rhythm-and-groove.md) for drums, bass pocket, swing, syncopation, timing, or humanization.
- Read [harmony-and-melody.md](references/harmony-and-melody.md) for chords, melody, countermelody, tonal tension, or voice leading.
- Read [arrangement-and-orchestration.md](references/arrangement-and-orchestration.md) for instrument choice, density, register, timbre, or orchestral writing.
- Read [mix-and-diagnostics.md](references/mix-and-diagnostics.md) for balance, dynamics, clipping, loudness, masking, stereo, reverb, or sound quality.
- Read the matching genre family when the user names a genre or clearly invokes one:
  - [genre-pop-electronic.md](references/genre-pop-electronic.md)
  - [genre-jazz-soul-latin.md](references/genre-jazz-soul-latin.md)
  - [genre-acoustic-rock.md](references/genre-acoustic-rock.md)
  - [genre-cinematic-classical.md](references/genre-cinematic-classical.md)
- Read [revision-and-variation.md](references/revision-and-variation.md) for user-requested alternatives, an existing song, repeated feedback, or a comparison that changes several dimensions at once. The short A/B loop below is enough for a routine single-variable check.
- Read [evidence-guide.md](references/evidence-guide.md) when interpreting a citation or deciding how strongly to apply a research claim. Use [sources.md](references/sources.md) only when provenance is needed.

Route vague sensory language twice: first interpret the phrase, then load the references for the edit levers you actually choose. For example, “open up” may require form and arrangement; load mix guidance only when level, space, tone, or limiter behavior is part of the proposed change.

## Start safely

1. Call `get_song` and `list_feedback` before any Aria edit, including a new-song request. `new_song` replaces the current live song.
2. Call `list_presets` before creating a song or adding, replacing, or choosing instruments. With no filters it returns a compact source/family summary, not every ID; follow it with `query`, `family`, or `source` and normally `available_only:true` to retrieve actual choices. Treat the result as current and do not assume an SF2/SFZ sample preset is installed.
3. Preserve meaningful existing work before `new_song` or a broad rewrite with `save_song` or `ab_save`. Do not create a preservation copy of an empty throwaway song.
4. Inspect `edit_history` before a risky revision. Prefer reversible, bounded edits over replacing the whole song.
5. If a request is ambiguous but low-risk, choose a coherent interpretation and state it briefly. Ask only when alternatives would produce materially different songs.
6. If the required Aria tools are not callable in the current task, say that the editor is not connected and stop before pretending to inspect, play, or change a song.

Do not call `new_song` merely because the user asks for a change. It discards the current song state.

## Translate vibe into a composition brief

Internally normalize the request into six independent axes:

1. **Genre vocabulary** — optional lineage or convention, not identity.
2. **Affect** — valence, arousal, tension, and any specific feeling family.
3. **Motion** — straight, swinging, dragging, driving, floating, pulsing, or still.
4. **Texture** — sparse/dense, dry/wet, dark/bright, intimate/wide, acoustic/electronic.
5. **Narrative arc** — where energy, tension, density, register, and dynamics change.
6. **Constraints** — duration, vocals/no vocals, instruments, references, editability, and export needs.

Treat explicit constraints as acceptance criteria, not mood suggestions. Let duration, meter, required or forbidden instruments, vocal policy, section placement, and export format bound the form before filling it. If two constraints materially conflict or a phrase changes the musical outcome—such as whether a “big but unresolved” final chorus resolves harmonically or only opens in arrangement—ask one focused question. Otherwise state a conservative assumption and continue.

Write a one-sentence internal intent before adding notes. Example:

> Warm but unresolved night-drive pop; medium arousal; tight straight pulse; intimate verse opening into a wide, bittersweet final chorus; keep the melody singable and the arrangement editable.

Do not reduce a nuanced feeling to major=happy or minor=sad. Combine multiple cues and keep at least one counter-cue when the brief is emotionally mixed.

## Build a new song

### 1. Establish the frame

- Select a template only after inspecting its exact BPM and palette and deciding they fit this brief. A genre-named template is one product sketch, not research evidence or a genre definition; do not choose it solely because the user's label matches. Prefer a blank song for broad, fuzzy, historically varied, or hybrid genres.
- Set title, tempo, meter, initial tracks, and section labels.
- Plan the emotional arc before filling notes. Within the user's hard constraints, let section lengths follow the idea; 4- and 8-bar units are defaults, not laws.
- Convert a duration limit into a provisional bar budget from the chosen tempo map and meter. Leave room for the final note and release tail, then verify the actual result rather than trusting the estimate.

### 2. Prototype the identity

Build the smallest passage that proves the idea, usually 4–8 bars:

1. Establish pulse or silence.
2. Establish bass or harmonic floor.
3. Establish one harmonic/melodic identity.
4. Add the focal gesture last enough that the support can be judged on its own.

Use `play` on the prototype. Listen when audio is available and also inspect the returned level and limiter report. Metrics cannot decide whether the music works.

### 3. Expand by controlled recurrence

- Reuse recognizable material deliberately. Exact recurrence can strengthen participation and memory; variation is not mandatory on every repeat.
- Change only the dimensions required by the arc: density, register, orchestration, rhythm, harmony, dynamics, or phrase ending.
- Use `copy_bars` for structural recurrence, then edit the copy when contrast is intended.
- Use `set_section` as soon as section roles become clear.
- Preserve an anchor motif, groove, timbre, or harmonic loop while changing other dimensions.

### 4. Add performance shape

- Shape accents and phrases with note velocity first.
- Use `set_velocity` ramps, `set_region_gain` ramps, track volume, arrangement density, and register as distinct dynamic controls. Do not treat any one control as the sole correct method.
- Apply `swing`, `humanize`, or partial `quantize` only for a musical reason. Audition a straight version against the altered version when pocket matters.
- Add pitch bends selectively to instruments that can plausibly sustain expressive pitch. For vibrato, choose an installed sample preset that already contains that performed or programmed behavior.
- When `list_presets` exposes `articulation` choices, pass the exact returned ID to `add_track` or `set_track`; do not type a translated label or imitate the technique with a generic effect. Declared key switches and CC values select the actual mapped samples.
- Do not invent removed track controls: `attack` (어택, 소리가 시작되는 성질), `release` (릴리스, 음을 놓은 뒤 남는 여운), `vibrato` (비브라토, 음높이의 주기적인 떨림), or `ensemble` (앙상블, 여러 연주자가 함께 내는 편성). Choose a matching recorded/programmed preset, articulation, note duration, and arrangement instead.
- Treat `Recorded Clip` entries as one-shot recordings, not pitched instruments. True legato (실제 전이 레가토) requires recorded transitions and a dedicated mapping; longer release or an isolated legato phrase does not create it.
- Keep repeated humanization passes from accumulating accidentally.

### 5. Arrange for clarity

- Give each part a role: focal, pulse, bass foundation, harmonic support, counterline, transition, or atmosphere.
- Separate competing parts using register, onset, rhythm, duration, timbre, level, or pan. Do not solve every conflict with EQ.
- Let sections differ through orchestration and density as well as through new notes.
- Preserve silence and partial texture when they serve the brief.

### 6. Evaluate and revise

Evaluate in short, meaningful loops:

1. Play the transition into the section, not only the section itself.
2. Identify one perceptual problem in plain language.
3. Change the smallest likely cause.
4. Replay the same window.
5. Use `undo_edit`, `redo_edit`, or A/B slots when the result is uncertain.

Confirm who can actually hear the result. If audio is returned to the model, listen and judge it. If `play` only sends sound to the user's speakers, ask for the user's short A/B judgment; use returned level and limiter data only for diagnostics. Never claim to have heard a passage from numeric output alone.

Check `check_key` for accidental pitch mistakes, but do not let it erase deliberate chromaticism, modal mixture, blues inflection, or non-tonal writing.

## Revise an existing song

1. Inspect the current song, open feedback, section labels, and recent history.
2. When preservation is explicit, snapshot the intended invariants—total bars, tempo map, sections, tracks/presets, mute/solo, gains, and notes outside the edit range—and save a collision-free named backup before using the global A/B slots.
3. Restate the user's complaint as an audible contrast: too loud, too busy, late, static, harsh, weak, muddy, predictable, abrupt, or emotionally wrong.
4. Localize the smallest relevant bar range and tracks.
5. Save the untouched version to A when the change is subjective. Remember that A/B slots are global and overwritten; record the question and comparison range separately.
6. Make one causal edit class at a time: notes, timing, dynamics, register, orchestration, or tone.
7. For MCP A/B, load A, play the full matched window, let it finish or stop it, then load B and replay that window. `ab_load` stops MCP playback. Leave the chosen slot loaded before final save.
8. Replay before and after from the same lead-in.
9. Restore any diagnostic mute/solo flags and compare the stated invariants before saving.
10. Resolve GUI feedback only after the requested change has actually been made and checked.

Never mark feedback resolved merely because it was read.

## Coordinate notes correctly

- `bar` starts at 1.
- `beat` starts at 0 inside each bar. In 4/4, quarter-note onsets are `0, 1, 2, 3`.
- `beat` and `dur` use quarter-note units: `0.25`=sixteenth, `0.5`=eighth, `1`=quarter, `4`=whole note.
- Add simultaneous chord tones at the same `bar` and `beat`.
- Use the exact drum, percussion, and Recorded Clip piece IDs returned by `list_presets`. A piece ID may select a MIDI CC internally even when several pieces share one key; do not replace it with the numeric key or a nearby generic name.
- Remember that `add_notes` appends. Clear only the intended range when replacing material.

## Complete the work

Before handing off a finished composition or revision:

- For a new composition or broad structural change, play the opening, each important transition, the climax, and the ending. For a local revision, always check the edited range and adjacent transitions, then expand only to the other places the edit could affect.
- Confirm the focal part remains legible against the accompaniment.
- Check accidental outliers, truncated notes, excessive overlap, and abrupt endings.
- Read the limiter and loudness report as diagnostics, not as a universal mastering target.
- Confirm that a limiter is not doing heavy continuous repair for an overdriven arrangement.
- Compare A/B when the decision is aesthetic rather than objectively corrective.
- Recheck every explicit constraint against the current song: duration and tail, required or forbidden parts, vocal policy, requested section placement, and requested edit/export format.
- Save the song under a meaningful unique working name for a new composition. Overwrite an existing library name only when that is clearly the intended revision workflow. Export only when requested or clearly part of the task.
- Tell the user what changed in perceptual language and where to listen.

## Guardrails

- Do not copy a copyrighted reference recording, score, distinctive melody, lyric, bass line, riff, rhythmic hook, voicing sequence, arrangement sequence, sample, or stem. Extract high-level traits and create original material.
- If the user asks for an exact song or living-artist imitation, explain the boundary briefly and design at least two independent differences such as contour, harmonic rhythm, groove skeleton, form, instrumentation, or texture. Check the result for a recognizable hook before handoff.
- Use pre-existing audio only when the user confirms it is owned, licensed, or public-domain. Record provenance. A public-domain composition does not make a particular recording public-domain. [S104][S105]
- Do not present a genre convention, BPM range, chord loop, or emotion cue as a necessary definition.
- Do not force Western tonal rules onto styles or requests that do not use them.
- Do not confuse perceived emotion with emotion actually induced in the listener.
- Do not claim that random timing error automatically sounds human.
- Do not use loudness standards as a single creative target for every song or playback platform.
- Do not report success solely from tool output. Audition the relevant passage whenever playback is available.

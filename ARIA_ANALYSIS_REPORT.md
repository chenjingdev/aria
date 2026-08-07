# Aria 아키텍처·문제점 분석 보고서

- 분석 대상: `/Users/chenjing/dev/aria`
- 기준 버전: `package.json`의 `0.1.0`
- 분석 일자: 2026-08-06
- 범위: 소스 구조, 상태·데이터 흐름, 오디오/SF2/MIDI, MCP·GUI, 저장, 테스트, 제품 UX
- 제외: 음질에 대한 청감 평가, 모든 SF2 자산의 라이선스 검증, 실제 Claude Code 장시간 작곡 세션

## 1. 결론 요약

Aria는 단순 데모보다 훨씬 발전한 **AI 우선 로컬 작곡 스케치 앱**이다. MCP와 GUI가 하나의 연산 계층을 공유하고, 검증된 JSON 곡 모델·실시간 SSE·다단계 undo/redo·결정적 오디오 렌더·SF2·MIDI/WAV 내보내기를 약 8천 줄의 의존성 적은 코드로 구현했다. 특히 “LLM이 작곡하고 사람이 피아노롤에서 듣고 고친다”는 제품 방향은 명확하고 차별화되어 있다.

다만 현재는 기능 추가보다 **통합과 신뢰성 정리**가 먼저다.

1. 합법적인 트랙 볼륨에서 MIDI가 깨지고, mute/solo가 MIDI에 반영되지 않는다.
2. 오프라인 렌더가 HTTP·MCP·SSE와 같은 Node 이벤트 루프를 동기적으로 점유하며, 허용된 10분 렌더는 대략 700MB 이상을 요구할 수 있다.
3. 구간 렌더가 구간 이전에 시작해 넘어온 긴 음을 누락한다.
4. `master.js`, `eq.js`, `key.js`, `midi-import.js`가 완성도 높아 보이지만 제품 경로에서 전혀 호출되지 않는다. 현재 소스의 약 26.5%가 미통합 상태다.
5. 테스트가 로컬 SoundFont에 따라 실패하며, 실행할 때 실제 `~/Music/aria/`에 파일을 쓰고 큰 임시 파일을 남긴다.
6. 파일명 충돌과 다중 인스턴스 경쟁으로 곡 저장 손실 가능성이 있다.
7. 피아노롤의 핵심 UX인 세로 피치 이동·명시적 줌/그리드·선택 구간 재생/내보내기·접근성이 부족하다.

**판정:** 기술적으로 인상적인 macOS 개발자용 프로토타입이지만, 현재 상태를 일반 사용자용 작곡 제품이나 안정적인 DAW로 배포하기에는 데이터·MIDI·렌더링·UX 리스크가 남아 있다.

---

## 2. 규모와 기술 스택

| 영역 | 구성 |
|---|---|
| 런타임 | Node.js 18+, ESM (`package.json:5,14-16`) |
| 외부 의존성 | `@modelcontextprotocol/sdk`, `zod` 두 개 (`package.json:11-13`) |
| 서버 | Node `http`, loopback HTTP, SSE, JSON RPC, MCP stdio |
| GUI | 단일 `public/index.html`, Vanilla JS/CSS, Canvas 2D, Web Audio |
| 오디오 | 순수 JS FM/감산/가산 신스, 자체 SF2 파서, 오프라인 PCM 렌더 |
| 재생 | 서버: 임시 WAV + macOS `afplay`; 브라우저: 트랙별 stem + Web Audio |
| 출력 | 16-bit stereo WAV, 자체 SMF Type 1 MIDI 인코더 |
| 저장 | `~/.aria/song.json`, `~/.aria/songs/*.json`, `~/Music/aria/` |
| 테스트 | 커스텀 `node test/smoke.js`; 테스트 러너·브라우저 테스트·CI 설정 없음 |

대략적인 코드 규모는 `src` 4,427줄, 단일 GUI 2,024줄, 테스트 739줄, SF2 빌드 도구 836줄이다. 주요 집중 지점은 `src/core.js` 1,130줄, `src/synth.js` 556줄, `public/index.html` 2,024줄이다.

---

## 3. 현재 아키텍처

```text
Claude Code / MCP client
        │ stdio + Zod schemas
        ▼
     src/mcp.js ─────────┐
                         │
Browser GUI              ▼
Canvas + Web Audio → src/web.js → runOp(name, args)
        ▲             │          src/core.js
        │ SSE full     │              │
        └──────────────┘              ├─ state / log / undo-redo
                                      ├─ song.js: schema + validation + tempo
                                      ├─ autosave / song library
                                      ├─ player.js → synth.js → WAV → afplay
                                      └─ midi.js → SMF MIDI

synth.js
  ├─ presets.js / rng.js
  ├─ built-in synth voices
  ├─ sf2.js: SF2 parser/sample renderer
  ├─ sidechain / pan / region gain / reverb
  └─ inline compressor + soft clip

Browser "즉시 믹스"
  /api/stem → track WAVs → AudioBuffer cache → GainNodes
                                   └→ Web Audio DynamicsCompressor
```

### 3.1 시작과 제어 흐름

- 진입점은 autosave를 복원하고 HTTP GUI를 항상 시작한 뒤, stdin이 TTY가 아니면 MCP stdio를 시작한다 (`src/index.js:9-23`).
- MCP와 GUI는 둘 다 `runOp`으로 합류한다 (`src/mcp.js:254-266`, `src/web.js:102-134`, `src/core.js:1080-1094`).
- `runOp`은 연산 실행, whole-song undo 스냅숏, 로그 기록을 공통 처리한다.
- 변경 연산은 autosave를 예약하고 전체 곡 상태를 SSE로 보낸다 (`src/core.js:84-87`). 브라우저는 서버 상태의 미러이며 canonical state는 서버에 있다 (`public/index.html:205-230`).

이 “한 연산 계층”은 현재 설계의 가장 좋은 부분이다. MCP와 GUI가 서로 다른 편집 규칙을 갖는 문제를 상당 부분 예방한다.

### 3.2 곡 도메인 모델

핵심 모델은 다음과 같은 평면 JSON이다.

- Song: `title`, `bpm`, `timeSig`, `tempoMap`, `tracks`, `sections`, `feedback`
- Track: `name`, `seed`, `preset`, `volume`, `pan`, `notes`, 선택적 `mute/solo`, 음색 override, region gains
- Note: `{bar, beat, pitch, dur, vel}`

`validateSong`은 32트랙, 트랙당 10,000노트, 값 범위, 프리셋, 템포 맵 등을 강하게 검증한다 (`src/song.js:151-273`). LLM이 다루기 쉬운 단순한 모델이지만 프로젝트·트랙·노트의 stable ID, schema version, revision, clip/pattern, key/chord 개념은 없다.

### 3.3 오디오 경로

- `renderRange`가 전체 구간의 dry/send/duck 버퍼를 메모리에 만들고 노트를 하나씩 합성한다 (`src/synth.js:346-510`).
- built-in synth와 SF2 보이스가 같은 노트 모델을 사용한다.
- 리버브 후 inline glue compressor와 cubic soft clip을 적용한다 (`src/synth.js:512-540`).
- 서버 재생은 결과를 WAV로 써서 `afplay`를 spawn한다 (`src/player.js:39-64`).
- “즉시 믹스”는 트랙별 stem을 브라우저에 캐시하고 Web Audio에서 볼륨/mute/solo를 반영한다 (`public/index.html:300-459`).

서버 믹스와 즉시 믹스는 같은 소리가 아니다. 서버는 자체 compressor+soft clip, 브라우저는 `DynamicsCompressor` 근사만 사용한다.

### 3.4 저장

- autosave: `~/.aria/song.json`, 300ms debounce, temp+rename (`src/core.js:38-70`)
- 곡 라이브러리: `~/.aria/songs/<정제된 제목>.json` (`src/core.js:89-118`)
- 새 곡/불러오기 전 현재 곡 자동 보존 (`src/core.js:290-294,988-995`)
- undo/redo와 재생 상태는 메모리 전용이다.

---

## 4. 잘된 점

1. **MCP·GUI 공통 명령 계층**: 검증·undo·로그·저장을 재사용한다.
2. **방어적인 데이터 검증**: 잘못된 LLM 입력이 live state를 부분 오염시키지 않도록 사본 검증 패턴을 많이 사용한다.
3. **결정적 렌더**: 같은 곡의 play/export 파형을 재현할 수 있도록 seed를 고정한다 (`src/synth.js:365-367,412-429`).
4. **템포 램프 처리**: 오디오와 MIDI의 실제 경과 시간을 맞추려는 구현이 세심하다 (`src/song.js:24-90`, `src/midi.js:15-57`).
5. **작은 배포 표면**: 프레임워크와 빌드 체인 없이 실행 가능하며 외부 런타임 의존성이 적다.
6. **AI 협업 기능**: sections, bar-scoped feedback, 수치형 level report는 사람과 LLM의 수정 루프에 적합하다.
7. **보안 기본값**: HTTP가 `127.0.0.1`에만 bind되고 브라우저 cross-origin 요청을 막으며 RPC body를 5MB로 제한한다 (`src/web.js:28-40,102-135,145-155`).
8. **기능 깊이**: note draw/delete/move/resize/split, block edit, velocity, insert/delete/copy bars, humanize/swing/quantize까지 이미 있다.

---

## 5. 우선순위별 문제점

### P0 — 즉시 서비스 중단급

이번 정적·동적 점검에서는 원격 코드 실행이나 항상 발생하는 저장 파괴 같은 P0는 확인하지 못했다.

### P1 — 출시 전 반드시 수정

#### P1-1. MIDI 출력이 합법적인 상태에서도 깨진다

**근거**

- 곡 검증은 track volume `0..2`를 허용한다 (`src/song.js:186-193`).
- MIDI CC7은 `Math.round(track.volume * 127)`을 7-bit clamp 없이 기록한다 (`src/midi.js:108-110`).
- volume 2를 검증된 곡에 넣어 확인한 결과 실제 이벤트가 `B0 07 FE`였다. `FE`는 MIDI data byte가 아니라 status 영역이라 유효한 CC7 값이 아니다.
- `midiBuffer`는 모든 트랙을 순회하며 mute/solo를 확인하지 않는다 (`src/midi.js:84-118`). MCP 설명은 mute가 재생·내보내기에서 제외된다고 명시한다 (`src/mcp.js:49-54`). 검증에서 mute된 트랙의 note-on이 MIDI에 남는 것도 확인했다.

**영향**

- DAW에서 MIDI 파일이 오해석되거나 트랙 이벤트가 깨질 수 있다.
- WAV와 MIDI가 서로 다른 편곡을 내보낸다.

**권장 수정**

- audible track 집합을 WAV와 같은 규칙으로 먼저 계산한다.
- CC7을 명시적으로 `0..127`에 clamp하거나, 0..2 도메인을 MIDI로 어떻게 매핑할지 별도 정책을 둔다.
- 모든 MIDI data byte가 7-bit인지 property test를 추가한다.

#### P1-2. 오디오 렌더가 제어 서버를 멈추고 메모리를 과도하게 쓴다

**근거**

- `renderRange`, SF2 parse, WAV 생성·파일 쓰기가 HTTP/MCP/SSE와 같은 프로세스에서 동기 실행된다 (`src/web.js:80-135`, `src/core.js:1047-1075`, `src/sf2.js:42-43`).
- 10분, 44.1kHz stereo에서 Float32 한 채널은 약 106MB다. 렌더 중 L/R, send L/R, duck, wet L/R만 계산해도 약 740MB이며 보이스 버퍼·SF2·WAV 버퍼는 별도다 (`src/synth.js:362-375,512`).
- `/api/stem`도 최대 240초를 허용하고 브라우저는 트랙별 decoded buffer를 캐시한다 (`src/web.js:80-101`, `public/index.html:325-336`). 32트랙 상한과 결합하면 multi-GB가 가능하다.
- SF2 parser는 파일 전체를 동기 read하고 cache한다. 권장되는 1.3GB Salamander 파일도 통째로 상주할 수 있다 (`src/sf2.js:42-60,153-181`; `README.md:44`).

**영향**

긴 play/export/stem 요청 중 GUI, stop, MCP 응답, SSE가 멈춘다. 메모리 압박·swap·OOM 위험도 있다.

**권장 수정**

- renderer를 Worker Thread/별도 process로 이동하고 cancel/progress를 제공한다.
- WAV는 chunk streaming으로 작성하고 메모리 상한을 “초”가 아니라 예상 바이트로 검증한다.
- stem cache에 총 바이트 LRU 상한을 둔다.
- 대형 SF2는 mmap/샘플 범위 lazy loading 또는 선택적 font unloading을 검토한다.

#### P1-3. 구간 렌더 시작점에서 지속음이 사라진다

`renderRange`는 `note.bar < fromBar`인 노트를 무조건 건너뛴다 (`src/synth.js:420-425`). 따라서 1마디 4박째 시작해 2마디까지 이어지는 음을 2마디만 play/export하면 해당 음이 완전히 무음이다.

검증 재현:

- note: bar 1, beat 3, duration 2
- render 1..2 peak: 약 `0.141`
- render 2..2 peak: `0`

구간 선택 재생과 부분 WAV export의 음악적 의미를 깨뜨리는 correctness bug다. 시작 beat 이전에 시작했지만 끝 beat가 구간과 겹치는 노트도 포함하고, 앞부분만 sample offset으로 잘라야 한다.

#### P1-4. 테스트가 비결정적이고 사용자 파일을 건드린다

**관찰 결과**

- 현재 설치된 SoundFont 상태에서 `npm test`는 `test/smoke.js:539`의 `sf-contrabass-pizz 무음`으로 실패했다.
- 테스트는 모든 특수 악기를 C4 하나로 검사한다 (`test/smoke.js:527-540`). Contrabass pizz는 C2/E2/C3에서는 소리가 나고 C4는 해당 샘플 음역 밖이라, 제품 결함보다 테스트 음역 선택 결함이다.
- `ARIA_SF2`를 빈 경로로 격리하면 44건이 통과한다.
- README는 35건이라고 적었지만 실제 파일은 optional SF2 포함 최대 50건이다 (`README.md:96`).
- 테스트는 `ARIA_DATA_DIR` 임시 디렉터리를 만들고 400초 WAV 등을 남기며 종료 정리가 없다 (`test/smoke.js:136,373-381,590-592`). 관찰된 디렉터리는 실행당 약 70~75MB였다.
- 더 심각하게 `ops.export({format:"both"})`를 path 없이 호출하여 실제 `~/Music/aria/smoke.mid`와 `~/Music/aria/smoke-1-2마디.wav`를 쓴다 (`test/smoke.js:500-509`, `src/core.js:1056-1071`).

**권장 수정**

- 테스트 시작 시 `mkdtemp`, export dir override, 종료 시 `rm -rf`를 보장한다.
- SoundFont fixture를 작은 고정 asset으로 두거나 asset별 valid audition range를 사용한다.
- unit/integration/browser 테스트를 분리하고 CI에서는 로컬 `~/.aria`와 `~/Music` 접근을 금지한다.

> 분석 중 문서에 적힌 정상 절차대로 테스트를 실행했기 때문에 현재 `~/Music/aria/smoke.mid`와 `~/Music/aria/smoke-1-2마디.wav`의 수정 시각이 갱신되었다. 기존 파일 여부를 알 수 없어 삭제하지 않았다.

#### P1-5. 저장 파일 충돌과 다중 인스턴스 경쟁으로 데이터 손실 가능성이 있다

- 라이브러리 파일명은 제목의 금지문자를 `_`로 바꾸고 80자로 자른다 (`src/core.js:89-110`). `A/B`와 `A:B`, 또는 앞 80자가 같은 서로 다른 제목은 같은 파일을 조용히 덮어쓴다.
- GUI에서 새 곡은 기본 `무제`이고 이름 입력 흐름이 약해 같은 이름 overwrite가 쉽다 (`src/song.js:105-115`, `public/index.html:260-269`).
- 모든 인스턴스가 같은 `song.json`과 `.tmp` 이름을 쓴다. mtime 비교에는 500ms 허용 창이 있으며 lock/CAS가 없다 (`src/core.js:38-55`).
- 더 최신 인스턴스를 발견하면 저장을 “건너뛰기”만 하고 reload/merge/UI 경고를 하지 않는다. 사용자는 계속 편집하지만 그 상태가 영속화되지 않을 수 있다.

**권장 수정**

UUID project ID를 파일명으로 쓰고 title은 metadata로 분리한다. schema version/revision, per-instance lock, conflict UI, autosave version history를 추가한다.

### P2 — 다음 마일스톤에서 정리

#### P2-1. 미통합 모듈과 중복 구현이 큰 상태다

production import graph에서 다음 네 모듈로 들어오는 import가 없다.

| 모듈 | 구현된 것으로 보이는 기능 | 상태 |
|---|---|---|
| `src/master.js` | 공통 master chain, look-ahead limiter, LUFS/LRA | 미사용 |
| `src/eq.js` | 3-band EQ와 response | 미사용 |
| `src/key.js` | key detection, scale, out-of-key | 미사용 |
| `src/midi-import.js` | MIDI import와 preset 추정 | 미사용 |

합계 1,175줄, 전체 `src`의 약 26.5%다. 특히 `master.js:1-7`은 inline master가 옮겨졌다고 설명하지만 실제 `synth.js:522-540`에 별도 master가 남아 있다. “완료할 기능인지, 실험 branch인지”를 결정하고 통합 또는 제거/feature flag해야 한다.

#### P2-2. 서버 재생·WAV와 브라우저 즉시 믹스가 불일치한다

- stem 모드는 nonlinear master를 우회한다 (`src/synth.js:513-520`).
- 브라우저는 다른 `DynamicsCompressor`로 근사한다 (`public/index.html:339-346`).
- 즉시 믹스 cache hash는 e808 트랙만 duck dependency로 포함하지만, 서버 duck은 global solo 상태에 의존한다 (`public/index.html:305-323`, `src/synth.js:369-389`). non-808 트랙을 solo하면 808이 들리지 않아야 해도 cached stem에 이전 pumping이 남을 수 있다.
- stem fetch/decode 도중 곡이 바뀌면 예전 audio에 새로운 global song hash를 붙일 수 있다 (`public/index.html:325-335`). request 시점의 revision/hash를 고정하지 않아 stale audio가 fresh로 캐시되는 race다.
- server `afplay` 중 즉시 믹스를 켜도 server playback을 멈추지 않고, 즉시 믹스 시작도 `liveStop()`만 호출한다 (`public/index.html:239-255,349-360`). 두 playback이 겹치고 Stop이 한 경로만 멈출 수 있다.

모니터링한 소리와 export WAV가 다르면 믹싱 도구로서 신뢰하기 어렵다. `master.js` 통합과 공통 stem-sum 경로, playback owner 단일화, revision 기반 cache invalidation으로 한 의미론을 만들어야 한다.

#### P2-3. SoundFont preset 가용성과 fallback 의미가 불명확하다

GUI/meta는 기본 `default.sf2` 존재 여부로 모든 SF preset을 한꺼번에 노출한다 (`src/web.js:61-76`). 전용 font가 없으면 `resolveFont`가 default로 조용히 fallback하고, 프로그램 또는 pitch zone이 없으면 64개의 zero sample을 반환한다 (`src/sf2.js:179-181,193-214`). 전용 font가 재사용한 GM program 번호는 default GM에서 전혀 다른 악기일 수 있다. preset별로 `font + bank/program + playable range` 가용성을 검증하고, 의미가 다른 fallback이나 no-zone silence는 경고/에러로 보여주는 편이 안전하다.

#### P2-4. whole-state 전송·undo와 stable ID 부재가 확장 한계다

- 사소한 편집마다 전체 곡을 실행 전/후 JSON stringify하고 full state SSE를 보낸다 (`src/core.js:84-87,1083-1089`).
- undo는 whole-song JSON 최대 30단계/40MB다 (`src/core.js:125-155`).
- 노트는 `bar+pitch(+beat+dur)`로 찾고 완전 중복이면 첫 번째를 고른다 (`src/core.js:211-229`).
- revision/CAS가 없어 AI와 GUI의 동시 편집 충돌을 감지할 수 없다.

곡·트랙·노트 ID, operation ID, revision, patch event를 도입하고 undo를 command/inverse patch 기반으로 전환하는 것이 좋다.

#### P2-5. 중요한 GUI 작곡 흐름이 빠져 있다

1. 피아노롤 drag는 X축 시간만 바꾸고 Y축 pitch 이동이 없다 (`public/index.html:1353-1365,1415-1419`).
2. `barW` 최대 120px인데 4/4에서 16분음표 칸은 7.5px라 최소 8px 조건을 못 넘는다. 따라서 GUI는 4/4의 0.25-beat grid를 사용할 수 없다 (`public/index.html:708-716,913-917`). 줌/그리드 선택도 없다.
3. play 결과와 export 경로는 여러 줄인데 toast가 첫 줄만 보여준다 (`public/index.html:183-203`, `src/core.js:968-975,1073-1075`). clipping 경고와 실제 저장 위치가 GUI에서 사라진다.
4. WAV export 버튼은 header의 from/to를 전달하지 않는다 (`public/index.html:256-257`).
5. range feedback UI는 API가 지원하는 track을 보내지 않는다 (`public/index.html:1851-1900`, `src/mcp.js:214-218`).
6. GUI에는 loop, selected-range play, audition/scrub, prompt input/agent wake-up이 없다. 피드백을 남겨도 Claude Code로 돌아가 다시 요청해야 한다.

#### P2-6. MCP 기능 표면과 구현이 어긋난다

- `ensemble`은 song validation과 GUI에는 있지만 MCP `add_track/set_track` schema에 없다 (`src/song.js:121-127`, `public/index.html:1601`, `src/mcp.js:16-25,49-58`). LLM은 `set_song` 우회 외에는 설정할 수 없다.
- 더구나 ensemble renderer가 `detuneCents`를 넘겨도 SF2 pitch 계산은 이 인자를 사용하지 않는다 (`src/synth.js:436-448`, `src/sf2.js:193,239-244`). 현재 합주는 delay된 복제이지 설명된 micro-detune stack이 아니다.
- MCP instruction은 `aria-compose` skill을 먼저 불러오라고 한다 (`src/mcp.js:222-226`). 개발자 홈에는 해당 skill이 있지만 이 repo에는 포함되지 않고 README에도 설치/배포 계약이 없다. 다른 사용자 환경에서는 암묵적 외부 의존성이 된다.
- README의 초기 도구 표는 granular edit, history, feedback, sections 등 실제 39개 도구를 충분히 설명하지 않는다 (`README.md:25-37`, `src/mcp.js:28-220`).

#### P2-7. 접근성과 반응형 지원이 사실상 없다

핵심 arrange/ruler/piano-roll/velocity가 semantic child 없는 canvas이며 pointer 좌표로만 편집된다 (`public/index.html:146-171,1304-1494`). focus-visible, dialog semantics/focus trap, aria-live toast, 텍스트형 대체 편집 화면, media query가 없다. 키보드·스크린리더 사용자와 작은 화면/확대 환경을 지원하기 어렵다.

#### P2-8. 선언한 최소 Node 버전과 lockfile이 모순된다

`package.json`은 Node `>=18`을 선언하지만 (`package.json:14-16`), lockfile의 `@hono/node-server@2.0.12`는 Node `>=20`을 요구한다 (`package-lock.json:21-27`). 최소 버전을 20으로 올리거나 Node 18 호환 transitive를 pin하고 CI에서 실제 최소 버전을 실행해야 한다.

### P3 — 제품 방향에 따라 결정

- 서버 재생은 macOS `afplay` 전용이고 loop마다 재spawn 간격이 있다 (`src/player.js:39-64`).
- region gain은 시간 구간의 sample automation이 아니라 “노트 시작 bar” 기준으로 음 전체에 적용된다 (`src/synth.js:485-489`). 긴 음이 경계를 넘을 때 시각적 구간 의미와 다르다.
- 6/8도 quarter-note 단위 `beat 0..<3`으로 표현되어 음악가에게 직관적이지 않을 수 있다 (`src/song.js:16-18,276-287`).
- key/chord/pattern/clip/automation/CC/pitch bend/recording/metronome/plugin이 없다. 이는 버그라기보다 Aria를 “AI 스케치패드”로 둘지 “DAW”로 확장할지의 제품 결정이다.
- localhost RPC/SSE/stem에는 인증이 없고 Origin 없는 local client는 허용된다 (`src/web.js:28-40,49-59,80-135`). 로컬 전용일 때는 합리적이지만, 코드 주석처럼 tunnel domain으로 노출하면 URL을 아는 사람이 곡·로그·audio를 읽고 destructive RPC와 speaker playback까지 실행할 수 있다. `Sec-Fetch-Site`는 CSRF 방어이지 인증이 아니므로 tunnel은 명시적 opt-in + process별 capability token + Host/Origin 검증이 필요하다.

---

## 6. 제품 UX 평가

### 현재 가장 설득력 있는 사용자 여정

1. Claude Code에서 장르·길이를 자연어로 요청
2. MCP가 template → drums → bass → chords → melody 순으로 곡 작성
3. Aria GUI에서 SSE로 실시간 관찰
4. 구간 재생·프리셋·볼륨·노트 편집
5. 사용자가 bar-scoped feedback 작성
6. Claude Code에서 다시 수정을 요청하고 feedback resolve
7. MIDI/WAV export

차별점은 “AI가 쓰고 사용자가 감독하는 상주 작곡 세션”이다. 일반 DAW와 직접 경쟁하기보다 **AI sketch-to-MIDI/WAV workstation**으로 포지셔닝할 때 현재 강점이 가장 잘 드러난다.

### 닫히지 않은 루프

브라우저에는 agent prompt 입력이나 “이 피드백 반영 요청” 버튼이 없다. 사용자는 feedback을 남긴 후 Claude Code로 돌아가 다시 호출해야 한다. 피드백 등록 → agent wake-up → 수정 preview → accept/reject까지 브라우저 안에서 연결하면 Aria의 핵심 가치가 훨씬 선명해진다.

---

## 7. 권장 개선 로드맵

### 0단계 — 1~3일: 신뢰성 복구

- [ ] MIDI CC7 7-bit 보장, mute/solo export semantics 수정
- [ ] MIDI data-byte property test와 muted/solo regression test
- [ ] 구간 이전 지속음 포함 regression test와 renderer 수정
- [ ] 테스트 export/data dir 완전 격리 및 `finally` cleanup
- [ ] SoundFont 테스트에 악기별 valid pitch/range 적용
- [ ] GUI export에 from/to 전달, 전체 결과/경로/clip warning 표시
- [ ] MCP `ensemble` schema 추가
- [ ] README 도구·테스트 수·실행 부작용 정정

### 1단계 — 1~2주: 아키텍처 안정화

- [ ] render를 Worker Thread/child process로 이동, cancel/progress 지원
- [ ] chunked WAV writer와 memory budget 도입
- [ ] `master.js`를 실제 경로에 통합하고 서버/instant mix 의미론 통일
- [ ] 미통합 네 모듈을 통합할지 제거할지 결정
- [ ] song schema version, project/track/note ID, revision 도입
- [ ] library 파일명을 UUID로 전환하고 기존 JSON migration 작성
- [ ] multi-instance lock/conflict/reload UI 추가

### 2단계 — 2~6주: 핵심 제품 루프 완성

- [ ] 피치 세로 drag, transpose operation
- [ ] zoom/grid selector(16분·32분·triplet 포함)
- [ ] ruler selection → play/loop/export/feedback 공통 range
- [ ] note/piano-key audition, meter, clip/LUFS 표시
- [ ] 브라우저 내 prompt 또는 “피드백 반영 요청” 연결
- [ ] semantic DOM 또는 대체 note-list editor, keyboard navigation, aria-live/dialog/focus
- [ ] MCP/HTTP/browser E2E와 audio snapshot 테스트

---

## 8. 실행 검증 결과

| 검증 | 결과 |
|---|---|
| `node --check` (`src`, `tools`, `test`) | 통과 |
| `npm audit --omit=dev` | 알려진 취약점 0건 |
| 기본 `npm test` | 실패: `sf-contrabass-pizz`를 C4에서 검사한 환경 의존 테스트 |
| SoundFont 없는 격리 환경 `npm test` | 44건 통과 |
| HTTP 통합 smoke (`/api/meta`, `new_song`) | 통과 |
| MIDI volume 2 검증 | 잘못된 `B0 07 FE` 확인 |
| muted MIDI 검증 | note-on이 남는 문제 확인 |
| 구간 경계 지속음 검증 | 2마디만 render 시 peak 0 확인 |

테스트 커버리지는 기존 song/synth/core/MIDI spine에는 넓지만, 브라우저 상호작용, MCP transport, 동시성, 미통합 네 모듈, 접근성, 대형 메모리 경로에는 거의 없다.

---

## 9. 최종 제안

지금 Aria에 가장 필요한 것은 기능 수 증가가 아니라 **한 제품 경로로의 수렴**이다.

1. MIDI·저장·테스트를 먼저 신뢰 가능하게 만든다.
2. 렌더를 제어 이벤트 루프에서 분리한다.
3. `master/eq/key/midi-import` 미통합 branch의 운명을 결정한다.
4. 서버와 즉시 믹스의 소리를 통일한다.
5. stable ID/revision/schema version으로 AI+사람 동시 편집의 기반을 만든다.
6. 피치 drag·줌/grid·선택 구간 transport/export·agent feedback loop를 완성한다.

이 순서라면 Aria의 현재 장점인 “가볍고 이해하기 쉬운 AI 작곡 도구”를 잃지 않으면서, 프로토타입에서 신뢰할 수 있는 제품으로 넘어갈 수 있다.

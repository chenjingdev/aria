# ◆ Aria — AI와 함께 만드는 편집 가능한 곡

**v0.1.0-alpha.1 · macOS용 AI 작곡 프리뷰**

Aria는 외부 AI가 악기와 노트를 작성하고, 사용자가 브라우저에서 듣고 보관하고 내보내는 로컬 작곡 앱입니다. AI 모델이나 채팅은 내장되어 있지 않습니다. Claude Code·Codex처럼 MCP를 지원하는 AI 도구와 계정이 별도로 필요합니다.

이번 공개 범위는 **AI로 곡 만들기 → 듣기 → 기본 조정 → 보관 → WAV 내보내기**입니다. 세부 노트 편집·구간 직접 편집·A/B·피드백은 실험 기능이며 기본 화면에서는 꺼져 있습니다. 완성된 범용 DAW로 소개하지 않습니다. [기능 범위와 벤치 근거](docs/RELEASE_SCOPE.md)

## 처음 설치하기

1. Mac에 [Node.js 24 LTS](https://nodejs.org/en/download)를 설치하세요. Aria의 최소 요구 버전은 Node.js 22입니다. Git이 없는 Mac은 아래 clone 명령 실행 시 표시되는 개발 도구 설치 안내를 먼저 완료하세요.
2. 터미널에서 아래 명령을 실행합니다.

```bash
git clone https://github.com/chenjingdev/aria.git
cd aria
npm ci
npm start
```

3. 브라우저가 열리면 **시작 안내 → 기본 음원 준비**를 따르세요. GeneralUser GS 공식 페이지에서 다운로드 → 압축 해제 → 받은 SF2 파일 선택 → 피아노 소리 확인 순서입니다. 파일 이름 변경과 설치 폴더 찾기는 Aria가 대신 처리합니다.
4. **시작 안내 → AI 연결**에서 사용하는 AI의 등록 명령을 복사해 별도 터미널에서 실행하세요. 실제 설치 경로가 자동으로 들어갑니다. 해당 AI 도구 설치·로그인은 먼저 완료되어 있어야 합니다. [Claude Code 시작 안내](https://code.claude.com/docs/en/quickstart)
5. AI에서 새 대화를 열고 화면의 **연결 확인 요청**을 붙여 넣으세요. Aria에 실제 도구 요청이 도착하면 최근 요청 시각이 표시됩니다. 이어서 **첫 곡 요청**을 복사해 보내면 됩니다.

예: “Aria에 설치된 기본 악기만 사용해서 차분한 8마디 곡을 만들고 들려줘.”

기본 음원과 AI 연결까지 끝내면 곡을 만들 수 있습니다. 브라우저 안에서 AI가 자동으로 시작되지는 않으며 작곡 품질과 속도는 연결한 AI에 따라 다릅니다. 작곡 스킬 설치는 필수가 아닙니다. 기본 음원만 설치한 첫 곡은 대형 오케스트라 팩을 쓴 벤치 곡과 음색이 다를 수 있습니다.

브라우저가 자동으로 열리지 않으면 터미널에 표시된 주소를 여세요. `npm start` 터미널을 열어 두면 앱이 계속 실행됩니다. 종료는 그 터미널에서 Control+C, 다음 실행은 Aria 폴더에서 다시 `npm start`입니다. MCP 도구 호출로 앱이 자동 시작된 경우에는 AI가 돌려주는 GUI 주소를 열 수 있습니다.

## 다시 쓰기와 업데이트

현재 곡은 `~/.aria/song.json`에 자동 저장되고 이름을 붙여 보관한 곡은 `~/.aria/songs/`에 남습니다. AI의 **save_song** 또는 화면의 보관 버튼으로 곡을 보관하고, 화면의 곡 목록에서 다시 여세요. 음원도 한 번 설치하면 유지됩니다. 코드 폴더를 업데이트해도 이 데이터는 지우지 않습니다.

앱을 종료한 뒤 Aria 폴더에서 실행하세요.

```bash
git pull --ff-only
npm ci
npm start
```

`main`은 이 프리뷰 릴리스와 같은 커밋을 제공합니다. 정확한 버전을 고정하려면 아래 태그를 선택하세요. 태그를 선택한 상태는 고정 버전이므로 일반 업데이트로 돌아갈 때 먼저 `git switch main`을 실행합니다. 직접 수정한 코드가 있으면 그 변경을 먼저 보관하세요.

```bash
git fetch origin --tags
git switch --detach v0.1.0-alpha.1
npm ci
```

## 추가 음원과 내보내기

기본 곡의 재생과 WAV 내보내기에는 CMake·SFZ 엔진·FFmpeg가 필요하지 않습니다. 더 많은 오케스트라·드럼 음원을 원하면 Node.js·Git·CMake를 준비하고 아래 엔진을 한 번 설치한 뒤 **음원 관리**에서 필요한 팩만 고르세요. [음원 설치 가이드와 조건](docs/SOUND_SETUP.md)

```bash
npm run engine:install:sfizz
```

MIDI/WAV/MP3·악기별 내보내기는 Mac 저장 폴더 선택창으로 저장합니다. MP3에는 `libmp3lame`을 포함한 FFmpeg가 필요합니다(`brew install ffmpeg`). 별도 실행 위치는 `ARIA_FFMPEG`로 지정할 수 있습니다. MIDI는 샘플 고유 주법·믹스의 모든 소리를 보존하지 않으므로 지금 듣는 소리는 WAV로 내보내세요.

## 릴리스와 검증 문서

[릴리스 노트](CHANGELOG.md) · [기능 범위와 벤치 근거](docs/RELEASE_SCOPE.md) · [플랫폼 개요](https://chenjingdev.github.io/aria/) · [오디오 엔진](docs/ENGINE_BACKENDS.md) · [음원 감사](docs/SOUND_LIBRARY_AUDIT.md) · [Windows amd에서 한 설치·제거 검증의 범위](docs/AMD_INSTALL_TEST.md)

## MCP 도구

| 도구 | 역할 |
|---|---|
| `new_song` | 새 곡 생성 — `template`: citypop, lofi, ballad, bossa, edm, chiptune |
| `get_song` / `set_song` | 곡 전체를 JSON 텍스트로 읽기 / 통째로 교체 (대규모 수정용) |
| `list_presets` | 인자 없이 그룹→악기 트리 요약(ID 없음), `instruments`로 악기별 독주/섹션 × 주법 × 출처 → 실제 ID 표(★ 기본값), `group`으로 한 그룹의 악기·주법 이름, `query`/`family`/`source`/`kind`로 검색(녹음 클립은 `kind:"clip"`) |
| `add_track` / `remove_track` / `set_track` | 트랙 추가·삭제·변경(프리셋/아티큘레이션/볼륨/팬/이름). `preset`에는 실제 ID 또는 계층 ID(`violin/section/sustain`, `flute`, `cello/pizzicato`)를 줄 수 있고 곡에는 해석된 실제 ID가 저장됩니다 |
| `set_region_articulation` | 키스위치·CC 프리셋의 선택 마디만 실제 녹음 주법으로 전환 (`null`이면 선택 범위가 트랙 설정을 다시 따름) |
| `set_tempo` / `clear_tempo` | 기준 템포 변경 · 마디별 템포 변화(rit./accel.) 추가·삭제 |
| `add_notes` / `clear_notes` | 노트 추가 / 구간 삭제 |
| `play` / `stop` | 구간 재생(`from_bar`,`to_bar`,`loop`) / 정지 — 반환값에 피크·RMS·클리핑 경고 포함 |
| `export` | MIDI/WAV/MP3 내보내기 (`from_bar`/`to_bar`로 구간 오디오 렌더, `both`는 MIDI+WAV) |
| `save_song` (기본), `load_song` / `list_songs` (full) | 곡 라이브러리(`~/.aria/songs/`) 보관·전환·목록 — new_song/load_song 시 현재 곡은 자동 보존 |

기본 MCP 프로필은 `release`이며 벤치 당시와 같은 37개 도구를 노출합니다. 피드백·A/B·곡 불러오기·MIDI 가져오기 8개는 제외됩니다. 전체 45개가 필요한 개발·실험 환경은 `ARIA_TOOL_PROFILE=full`을 명시하세요. GUI 곡 목록에서 불러오기는 계속 사용할 수 있습니다. `ARIA_HIDE_TOOLS`는 선택한 프로필에서 추가로 도구를 숨깁니다.

브리지 환경 변수로 노출 범위를 좁힐 수 있습니다. `ARIA_HIDE_TOOLS=list_feedback,ab_save,…`(쉼표·공백 구분)를 준 브리지는 그 도구를 도구 목록과 안내문에서 함께 감춥니다. 앱의 능력은 그대로이고, 벤치처럼 사람과의 협업 루프가 없는 자리에서 씁니다. 모르는 이름이 있으면 브리지가 그 이름을 알리고 종료합니다. `ARIA_DATA_DIR`·`ARIA_PORT`·`ARIA_SCAN=0`을 함께 주면 사용자 앱과 별도의 곡·라이브러리·포트를 가진 인스턴스를 자동 시작하며, 음원·팩·엔진은 `~/.aria` 아래 것을 공유합니다. 여기에 `ARIA_DATA_DIR_PER_SESSION=1`을 더하면 브리지 세션마다 `<ARIA_DATA_DIR>/sessions/<시각>-<pid>` 아래에 자기 인스턴스를 띄우므로, 같은 프로필을 동시에 여러 개 돌려도 곡을 공유하지 않습니다.

## 음원 엔진과 샘플 팩

Aria는 자체 파형 합성기를 포함하지 않습니다. 악기와 드럼은 외부 샘플 팩으로 재생하며, 두 포맷을 같은 곡·재생·WAV·스템 경로에서 사용할 수 있습니다.

| 포맷 | 활성 엔진 | 담당 |
|---|---|---|
| SF2/DLS | [`spessasynth_core@4.3.16`](https://github.com/spessasus/spessasynth_core) | SoundFont의 스테레오 링크, 필터, LFO(저주파 진동기), 모듈레이터, 엔벌로프, bank/program, 벨로시티 레이어를 해석 |
| SFZ | 고정 버전의 [`sfizz`](https://github.com/sfztools/sfizz) 로컬 사이드카 | SFZ의 샘플 매핑, 벨로시티 층, 라운드로빈(Round robin, 같은 음의 반복 샘플 순환), 키스위치·CC, 드럼 초크를 해석 |

프리셋이 요구하는 파일·팩·bank·program·키·벨로시티 샘플이 없거나 손상됐으면 재생을 중단하고 원인을 표시합니다. 비슷한 악기나 무음으로 몰래 대체하지 않습니다.

- **GM 경량 팩**: `~/.aria/soundfonts/default.sf2`의 [GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS)를 기본적인 악기·전자음·패드·리드 선택지로 사용합니다
- **Grand Piano(그랜드 피아노)**: `sf-piano-gm`은 경량 GM 피아노, `sf-piano`는 [Salamander Grand Piano](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html) SF2판의 Yamaha C5입니다. 둘은 서로 대신 재생되지 않습니다
- **VSCO 2 CE 전체판(설치됨)**: [공식 저장소](https://github.com/sgossner/VSCO-2-CE)의 원래 SFZ 75개를 그대로 보존하고 보강 entry와 중복 alias를 정리해 462개 카탈로그 항목(음정 악기 78, 드럼·타악 킷 1, Recorded Clip 383)으로 노출합니다. 원본 WAV 3,168개 전부가 실제 재생 항목에 연결돼 있습니다. 키스위치(Key switch, 건반 밖의 제어 음으로 연주법 전환) 프리셋 8개는 UI와 MCP에서 실제 아티큘레이션을 고를 수 있습니다. 라이선스는 CC0-1.0입니다
- **Philharmonia 전체 로컬 팩(설치됨)**: [공식 샘플](https://philharmonia.co.uk/resources/sound-samples/)을 음정 악기 184개, 무음정 one-shot 74개, Recorded Clip(녹음 클립) 1,307개, 합계 1,565개 항목으로 노출합니다. 공식 원본 13,683개 중 정상 파일 13,681개는 전부 재생 가능하고, 원본부터 비어 있던 0-byte 파일 2개는 결함으로 명시합니다. 녹음 클립은 음계 악기로 늘이지 않고 원형 그대로 한 번 재생합니다
- **Salamander Drumkit v4 전체판(설치됨)**: [공식 아카이브](https://archive.org/details/SalamanderDrumkit)의 WAV 536개 전부를 9개 킷·모듈과 1개 미편집 원본 클립으로 노출합니다. 정상 킷은 535개 샘플을 쓰고 44초짜리 반복 킥 원본은 임의로 자르지 않고 별도 Recorded Clip으로 분리했습니다. MIDI key 42의 Hi-hat Closed(하이햇 닫힘)와 Semi-open 1–7(반열림 1–7)은 피스 이름을 고르면 CC64가 자동 설정됩니다

현재 이 컴퓨터의 레지스트리는 **2,114/2,114개가 사용 가능**합니다. 음정 악기 333개와 드럼·타악 90개, 사용자·MCP에 공개된 Recorded Clip 1,691개이며, 드럼·타악과 클립을 합치면 1,781개입니다. 설치 상태는 바뀔 수 있으므로 실제 작업에서는 여전히 `list_presets` 결과를 기준으로 삼습니다.

상단의 **음원 관리**에서 팩의 출처·라이선스·설치 용량·상태를 보고 설치할 수 있습니다. 악기 추가·교체 화면은 이름, 악기군, 출처, 주법으로 검색하며, 미설치 프리셋도 숨기지 않고 사용할 수 없는 이유를 보여 줍니다. 설치 여부와 전체 개수는 로컬 상태에 따라 달라지므로 MCP에서는 `list_presets`를 인자 없이 한 번 호출해 그룹·악기 트리를 보고, `instruments:["Violin","Flute"]`로 악기별 표를 받거나 `add_track`의 `preset`에 `violin/section/sustain` 같은 계층 ID를 바로 씁니다. 계층 ID는 설치된 대표 음원(VSCO 2 CE → Salamander → Philharmonia → VSCO SF2 → GM 순)으로 해석되어 곡에는 실제 ID가 저장되므로, 음원을 새로 설치해도 기존 곡의 소리는 바뀌지 않습니다. 녹음 클립은 `kind:"clip"`을 줄 때만 검색됩니다.

노트 형식: `{bar: 8, beat: 1.5, pitch: "F#3", dur: 0.5, vel: 96}` — beat·dur는 4분음표 단위.
드럼·타악과 Recorded Clip 트랙은 `pitch` 자리에 `list_presets`가 돌려준 정확한 피스 ID를 넣습니다. 공통 GM 킷의 예는 `kick snare rim clap hhc hho tom-l tom-m tom-h crash ride shaker`이고, 녹음 클립은 보통 `play`입니다.

## 사용자가 다루는 표현 파라미터

프리셋에 박혀 있던 음색 상수를 트랙별로 덮어쓸 수 있습니다 (`add_track`·`set_track`).
프리셋 기본값으로 되돌리는 건 `set_track`에 `null`을 줍니다.
UI와 문서에서는 원래 음악·오디오 용어를 먼저 쓰고 바로 감각적인 한국어 설명을 붙여, 비음악인도 소리를 조절하면서 용어에 가까워질 수 있게 합니다.

| 파라미터 | 범위 | 쓰임 |
|---|---|---|
| `velRange` | 0~1 (공통 기본: 선율 0.65, 드럼 0.6; 프리셋별 기본값 우선) | 벨로시티 범위(Velocity range, 악보의 강약 전달 폭). `0`이면 모든 노트를 MIDI velocity 64로 보내고, `1`이면 악보 값을 그대로 보냅니다. 원본 프리셋의 강약 레이어와 음색 변화가 함께 반응하므로 고정 dB 폭으로 해석하지 않습니다 |
| `reverb` | 0~1 | 리버브(Reverb, 공간에서 되돌아오는 잔향) 센드 양 |
| `eqLow` | -12~12dB | 저역 EQ(Low EQ, 200Hz 부근의 무게와 웅웅거림) |
| `eqMid` | -12~12dB | 중역 EQ(Mid EQ, 1kHz 부근의 박스톤과 존재감) |
| `eqHigh` | -12~12dB | 고역 EQ(High EQ, 4kHz 부근의 밝기와 날카로움) |

트랙 볼륨은 파트 전체의 크기, 팬(Pan, 좌우 위치)은 원본 스테레오를 유지한 채 좌우 균형을 조절합니다. 어택(Attack, 소리가 시작되는 성질), 릴리스(Release, 음을 놓은 뒤 남는 여운), 비브라토(Vibrato, 음높이의 주기적인 떨림), 앙상블(Ensemble, 여러 연주자가 함께 내는 편성)은 더 이상 트랙 효과로 노출하지 않습니다. 이런 차이가 필요하면 실제로 그 성질이나 주법이 녹음·프로그램된 샘플 프리셋을 선택합니다.

키스위치·CC 프리셋은 트랙 상단에서 전체 기본 **Articulation (연주법)**을 고를 수 있고, 타임라인의 마디 구간을 드래그한 뒤 **직접 다듬기**에서 그 구간만 다른 주법으로 바꿀 수 있습니다. MCP에서는 `set_region_articulation({track, from_bar, to_bar, articulation})`을 사용합니다. 구간 값은 겹친 기존 범위를 대체하고 `articulation:null`은 선택 범위만 트랙 설정으로 되돌립니다. 주법은 각 음이 시작되는 마디에서 결정되므로, 경계를 가로질러 이미 울리고 있는 긴 음의 샘플이 중간에 갑자기 바뀌지는 않습니다. 마디 삽입·잘라내기·복제와 undo/redo에도 함께 따라갑니다.

**템포 변화** — `set_tempo({bpm, from_bar, ramp})`. `from_bar` 없이 부르면 기준 템포, 주면 그 마디부터 전환.
`ramp:true`는 **직전 변화점부터** 선형으로 변합니다(rit./accel.). 끝 4마디만 늘어지게 하려면 앵커를 먼저 두세요:

```
set_tempo({bpm: 92, from_bar: 13})              # 앵커
set_tempo({bpm: 58, from_bar: 16, ramp: true})  # 13→16마디에서 서서히
```

`clear_tempo({from_bar})`로 삭제(생략하면 전부, 기준 템포는 유지).

**변박** — `new_song({time_sig: [7,8]})`. `[3,4] [5,4] [6,8] [13,16]` 모두 지원하며 `beat` 상한이 박자표에 자동 연동됩니다.

## 알려진 한계

- 재생은 macOS(`afplay`) 전용 — 다른 OS는 `export`로 WAV를 뽑아 들어야 합니다
- 루프 재생은 afplay 재스폰 방식이라 반복 사이 ~100ms 틈이 있음
- 마스터에는 -0.3dBFS look-ahead 리미터와 소프트 클리퍼가 있지만 true-peak 납품 검사는 아닙니다. `play`의 리미터 감쇄·피크·LUFS 보고를 보고, 지속적으로 많이 눌리면 원래 트랙 밸런스를 고칩니다
- 노트별 pan과 임의의 일반 MIDI CC 편집은 없습니다. 다만 프리셋이 선언한 키스위치·CC는 트랙 전체 `articulation`, `set_region_articulation`, 또는 드럼 피스 ID를 고르면 엔진이 실제 제어값으로 보냅니다. **Pitch Bend (피치 벤드, 음이 울리는 동안 시작 음높이에서 끝값까지 미끄러짐)**는 노트별 단방향 선형 곡선입니다. SFZ는 Articulation 렌더 층마다 MIDI 채널 16개 한도가 있어, bend가 있는 트랙의 모든 편집을 확정하기 전에 선택 밖의 기존 bend와 같은 음높이 중첩까지 실제 엔진과 같은 방식으로 계산합니다. 초과하는 bend·붙여넣기·주법 병합·구조 편집은 곡·자동 저장·undo를 바꾸기 전에 원자적으로 거부합니다
- SF2/DLS는 비압축 PCM만 처리합니다. 압축 샘플을 담은 SF3는 명시적으로 지원하지 않습니다
- SFZ용 sfizz는 현재 동기식 로컬 사이드카입니다. 대형 팩을 여러 트랙에서 동시에 부를 때 앱과 격리된 작업 프로세스로 옮기는 최적화는 아직 남았습니다
- 큰 SF2는 필요한 preset/key/velocity만 남겨 렌더하지만, 처음 파일을 읽고 해석할 때 순간 메모리 사용량이 큽니다
- 레가토(Legato, 음 사이를 실제 연주처럼 이어 주는 주법)는 단순 릴리스 효과가 아닙니다. 음원에 녹음된 전이 샘플과 그 매핑이 있어야 true legato(실제 전이 레가토)를 재현할 수 있습니다
- WAV·MP3 렌더는 한 번에 10분까지 — 긴 곡은 `export({from_bar, to_bar})`로 나눠 뽑습니다
- MIDI 내보내기는 멜로디 트랙 15개까지(채널 한계)
- 사용 중인 트랙에 전체 또는 실제 노트가 놓인 구간의 `articulation`을 명시했다면 portable MIDI 내보내기를 중단합니다. 표준 MIDI의 GM 근사는 그 선택을 안전하게 보존하지 못하므로 현재 소리는 WAV로 내보냅니다. GM 근사가 필요하면 `set_region_articulation(... articulation:null)`로 구간 선택을 지우고, 필요하면 `set_track(... articulation:null)`로 트랙 전체도 기본 주법에 되돌린 뒤 MIDI를 내보냅니다. 노트가 없는 빈 구간과 implicit 기본 주법, 드럼 피스에 선언된 CC는 기존처럼 MIDI로 내보냅니다
- 마디 안에서의 박자표 변경은 불가(곡 단위 고정)
- GUI는 한 인스턴스만 사용하는 구조입니다. 포트 충돌 시 7788→7789…로 자동 이동하고 MCP도 같은 인스턴스를 따라갑니다

## 개발

```bash
npm test                     # 렌더 무결성·표현·템포·MCP 브리지·동적 포트 회귀 테스트
node test/spessa-engine.js   # SpessaSynth SF2 어댑터의 스테레오·레이어·오류·fallback 차단 회귀 테스트
node test/demo.js            # 시티팝 데모를 API로 작곡해 재생 (서버가 떠 있어야 함)
node test/demo-expression.js # 표현 데모 — 5/4 변박 + velocity 크레셴도 + 리타르단도

# 특정 앱을 지정하려면: ARIA_URL=http://127.0.0.1:7791 node test/demo.js
```

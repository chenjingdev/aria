# ◆ aria — LLM이 제어하는 상주 작곡 앱

"시티팝 느낌 곡 하나 작곡해줘"라고 하면, Claude Code(또는 다른 MCP 클라이언트)가 aria의 도구를 호출해
실제로 곡을 만들고 · 스피커로 재생하고 · 피아노롤 GUI에 실시간으로 그려주는 앱입니다.

- 곡은 실행 중인 앱 안에 살고(자동 저장 `~/.aria/song.json`), LLM은 MCP 도구로 조작합니다
- 사람은 브라우저 피아노롤 GUI에서 실시간으로 확인·재생·프리셋 변경
- 재생은 내장 순수 JS 신스 → WAV 렌더 → macOS `afplay` (GUI 없이도 소리가 남)
- MIDI/WAV 내보내기 (기본 위치 `~/Music/aria/`)

## 설치·등록

```bash
cd aria && npm install

# Claude Code에 MCP 브리지로 등록 (모든 프로젝트에서 사용)
claude mcp add -s user aria -- node /절대/경로/aria/src/mcp-bridge.js
```

새 Claude Code 세션에서 "발라드 풍으로 8마디 스케치해서 들려줘"라고 하면 됩니다.
첫 도구 호출 때 Aria 앱이 꺼져 있으면 자동으로 열립니다. GUI는 7788을 우선 사용하되 이미 다른 앱이 쓰고 있으면
다음 빈 포트로 이동하며, MCP 브리지는 `~/.aria/runtime.json`을 읽어 실제 주소에 자동으로 연결합니다.
`get_song` 결과에도 현재 GUI 주소가 포함됩니다.

GUI만 띄워보려면: `npm start`. MCP 브리지만 직접 시험하려면: `npm run mcp`.

## MCP 도구

| 도구 | 역할 |
|---|---|
| `new_song` | 새 곡 생성 — `template`: citypop, lofi, ballad, bossa, edm, chiptune |
| `get_song` / `set_song` | 곡 전체를 JSON 텍스트로 읽기 / 통째로 교체 (대규모 수정용) |
| `list_presets` | 멜로디 프리셋 13종 · 드럼 킷 3종 · 템플릿 목록 |
| `add_track` / `remove_track` / `set_track` | 트랙 추가·삭제·변경(프리셋/볼륨/팬/이름) |
| `set_tempo` / `clear_tempo` | 기준 템포 변경 · 마디별 템포 변화(rit./accel.) 추가·삭제 |
| `add_notes` / `clear_notes` | 노트 추가 / 구간 삭제 |
| `play` / `stop` | 구간 재생(`from_bar`,`to_bar`,`loop`) / 정지 — 반환값에 피크·RMS·클리핑 경고 포함 |
| `export` | MIDI/WAV 내보내기 (`from_bar`/`to_bar`로 구간만 WAV 렌더) |
| `save_song` / `load_song` / `list_songs` | 곡 라이브러리(`~/.aria/songs/`) 보관·전환·목록 — new_song/load_song 시 현재 곡은 자동 보존 |

## SoundFont (샘플 프리셋)

`~/.aria/soundfonts/default.sf2`에 GM 사운드폰트를 두면 피아노·현악·목관·금관·기타·베이스·드럼 프리셋이 열립니다. 기존 곡의 `sf-violin`, `sf-cello`, `sf-sax`, `sf-horn`, `sf-orch-kit` 같은 id도 이 기본 GM 폰트로 재생됩니다.

- 기본 제공 스크립트 없이 파일만 두면 됨 (권장: [GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS) ~32MB, 무료 라이선스. `ARIA_SF2` 환경변수로 다른 경로 지정 가능)
- **다중 사운드폰트**: 같은 폴더에 `salamander.sf2`([Salamander Grand Piano](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html) SF2판, 1.3GB, CC-BY 3.0 © Alexander Holm)를 두면 `sf-piano`가 자동으로 이걸 우선 사용 — 벨로시티 16층의 진짜 피아노. 프리셋의 `font` 필드로 어떤 프리셋이든 전용 폰트 지정 가능
- 현악·목관·금관과 `sf-orch-kit`은 재배포 가능한 기본 GM 폰트의 대응 악기로 재생합니다. Philharmonia 원본 샘플을 다시 묶은 전용 폰트는 배포 조건과 품질 대비 효용 때문에 제품 프리셋에서 사용하지 않습니다.
- **VSCO 2 CE 색채 악기**: `vsco.sf2`(9MB, `tools/build-vsco.mjs`, [VSCO 2 Community Edition](https://github.com/sgossner/VSCO-2-CE) CC0) → `sf-harp sf-glockenspiel sf-marimba sf-xylophone sf-timpani sf-cello-pizz`. 팀파니는 파일명에 음정이 없어 자기상관 f0 검출로 매핑(렌더 검증: C2 악보 → 66.2Hz)
- **Salamander 밴드 드럼**: `salamander-kit.sf2`(10MB, `tools/build-salamander.mjs`, [Salamander Drumkit](https://archive.org/details/SalamanderDrumkit) 퍼블릭 도메인 © Alexander Holm) → 드럼 킷 `sf-band-kit`(표준 피스, 벨로시티 최대 6층). e808-kit의 실녹음 레이어도 이 킷을 우선 사용
- 신스 프리셋과 완전히 같은 방식으로 사용 — 같은 노트 모델, 같은 velRange/attack/release/reverb 오버라이드
- 어쿠스틱 리얼리즘(피아노·현악·기타)은 sf-*, 전자음·개성은 내장 신스가 유리
- 파일이 없으면 sf-* 사용 시 명확한 에러가 나고, 나머지 기능은 영향 없음 (전용 폰트가 없는 프리셋은 default.sf2로 폴백)

노트 형식: `{bar: 8, beat: 1.5, pitch: "F#3", dur: 0.5, vel: 96}` — beat·dur는 4분음표 단위.
드럼 트랙은 pitch 자리에 피스 이름: `kick snare rim clap hhc hho tom-l tom-m tom-h crash ride shaker`.

## 표현 파라미터

프리셋에 박혀 있던 음색 상수를 트랙별로 덮어쓸 수 있습니다 (`add_track`·`set_track`).
프리셋 기본값으로 되돌리는 건 `set_track`에 `null`을 줍니다.

| 파라미터 | 범위 | 쓰임 |
|---|---|---|
| `velRange` | 0~1 (기본 0.65) | velocity가 음량에 미치는 폭. **기본 0.65는 vel 1~127이 약 9dB**라 악센트용이고, `1`로 올리면 **약 42dB**가 되어 크레셴도를 velocity만으로 만들 수 있습니다 |
| `attack` | 0~2초 | 음이 최대 음량에 닿기까지. 0.1 이상이면 부드럽게 부풀어 오릅니다 |
| `release` | 0~8초 | 음을 뗀 뒤 남는 여운. 아르페지오가 뚝뚝 끊기면 0.8~2로 올려 음끼리 겹치게 합니다 |
| `reverb` | 0~1 | 리버브 센드 양. 프리셋 기본(0.03~0.5)을 덮어씁니다 |

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
- 마스터 리미터 없음 — 3차 소프트 클리퍼만 있어 겹치는 노트가 많으면 점진적으로 왜곡됩니다. `play`가 돌려주는 클리핑 경고를 보세요
- 노트별 pan 없음(트랙 단위), CC·피치벤드·비브라토 없음
- WAV 렌더는 한 번에 10분까지 — 긴 곡은 `export({from_bar, to_bar})`로 나눠 뽑습니다
- MIDI 내보내기는 멜로디 트랙 15개까지(채널 한계)
- 마디 안에서의 박자표 변경은 불가(곡 단위 고정)
- GUI는 한 인스턴스만 사용하는 구조입니다. 포트 충돌 시 7788→7789…로 자동 이동하고 MCP도 같은 인스턴스를 따라갑니다

## 개발

```bash
npm test                     # 렌더 무결성·표현·템포·MCP 브리지·동적 포트 회귀 테스트
node test/demo.js            # 시티팝 데모를 API로 작곡해 재생 (서버가 떠 있어야 함)
node test/demo-expression.js # 표현 데모 — 5/4 변박 + velocity 크레셴도 + 리타르단도

# 특정 앱을 지정하려면: ARIA_URL=http://127.0.0.1:7791 node test/demo.js
```

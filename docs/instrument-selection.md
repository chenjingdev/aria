# 음원 선택과 비교

`list_presets`의 계층·기본값은 유지하면서, 선택 전에 실제 음원 정보를 조회하는 두 도구를 추가했다. 두 도구 모두 현재 곡을 변경하지 않는다.

## 실제 음원 정보

```json
{"preset":"vsco-clarinet-keyswitch","pitch":"G4","velocity":80,"duration":0.25}
```

이 인자를 `inspect_instrument`에 전달하면 주법별 샘플 음역·velocity 구간과 짧은 단음의 실제 렌더 측정치를 받는다. `pitch`를 생략하면 샘플 정의만 조회한다. 측정 시 스피커로 재생하지 않는다.

- 음역은 실제 renderer가 쓰는 SFZ parser의 키·velocity·keyswitch·CC 조건에서 나온다. 중간에 비어 있는 음역을 최솟값/최댓값으로 덮어 표시하지 않는다.
- `gateRmsDb`: 음을 누르는 동안의 RMS dBFS.
- `earlyRelativeDb`: 첫 60ms RMS를 누르는 동안의 RMS와 비교한 dB.
- `spillRelativeDb`: 음을 뗀 뒤 100–300ms RMS의 상대 dB.
- SFZ에 적힌 attack/release와 녹음 안에 들어 있는 발음·여운은 다를 수 있어, 정의값과 실제 측정값을 구분한다.
- 이 값은 지정한 음높이·세기·길이의 신호 특성이다. 음질 점수나 악기 전체의 우열이 아니다. 음역·세기·주법·round-robin 순서가 달라지면 결과도 달라질 수 있다.
- 선택 단계 상세 음역과 단음 측정은 현재 SFZ용이다. SoundFont는 미검증으로 명시하며 실제 렌더의 기존 검사를 유지한다.

## 현재 악보에 맞는 후보

```json
{"track":"클라리넷","from_bar":33,"to_bar":40,"articulation":"staccato","limit":5}
```

`find_presets`는 같은 악기와 독주/합주 편성 안에서 해당 음표의 실제 pitch·velocity가 지원되는 후보를 찾는다. `articulation`을 생략하면 현재 구간의 주법을 사용한다. 여러 주법이 섞인 구간은 범위를 좁히거나 찾을 주법을 명시한다. 타악은 피스 매핑이 달라서 이 치환 후보 검색 대상에서 제외한다.

같은 물리 샘플과 재생 정의를 공유하는 고정 주법/키스위치 경로는 한 후보로 묶고 다른 ID를 `equivalents`에 남긴다. 샘플만 같고 envelope·gain·CC 등이 다르면 합치지 않는다. 재생 불가 후보와 미검증 후보도 따로 반환한다. 후보 순서는 음질 순위가 아니며 기존 곡의 ID나 음표를 자동으로 교체하지 않는다.

## 재현 가능한 비교

```sh
node tools/bench-instruments.mjs PATH_TO_FROZEN_SONG_JSON OUTPUT_DIRECTORY
node tools/compare-instruments.mjs OUTPUT_DIRECTORY
```

첫 명령은 악보를 SHA-256으로 식별하고, 트랙별 같은 음높이에서 0.25초 음을 velocity 48/62/63/80/110으로 연주한다. 매번 실제 렌더를 실행하므로 설치 음원이 바뀐 뒤 예전 오디오 측정치를 재사용하지 않는다.

두 번째 명령은 이 실험의 좁은 목표인 **짧은 음의 발음과 분리감**에 맞춘 후보만 검토한다. 실제 짧은 음들의 낮은/중간/높은 음역에서 추가 검사하고, 3개 중 2개 이상에서 초반 상대 RMS와 음을 뗀 뒤 분리감이 모두 6dB 이상 개선될 때만 적용한다. 이 음역 검사는 첫 측정 음높이와 겹칠 수 있으며 독립 표본 통계 검정이 아니다. 긴 음·다른 악기는 유지한다.

음표·velocity·길이·위치·템포·구간 이름을 악기별로 보존하는 단언을 실행하고, 바뀐 파트의 음량은 9–40마디로 맞춘다. 전체 합주와 구간별 전후 MP3는 LUFS를 맞춰 출력한다. 클라리넷 단독 비교는 33–40마디를 사용한다. **음악적 선호가 개선됐는지는 전후 청취로 판단한다.**

2026-09-06 실행 자료는 `output/instrument-bench-2026-09-06/`의 `REPORT.md`, `probe-results.json`, `comparison-results.json`, 원본/개선 악보와 전후 MP3에 있다. 이 실행에서는 바이올린과 플루트 후보가 추가 음역 검사를 통과하지 못했고 클라리넷만 적용했다.

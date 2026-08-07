# 편곡과 오케스트레이션

편곡은 트랙을 많이 추가하는 일이 아니라 청자가 무엇을 하나의 소리로 묶고 무엇을 별도 선으로 듣게 할지 설계하는 일이다.

## 역할을 먼저 부여한다

각 트랙을 다음 중 하나로 설명한다.

- focal: 지금 듣게 할 주인공.
- pulse: 시간의 기준.
- bass foundation: 저역과 화성 바닥.
- harmonic support: 색과 중간층.
- counterline: focal과 대화하는 독립 선.
- transition: fill, riser, pickup, crash, cadence cue.
- atmosphere: 공간·지속·noise floor·texture.

한 구간에서 focal이 둘이면 서로 교대하거나 register/rhythm을 분리한다. 역할 없는 트랙은 제거 후보로 둔다.

## auditory scene 관점

청각은 복합음을 onset, harmonicity, pitch, timbre, 위치, 연속성 단서로 묶거나 분리한다. [S40]

### blend를 원할 때

- onset과 note ending을 맞춘다.
- articulation과 dynamics를 함께 움직인다.
- 가까운 register와 유사 timbre를 사용한다.
- chord voicing의 균형을 유지한다.
- 같은 공간과 reverb 계열을 쓴다.

### 독립 stream을 원할 때

- register를 띄운다.
- rhythm과 onset을 엇갈린다.
- attack/decay 또는 timbre를 대비한다.
- contour 방향을 다르게 한다.
- level/pan/공간을 보조 단서로 쓴다.

오케스트레이션 연구의 taxonomy도 blend, stream, segmentation을 핵심 기능으로 정리한다. [S58]

**[연구: 제한]** 동질 음색의 동시 성부가 3개에서 4개로 늘 때 식별이 급격히 어려워지고 내성·먼저 끝나는 성부가 더 놓치기 쉬웠다. 모든 편성의 절대 한계는 아니지만 독립 내성 수를 무한히 늘리지 말라는 근거다. [S59]

## 충돌을 푸는 순서

EQ부터 만지지 말고 다음 순서로 가장 작은 해결을 찾는다.

1. 불필요한 음/트랙 제거.
2. octave/register 이동.
3. onset과 rhythm 분리.
4. note duration/release 단축.
5. articulation/timbre 대비.
6. section별 gain과 track level.
7. pan과 reverb.
8. 마지막으로 제한된 EQ.

이 순서는 원음을 보존하면서 원인을 고치기 쉽다.

## register 지도

고정 음역표보다 현재 프리셋·멜로디·역할을 듣는다. 그래도 다음 층은 유용한 출발점이다.

- sub/fundamental: kick, sub bass, contrabass/tuba의 바닥. 동시 지속음을 아낀다.
- bass: bass line와 낮은 chord support. rhythm과 release를 분명히 한다.
- low-mid: 남성 저음, cello, guitar/piano 왼손, pad의 체온. 가장 쉽게 혼탁해진다.
- mid: chord identity와 많은 악기의 본체. 동시 트랙 수를 관리한다.
- high-mid: focal presence, attack, 일부 brass/string/lead의 선명도. 과밀하면 피곤하다.
- air/high: cymbal, breath, shimmer, upper harmonics. 밝기와 공간을 주지만 주인공을 가릴 수 있다.

실제 악기 프리셋은 악기 가능한 음역과 샘플 품질을 모두 고려한다. 극단 음역은 반드시 재생해 확인한다.

## 밀도를 시간에 배치한다

밀도는 note count만이 아니다.

- 동시 성부 수.
- onset 빈도.
- sustained tail과 reverb overlap.
- register span.
- 음색의 spectral width.
- doubling과 ensemble 수.

verse→chorus 대비를 만들 때 이 중 2–3개만 명확히 바꾸고 나머지는 anchor로 남긴다.

### 얇게 만드는 법

- chord의 5도·doubling·inner note를 생략.
- bass를 매 onset이 아니라 구조점에만 둠.
- pad duration/release를 줄임.
- drum subdivision을 줄이고 transition cue만 남김.
- focal melody 사이에 충분한 빈칸을 둠.

### 크게 만드는 법

- focal을 octave/unison으로 선택적 doubling.
- bass와 strong beat arrival를 정렬.
- register span을 넓힘.
- 새로운 countermelody보다 harmonic support/transition color를 우선.
- ensemble, velocity range, region gain을 단계적으로 사용.

## 악기 선택

악기 이름보다 소리의 기능을 먼저 정하고 `list_presets`의 실제 가용 항목을 고른다.

| 기능 | 찾을 특성 | Aria 조절 후보 |
|---|---|---|
| intimate focal | 명확한 중역, 작은 ensemble, 낮은 reverb | solo sample, 낮은 ensemble, 짧은 공간 |
| warm support | 부드러운 attack, 중저역 body, 긴 sustain | attack/release, reverb, high EQ 절제 |
| rhythmic support | 빠른 attack, 짧은 decay, 빈칸 | pluck/pizz/keys, duration, low release |
| wide lift | 넓은 register, layered sustain, 선명한 top | ensemble, pan 분산, register doubling |
| dark tension | 낮은 register, 느린 변화, 제한된 brightness | low winds/strings/synth, attack, high EQ 절제 |
| sparkle | 짧은 고역 transient, 드문 배치 | glock/mallet/cymbal, 낮은 density |

음색도 감정 단서지만 악기=감정의 고정 사전으로 쓰지 않는다. [S09]

## 오케스트라/시네마틱

- family별 역할을 나눈다: strings=지속·운동·서정, winds=색·독주·내성, brass=중량·선명한 도착, percussion=형식 신호·질량.
- 전체 family가 늘 같이 연주하지 않게 한다.
- 독주와 ensemble을 구분한다. Aria의 `ensemble`은 지원 샘플의 두께를 늘리지만 실제 divisi/다중 아티큘레이션을 대체하지 않는다.
- 긴 attack 악기는 목표 onset보다 앞에 데이터가 있어야 할 수 있다. 숫자 격자보다 지각 onset을 듣는다. [S60]
- cresc.에서 volume만 올리지 말고 register, bow/attack 느낌, doubling, harmonic rhythm, percussion을 단계적으로 추가한다.
- climax 직전 silence 또는 단일 family 축소는 대비를 크게 할 수 있다.

전통 오케스트레이션 교재는 악기 음역·음색·결합·balance를 위한 참고이고, 실제 Aria 프리셋의 샘플·렌더 동작을 항상 우선 확인한다. [S63]

## 스테레오와 공간

- bass foundation과 핵심 kick은 대체로 중앙을 출발점으로 둔다.
- 서로 같은 register·rhythm의 support 둘을 약간 나눌 수 있다.
- pan은 빈 공간을 만들지만 경쟁하는 음표·register 문제를 해결하지 못한다.
- reverb는 공유 공간을 만들고 긴 tail은 실질적 밀도를 늘린다.
- 넓음이 필요할 때 모든 트랙을 양끝으로 보내지 말고 중심 anchor를 남긴다.

## 편곡 감사

구간마다 다음 표를 내부적으로 채운다.

| 구간 | focal | pulse | bass | support | transition | 의도한 빈칸 |
|---|---|---|---|---|---|---|

빈칸을 설명하지 못하면 우연한 공백일 수 있고, 모든 칸이 항상 가득하면 대비가 부족할 수 있다.

mute/solo로 역할을 하나씩 확인하되 마지막 판정은 전체 mix에서 한다.

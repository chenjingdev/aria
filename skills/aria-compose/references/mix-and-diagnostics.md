# 믹스와 진단

Aria의 믹스 도구는 감각적으로 튀는 문제를 고치는 데 집중한다. 전문 마스터링을 흉내 내기보다 원인을 작곡·편곡·연주·레벨 중 올바른 층에서 찾는다.

## 진단 순서

1. **구성**: 불필요한 note/part가 있는가.
2. **register**: 같은 대역에 너무 많이 모였는가.
3. **timing/duration**: onset과 tail이 겹치는가.
4. **performance**: velocity와 accent가 의도와 맞는가.
5. **balance**: track/region level이 맞는가.
6. **tone**: 프리셋의 attack/release 성질, reverb, EQ가 문제인가.
7. **master report**: limiter, peak, LUFS가 무엇을 알려 주는가.

앞 단계에서 해결되면 뒤의 처리를 추가하지 않는다.

## “무엇이 튄다”를 고치는 법

### 특정 악기가 너무 크다

- 같은 구간을 전체→mute→solo 순으로 듣는다.
- 모든 곳에서 크면 track volume을 낮춘다.
- 일부 구간만 크면 `set_region_gain`을 쓴다.
- 몇 음만 크면 `set_velocity` 또는 note 목록으로 고친다.
- 프리셋의 attack/brightness가 loudness보다 존재감을 만든 것인지 확인한다.

### 한 순간만 튄다

- 같은 onset의 kick, bass, chord, crash가 겹쳤는지 본다.
- crash/transition note의 velocity와 duration을 줄인다.
- chord voicing·bass octave를 분리한다.
- 리미터로 숨기지 말고 순간의 원인을 먼저 고친다.

### 박자가 미묘하게 어긋난다

- 기준 pulse를 solo로 확인한다.
- `quantize` strength 1이 아닌 부분 교정을 먼저 시험한다.
- kick/bass 또는 melody/accompaniment 중 어떤 관계가 늦는지 구분한다.
- 전체 `humanize`로 덮지 않는다. 구조화된 지연이 아니면 grid가 더 나을 수 있다. [S20][S23][S24]

### 음질이 탁하다

- low-mid의 동시 sustain과 note duration을 줄이거나, 릴리스(Release, 음을 놓은 뒤 남는 여운)가 짧은 프리셋을 고른다.
- chord root/doubling 또는 한 support를 제거한다.
- reverb send와 pad tail을 줄인다.
- register를 옮긴 뒤에도 남으면 `eqLow`/`eqMid`를 작게 조절한다.

### 쨍하고 피곤하다

- high-register doubling, cymbal density, short bright transients를 줄인다.
- focal과 support가 같은 high-mid에서 경쟁하는지 본다.
- velocity, 프리셋의 어택(Attack, 소리가 시작되는 성질), `eqHigh`, reverb send와 tail overlap을 순서대로 확인한다. Early reflection energy는 현재 Aria에서 직접 조절할 수 없다.

## velocity, gain, arrangement는 다르다

- note velocity: 개별 accent, phrase shape, 샘플 layer/음색 반응.
- `velRange`: 벨로시티 범위(Velocity range, 악보의 강약 전달 폭). `0`이면 모든 노트를 MIDI velocity 64로, `1`이면 악보 값을 그대로 샘플 엔진에 보내며 원본의 강약 레이어와 음색 반응도 함께 달라진다.
- track volume: 파트 전체의 기본 균형.
- `set_region_gain`: 한 구간의 balance나 점층.
- arrangement density: 실제로 울리는 에너지와 역할 수.
- register/orchestration: 크기·명료도·감정의 지각.

크레셴도에는 하나만 정답이 없다. 작은 velocity ramp + register 확장 + 한 트랙의 늦은 등장처럼 여러 축을 나눠 쓰면 리미터를 덜 밀면서 더 크게 느껴질 수 있다.

## 어택(Attack), 릴리스(Release), 리버브(Reverb)

- 어택(Attack, 소리가 시작되는 성질)이 느리면 note 데이터보다 지각 onset이 늦을 수 있다. 그루브가 밀리는 문제를 timing만으로 보지 않는다. [S60]
- 릴리스(Release, 음을 놓은 뒤 남는 여운)가 길면 음 사이의 빈틈이 덜 들리고 공간감이 늘 수 있지만 bass/low-mid overlap도 늘어난다. transition sample(전이 녹음)과 전용 매핑이 없으면 true legato(실제 전이 레가토)를 만들지는 못한다.
- 리버브(Reverb, 공간에서 되돌아오는 잔향)는 깊이와 결속을 주지만 articulation과 phrase boundary를 흐릴 수 있다.
- Aria는 attack/release를 트랙 효과로 바꾸지 않는다. 문제가 프리셋 자체의 시작·여운이라면 note duration과 편곡을 먼저 고치고, 필요한 경우 그 성질이 실제로 들어 있는 다른 프리셋·주법을 고른다.
- 공간을 넓히려면 모든 트랙의 reverb를 크게 하지 말고 foreground는 더 건조하게, background는 더 젖게 만드는 대비를 고려한다.

## EQ

Aria의 EQ는 세 개의 제한된 톤 보정이다.

- `eqLow`: 200Hz shelf. 저역 무게/웅웅거림.
- `eqMid`: 1kHz peaking. 박스톤/존재감.
- `eqHigh`: 4kHz shelf. 밝기/날카로움/공기감.

**[출발점]** EQ는 한 번에 ±1–3dB 정도의 작은 변화부터 A/B한다. 이는 보편 임계값이 아니다. 큰 EQ가 필요하면 프리셋·register·note density·프리셋의 release 성질이 더 근본 원인인지 본다.

## 리미터와 레벨 보고서

**[사실]** 현재 Aria 렌더에는 기본 마스터 리미터가 있고 ceiling은 -0.3dBFS다. `play`는 peak, RMS, LUFS, clip/limiter 정보를 돌려준다. [S69]

이 LUFS는 BS.1770-4 계열 알고리즘을 따른 내부 진단값이지만 공식 적합성 시험을 거친 납품 미터는 아니다. peak와 limiter ceiling은 sample peak 기준이라 dBTP true peak를 보증하지 않는다. Aria 수치만으로 방송·스트리밍 규격 통과를 선언하지 않는다. [S51][S69]

- peak: 가장 큰 순간. 체감 음량 전체를 말하지 않는다.
- RMS/LUFS: 평균적 에너지·체감 음량의 비교 단서.
- limiter gain reduction: 들어오는 mix가 ceiling을 얼마나 자주/강하게 넘는지 보여 주는 단서.
- LRA: 시간에 따른 loudness 범위의 한 측면. 감정 다이내믹 전체와 같지 않다.

리미터가 짧은 peak를 가볍게 잡는 것은 정상일 수 있다. **[출발점]** 여러 구간에서 약 3dB 이상의 감쇄가 계속 보이면 track balance, 동시 onset, bass, velocity, density를 먼저 재검토한다. 이 숫자는 장르나 음질을 판정하는 표준이 아니라 원인 조사를 시작할 실무 신호다.

## LUFS를 목표 숫자로 오해하지 않는다

- ITU-R BS.1770-5는 loudness와 true-peak **측정 알고리즘**을 정의한다. [S51]
- EBU R 128의 -23 LUFS는 방송 프로그램 정규화 권고다. 모든 음원 제작 목표가 아니다. [S52]
- AES TD1008은 스트리밍 전달/정규화 상호운용성을 위한 수치를 제안하면서 content production target이 아니라고 명시한다. [S53]

따라서 Aria 스킬은 장르별 고정 LUFS를 강제하지 않는다.

1. 같은 곡의 A/B를 비교한다.
2. section 간 의도한 대비가 유지되는지 본다.
3. limiter가 편곡 문제를 지속적으로 수리하지 않는지 본다.
4. 실제 delivery profile이 주어졌을 때만 해당 표준을 별도 검토한다.

## A/B 방법

- A와 B의 재생 범위와 시작점을 같게 한다.
- 가능하면 체감 음량 차이만으로 B가 좋아 보이지 않게 level을 맞춘다.
- 한 번에 한 질문만 비교한다: groove, focal clarity, climax, warmth, width.
- **[출발점]** 보통 5–15초 안팎의 핵심 구간과 필요한 전환 lead-in부터 비교하되, 음악 문장이 더 길면 문장 전체를 듣는다.
- 더 큰/밝은 쪽을 자동 선택하지 않는다. brief에 더 맞는 쪽을 선택한다.

## 완료 진단

- 시작 4–8마디: 정체성과 focal이 들리는가.
- 각 전환: 변화가 너무 늦거나 갑작스럽지 않은가.
- 가장 밀집한 구간: focal, bass, backbeat가 구분되는가.
- 가장 조용한 구간: noise가 아니라 의도된 여백인가.
- 마지막: note tail/reverb가 잘리거나 불필요하게 길지 않은가.
- 전체: limiter가 상시 수리 중이지 않은가.
- 내보내기: MIDI가 mix/timbre를 보존하지 않는 점을 사용자에게 알렸는가. [S54][S55]

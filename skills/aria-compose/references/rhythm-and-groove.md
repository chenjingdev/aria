# 리듬과 그루브

groove는 “노트를 조금씩 틀리게 놓는 것”이 아니다. 명확한 pulse, 예상 가능한 몸의 기준, 적절한 싱코페이션, 파트 사이의 관계, 음색의 attack이 함께 만든다. [S18][S60]

## 먼저 기준 격자를 만든다

1. meter와 subdivision을 정한다.
2. 몸이 잡을 기준을 kick, snare/clap, bass, chord attack 중 어디에 둘지 정한다.
3. quantized 버전으로 pocket을 확인한다.
4. syncopation과 swing을 구조적으로 더한다.
5. microtiming은 마지막에 A/B한다.

기준이 약한데 timing을 흔들면 그루브가 아니라 위치 오류가 된다.

## 그루브를 여섯 축으로 본다

| 축 | 낮음 | 높음 |
|---|---|---|
| beat salience | 떠 있고 모호함 | 강박이 분명함 |
| subdivision density | 넓고 느슨함 | 촘촘하고 추진력 있음 |
| syncopation | 정박 중심 | 약박 공격·강박 회피가 많음 |
| swing/asymmetry | 등분 | long–short 또는 관계적 지연 |
| interlock | 파트가 함께 침 | 파트가 빈칸을 나눠 가짐 |
| timing stability | 정확히 반복 | 체계적/연주적 편차 |

한꺼번에 모두 높이지 않는다. 예: funk는 beat를 명확히 유지하면서 파트 간 interlock과 syncopation을 높일 수 있다.

## 싱코페이션

싱코페이션은 약한 위치의 onset이 뒤의 강한 위치를 비우거나 묶어 기대를 어기는 관계다. 단순히 offbeat 음 개수를 세는 것보다 강박의 기준이 살아 있는지가 중요하다.

**[연구: 중]** 통제된 funk drum-break와 합성 자극에서는 중간 정도 싱코페이션이 움직이고 싶은 마음·즐거움·groove를 가장 높였다. [S19][S27]

**[연구: 제한/상충]** 실제 pop/rock/funk에서 가져온 idiomatic 패턴에서는 complexity와 움직임 욕구의 inverted-U가 나타나지 않았고, 극단적인 실험자 제작 패턴을 빼면 기존 자료의 설명력도 거의 사라졌다. [S28]

따라서 “중간 syncopation”은 약한 출발점일 뿐이다.

- 킥이나 하이햇 일부를 약박에 두되 backbeat나 bass pulse를 남긴다.
- 모든 파트가 같은 약박을 치지 않게 빈칸을 나눈다.
- 긴 syncopation 뒤에는 명확한 arrival를 준다.
- 사용자가 “걷기 어렵다”고 느끼면 syncopation 수보다 기준 beat를 먼저 복구한다.

## microtiming과 인간화

무작위 timing jitter를 기본값으로 쓰지 않는다.

- 단순 rock kick/snare 연구에서는 정렬된 패턴이 ±15/25ms 이동보다 높게 평가됐고 편차가 커질수록 떨어졌다. [S20]
- 합성 jazz/funk/samba 패턴에서는 관용적 편차를 추가·확대할수록 대체로 groove, liking, naturalness가 낮아졌다. 일부 shuffle 예외가 있었다. [S23]
- 전문 연주에서 얻은 funk/swing 패턴은 quantized와 원래 timing이 모두 높고 과장만 나빴다. 편차는 필요조건도 보편적 결함도 아니다. [S24]
- white-noise식 흔들림보다 장기 상관을 가진 연주 편차가 선호된 결과가 있지만, 단일 곡과 제한된 비교이므로 random humanize의 근거가 아니다. [S25]
- 재즈에서는 솔로이스트의 downbeat가 rhythm section보다 약 30ms 늦고 offbeat는 정렬되는 관계적 패턴이 swing 평정을 높인 결과가 있다. 모든 노트·장르에 일반화하지 않는다. [S26]

### Aria 적용

- `humanize` timing은 아주 작게 시작하고 velocity-only 후보와 구분해 시험한다.
- 킥·메인 pulse와 hat/ghost가 다른 트랙일 때만 후자를 `humanize` 후보로 삼을 수 있다. 같은 drum track에 섞여 있으면 이 도구는 piece를 골라 적용할 수 없으므로 사용하지 않는다.
- 혼합 drum track에서는 `set_velocity`의 note 목록과 `move_note`/`move_notes`로 hat, ghost note, accompaniment 일부만 고른다.
- 한 트랙 전체를 무작위로 움직이기보다 `move_note`/`move_notes`로 역할 기반 지연을 만든다.
- 같은 입력 상태·seed·범위를 기록한다. 이미 바뀐 상태에 다시 호출하면 다른 입력을 다시 흔들어 누적된다는 점을 기억한다.
- A=grid, B=변형을 같은 구간에서 비교한다.

## swing

`swing`은 뒷 subdivision을 늦춘다. amount는 장르의 이름이 아니라 현재 tempo·unit·파트에 대한 값이다.

- 8분 swing: jazz, blues, shuffle의 후보.
- 16분 swing: hip-hop, neo-soul, funk 일부의 후보.
- 빠를수록 과한 비율이 부자연스러울 수 있다.
- melody, ride, bass가 같은 비율을 가져야 하는 것은 아니다.
- sample/프리셋의 attack이 느리면 데이터 onset과 지각 onset이 다르므로 숫자만 보고 맞추지 않는다. [S60]

## accent와 velocity

groove의 생명은 timing보다 accent일 수 있다.

- 강박·backbeat·syncopated target을 구분한다.
- 8분/16분 연속음의 velocity를 기계적 교대 공식 하나로 고정하지 않는다.
- ghost note는 조용한 주음이 아니라 기능적으로 빈칸을 연결하는 작은 사건으로 둔다.
- velocity 차이를 크게 쓸 때 프리셋과 `velRange`가 실제 음량/음색에 어떻게 반응하는지 듣는다.

## 출발 패턴: 문법이지 복사 규칙이 아니다

아래 위치는 4/4의 beat 좌표다. 장르 문서는 더 구체적인 맥락을 제공한다.

### straight backbeat

- kick: `0`, 선택적으로 `2` 또는 약박.
- snare/clap: `1`, `3`.
- hihat: 8분 `0, .5, 1, 1.5, ...` 또는 16분.
- 변화: 마지막 half-beat의 hat/open hat, 2–4마디 말미 fill.

### half-time

- 핵심 snare/clap: `2`.
- kick은 앞뒤 공간을 분할한다.
- subdivision은 빠르게 유지해도 체감 backbeat는 넓어진다.

### four-on-floor

- kick: `0, 1, 2, 3`.
- clap/snare: 보통 `1, 3`.
- open hat 후보: `.5, 1.5, 2.5, 3.5`.
- drop 전후에는 킥을 더 쌓기보다 층·저역·공간의 대비를 설계한다.

### sparse pocket

- 기준 kick 한두 개와 backbeat만 둔다.
- bass 또는 chord가 빈 약박을 담당한다.
- hat은 연속 grid 대신 문장 말미와 pickup에 사용한다.

## 그루브 진단 순서

1. metronomic 기준이 들리는가.
2. kick과 bass의 onset/duration이 충돌하는가.
3. backbeat가 의도한 위치와 세기로 들리는가.
4. syncopation 뒤 arrival가 있는가.
5. 너무 많은 파트가 같은 subdivision을 채우는가.
6. 프리셋 attack 때문에 늦게 들리는가.
7. 그 다음에만 timing 편차를 의심한다.

solo로 각 파트를 확인한 뒤 전체를 듣는다. solo에서 좋아도 interlock이 나쁘면 곡에서는 groove가 사라진다.

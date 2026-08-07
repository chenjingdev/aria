# Acoustic, folk, singer-songwriter, ballad, rock, blues

이 범주의 음악은 악기보다 연주 관계, song voice, riff/groove, 녹음 미학, 지역 전통으로 갈린다. “기타가 있으면 folk/rock”처럼 판정하지 않는다.

## Acoustic / singer-songwriter

### signature 후보

- vocal-like focal과 accompaniment의 호흡.
- strum/arpeggio pattern이 harmony뿐 아니라 pulse를 담당.
- 작은 ensemble과 intimate dynamics.
- lyric이 없어도 문장마다 숨·pickup·ending이 분명한 melody.
- section 차이는 새로운 악기보다 playing density와 register로 시작.

### Aria 출발점

- steel/nylon guitar 또는 piano 하나, bass 선택, focal 하나로 시작한다.
- guitar preset이 strum engine을 제공하지 않으면 chord onset·duration·velocity를 분산해 down/up gesture를 암시하되 실제 연주를 과장해 주장하지 않는다.
- verse-like section에서는 accompaniment가 focal의 빈칸을 채우고, focal onset과 계속 충돌하지 않게 한다.
- chorus-like lift는 octave doubling, bass entry, wider voicing, subtle percussion 중 1–2개로 시작한다.

### 피할 것

- drum이 없으면 자동으로 folk라고 부름.
- arpeggio를 전곡에 같은 velocity로 복사.
- reverb를 많이 넣어 intimate와 distant를 혼동.
- 모든 phrase를 4마디로 자름.

## Folk

folk는 지역·공동체·전승·revival 맥락이 중요한 넓은 범주다. 특정 지역을 모르면 보편적인 “민속 패턴”을 발명하지 않는다.

### 안전한 접근

- 사용자에게 지역/시대/악기 reference가 있으면 그것을 우선한다.
- 반복 가능한 melody, 작은 음정 윤곽, strophic return은 후보이지만 필수조건은 아니다.
- 짧고 일찍 나타나는 예측 가능한 phrase가 전승에서 안정적이었던 한 코퍼스 결과를 anchor 설계의 약한 근거로만 쓴다. [S31]
- 지역 전통의 mode, meter, ornament를 이름 붙일 때는 해당 자료가 있을 때만 쓴다.

### Aria 출발점

- acoustic focal/support와 작은 bass 또는 drone/pedal을 선택한다.
- section variation은 melody ornament, verse ending, drone entry, octave, sparse percussion으로 만든다.
- 완전 quantized한 dance-tune과 자유로운 ballad는 서로 다른 방향이므로 folk=loose timing으로 가정하지 않는다.

## Ballad

ballad는 하나의 harmony나 instrumentation이 아니라 느리거나 넓게 호흡하는 narrative/expressive 기능으로 여러 장르 안에 존재한다.

### signature 후보

- 낮거나 중간 energy에서 시작해 phrase와 section이 감정 곡선을 만듦.
- vocal-like melody와 긴 note/쉼.
- accompaniment의 공간과 동적 여유.
- 늦은 bass/drum/strings entry 또는 register expansion.
- ending의 ritardando, thinning, sustained arrival 중 선택.

### Aria 출발점

- 느린 BPM 하나로 ballad를 정의하지 않는다. 넓은 4/4, 6/8·12/8, 또는 double-time 표기 중 phrase 호흡과 사용자의 motion에 맞는 체감을 먼저 고른다.
- velocity만으로 감정을 만들지 말고 density, register, duration, track entry, `set_region_gain`을 분산한다.
- strings를 쓰면 attack/release를 듣고 focal과 같은 register를 피한다.
- drums는 verse에도 쓸 수 있다. “후렴에만 등장”은 한 편곡 선택일 뿐이다.

### 피할 것

- I–V–vi–IV를 ballad의 정의로 사용.
- 처음은 무조건 piano, 후렴은 무조건 strings/drums.
- 모든 트랙 `velRange:1`.
- 마지막에 무조건 ritardando.

## Rock

rock의 harmony, riff, form, beat, timbre는 시기와 하위장르에 따라 다르며 classical functional harmony와 다른 독자적 통계·문법을 가진다. [S21][S22][S62][S73]

### 먼저 방향을 잡는다

- early rock/blues-based.
- classic/hard rock.
- punk/garage.
- alternative/indie.
- progressive/odd-meter.
- electronic/post-rock hybrid.

### signature 후보

- riff 또는 groove가 harmonic identity를 주도.
- drums–bass–guitar/keys의 ensemble attack.
- distortion 자체보다 note duration, register, doubling, accent가 만드는 중량.
- section energy와 texture의 역할.
- vocal-like focal과 instrumental fill의 교대.

### Aria 출발점

- acoustic kit/band kit, bass, guitar/organ/keys support, focal의 작은 band로 시작한다.
- riff는 pitch보다 rhythm과 articulation을 먼저 고정한다.
- chord root parallel motion, ♭VII, IV, modal mixture를 고전 화성 오류로 자동 수정하지 않는다.
- crash와 fill은 section boundary를 보여 주는 자원으로 아낀다.
- distortion guitar preset이 없으면 EQ/리미터를 과도하게 밀어 가짜 distortion을 만들지 말고 organ/synth/short guitar-like articulation으로 역할을 구현한다.

### 피할 것

- 더 큰 volume=더 rock.
- 모든 guitar chord를 긴 full voicing으로 겹침.
- indie를 lo-fi 음질 하나로 정의.
- rock chorus는 항상 더 많은 악기라고 가정.

## Blues

blues는 12-bar progression만이 아니라 blue-note inflection, call-response, phrase timing, vocality, 지역·역사적 관습을 포함한다. 12-bar는 강한 형식 중 하나이지 전체 정의가 아니다. [S75]

### Aria 출발점

- 12-bar를 선택하면 4+4+4의 harmonic function뿐 아니라 2마디 phrase와 response를 설계한다.
- minor/major third inflection과 bend를 focal gesture로 선택적으로 사용한다.
- shuffle/swing과 straight blues를 구분한다.
- bass turnaround와 drum fill을 매 cycle 똑같이 만들지 않는다.
- bend는 모든 음에 넣지 말고 target/ending note에 둔다.

### 피할 것

- blues scale을 무작위로 나열.
- 모든 blues에 12-bar와 shuffle 강제.
- 문화·역사적 장르를 “슬픈 음악”으로만 설명.

## band 진단

- bass와 guitar/piano left hand가 같은 register/root를 과도하게 겹치는가.
- riff와 focal melody가 동시에 말하는가.
- cymbal이 section 내내 최대 density인가.
- acoustic preset의 release가 strum/picking articulation을 뭉개는가.
- chorus가 단지 limiter를 더 밀 뿐 실제 focal clarity는 줄지 않았는가.
- 작은 편성이 약하다는 이유로 역할 없는 track을 추가했는가.

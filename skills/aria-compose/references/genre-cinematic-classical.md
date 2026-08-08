# Cinematic, orchestral, chamber, ambient, minimal, game music

“cinematic”과 “classical”은 같은 장르가 아니다. 전자는 장면·서사·매체 기능을 가리킬 때가 많고, 후자는 수백 년의 서로 다른 양식·형식·편성을 포함한다.

## Cinematic / film-score-like

먼저 실제 화면에 동기화되는 cue와 독립적인 “film-score-like” 곡을 구분한다. 화면과 소리는 서로의 지각을 바꾸며, Hollywood harmony 연구는 그중 특정 산업·시대의 tonal/chromatic practice를 다룬다. 둘을 cinema 전체의 하나뿐인 문법으로 확대하지 않는다. [S68][S83]

- 실제 cue: scene, dialogue, diegetic 여부, sync point, action density, 필요한 silence를 먼저 정한다.
- standalone track: 화면이 없으므로 사용자 서사와 section function을 가상의 sync point처럼 사용한다.
- main theme 요청: 짧은 phrase 관습을 참고할 수 있지만 Oscar-nominated film main-theme corpus의 범위를 underscore 전체로 확대하지 않는다. [S84]

### 먼저 장면 기능을 잡는다

- establish world.
- signal character/object.
- foreshadow.
- sustain tension under action/dialogue.
- reveal/arrival.
- mourn/reflect.
- transition time/place.
- end-credit release.

### signature 후보

- 짧은 leitmotif가 instrumentation, mode, bass, register에 따라 의미를 바꿈.
- long-range tension curve와 delayed arrival.
- orchestral family 또는 synth/acoustic layer의 단계적 변화.
- scene cut/gesture에 맞는 accent와 silence.
- harmony보다 pedal, texture, register가 긴장을 담당하는 구간.

### Aria 출발점

- Hollywood-orchestral 방향일 때만 soft piano/solo instrument, strings, low support, optional brass/percussion/choir를 한 palette 후보로 둔다. Electronic, documentary, diegetic, experimental cue에는 자동 적용하지 않는다.
- 식별 가능한 짧은 pitch/rhythm motif를 만든 뒤 여러 section에서 변형한다. 특정 음 개수를 보편 규칙으로 두지 않는다.
- 큰 climax는 velocity, register, 편성 규모, family entry, harmonic rhythm, percussion을 나눠 올린다.
- `set_section`에 장면 기능을 적고 전환 lead-in을 함께 재생한다.
- long attack과 release 때문에 실제 도착이 늦거나 tail이 겹치는지 듣는다.

### 피할 것

- cinematic=느린 strings+choir+큰 reverb.
- 모든 감정에서 같은 minor ostinato.
- climax에 전 family를 같은 register/rhythm으로 쌓음.
- dialogue가 없는데도 “underscoring” 관습을 기계적으로 흉내 냄.

## Orchestral

전통 오케스트레이션 교재는 악기 음역·transposition·timbre·balance·combination의 기초를 제공하지만 Aria의 샘플과 제한된 articulation이 실제 악단을 완전히 재현하지 않는다. [S63]

### 역할 배치

- strings: sustained bed, rhythmic motor, lyrical focal, tremolo-like tension을 서로 구분.
- winds: solo color, inner dialogue, transparent chord color.
- brass: weight, harmonic pillar, call, arrival; 항상 fortissimo가 아님.
- percussion: pulse, punctuation, transition, mass; 계속 채우지 않음.
- piano/harp/mallet: attack, arpeggio, sparkle, harmonic skeleton.

### Aria 출발점

- `list_presets`에서 실제 사용 가능한 solo/ensemble/perc를 확인한다.
- 동질 음색·동시 onset의 내성이 실제로 구분되는지 듣는다. 특정 조건에서 3→4성부의 식별이 크게 떨어진 실험은 inner-line 진단 단서이지 오케스트라 전체의 voice ceiling이 아니다. [S59]
- blend는 onset/articulation을 맞추고 stream은 register/timbre/rhythm을 나눈다. [S40][S58]
- 앙상블(Ensemble, 여러 연주자가 함께 내는 편성)은 실제 ensemble/section이 녹음된 프리셋으로 고른다. 독주 음원을 겹치는 트랙 효과는 없으며, 프리셋을 바꿔도 실제 section divisi나 articulation change가 자동으로 생긴다고 말하지 않는다.
- 극단 음역의 샘플 품질과 loudness를 재생으로 확인한다.

## Classical-form-inspired

classical 요청은 baroque, classical-era, romantic, impressionist, modernist, minimalist, contemporary 중 어느 쪽인지 잡는다. sonata, rondo, ternary, variation 같은 형식은 명칭보다 기능과 규모를 이해해 사용한다. [S71]

### 안전한 접근

- motive, phrase, cadence, thematic return, contrast 관계를 먼저 설계한다.
- four-part voice-leading을 모든 스타일의 보편법으로 강제하지 않되 독립 성부 지각 원리를 활용한다. [S39]
- classical-era balance를 원하면 phrase symmetry를 출발점으로 쓰고 extension/deception을 의도적으로 배치한다.
- romantic 색을 원하면 단순히 chord extension을 늘리지 말고 long-line dynamics, chromatic voice leading, register span을 설계한다.
- modern/contemporary 요청에는 tonal `check_key` 판정을 약하게 취급한다.

## Chamber / intimate ensemble

작은 편성에서는 각 line의 의미가 더 잘 드러난다.

- 2–5개 역할로 시작한다.
- accompaniment가 계속 chord block을 치지 않게 각 악기에 선형 목표를 준다.
- 같은 family의 blend와 독립성을 section마다 바꿀 수 있다.
- solo entry/exit가 form을 만들게 한다.
- 한 악기가 쉼 없이 계속 연주하지 않게 숨을 설계한다.

## Ambient

ambient는 “느리고 reverb가 많음”보다 attention, environment, texture, gradual change의 방식으로 접근한다.

### signature 후보

- 낮은 onset density와 긴 시간 규모의 timbre/register 변화.
- foreground–background 경계가 이동하는 texture.
- pulse가 없거나 아주 느슨하거나, 작은 반복 cell로만 암시.
- harmonic rhythm이 느리지만 내부 spectral/voice motion은 존재.
- silence와 decay가 form의 일부.

### Aria 출발점

- 2–4개의 sustain/gesture 역할로 시작한다.
- 어택/릴리스(Attack/Release, 소리가 시작되고 음을 놓은 뒤 여운이 남는 성질)가 긴 프리셋을 고를 수 있다. note duration과 tail overlap, 10분 렌더 제한을 함께 고려한다.
- `set_region_gain` ramp, register migration, sparse motif, section별 track entry로 변화를 만든다.
- 모든 트랙 reverb를 0.8로 두지 말고 depth 층을 만든다.
- 집중용 ambient와 긴장 ambient의 tension 목표를 분리한다.

## Minimal / process-based

minimalism은 작은 재료, 반복, 점진 과정, pulse, phase/additive process 등 서로 다른 역사적 기법을 포함한다. [S72]

### Aria 출발점

- 짧은 cell 하나와 변형 규칙 하나를 먼저 정한다.
- additive: cell 끝에 한 onset/pitch를 단계적으로 추가.
- subtractive: 고정 pattern에서 특정 onset을 규칙적으로 제거.
- phase-like: 두 트랙 중 하나를 아주 제한된 구조적 간격으로 이동. 무작위 humanize와 구분한다.
- process가 청자에게 들릴 만큼 오래 유지하되 exposure에 대한 사용자의 반응을 우선한다.

### 피할 것

- 단순 복붙을 minimalism이라고 부름.
- 모든 반복마다 변형해 process를 들을 수 없게 함.
- 무작위 변화로 결정 규칙을 흐림.

## Game music

game music은 loop, state transition, hardware/production history, interactive function을 고려해야 한다. chip-inspired 어법은 [genre-pop-electronic.md](genre-pop-electronic.md)의 chiptune 항목도 읽는다. [S67]

### Aria 출발점

- loop point를 화성·tail·pickup까지 고려해 설계한다.
- 탐험, 전투, 보스, 휴식, 결과 화면처럼 state function을 section에 표시한다.
- 같은 motif를 state별 orchestration, tempo layer, bass, tension으로 변형한다.
- Aria가 interactive engine이 아니므로 vertical remixing/stem logic을 곡 구조와 트랙 역할로 모사할 뿐 실제 runtime adaptation을 과장하지 않는다.

## 서사형 진단

- motif가 장면보다 더 자주 말해 피로하지 않은가.
- tension curve가 음량 하나로만 움직이는가.
- climax 전 already-full 상태라 더 커질 여지가 없는가.
- long attack의 악기가 정확한 순간에 지각되는가.
- orchestra family가 모두 같은 rhythm/voicing을 연주해 한 덩어리로 흐려지는가.
- ending이 장면 기능에 맞게 닫히거나 열리는가.

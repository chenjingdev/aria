# Aria 음원 라이브러리 전수 감사 및 확장 조사

- 기준 조사일: 2026-08-07 (KST), 제품 목록 갱신: 2026-08-08
- 조사 범위: 로컬에 설치된 SF2 8개, Aria가 노출하는 외부 SoundFont 프리셋 77개, 빌드 파이프라인, 공식·1차 출처가 확인되는 미수집 무료/오픈 음원과 비교용 상용 음원
- 평가 원칙: **원본 라이브러리의 잠재 품질**과 **현재 Aria가 실제로 살리는 품질**을 구분한다. 파일 크기나 유명세만으로 음질을 판정하지 않는다.

## 결론부터

1. **Aria 자체 합성 신스는 제거됐다.** 현재 제품은 외부 SoundFont만 재생하고, 필요한 음원이 없거나 손상됐으면 자동 대체가 아니라 명시적인 설치 오류를 보여 준다.
2. **Philharmonia는 삭제 대상이 아니다.** 현재 설치된 현악·목관·금관·타악 4개는 약 408.88 MiB이며, GeneralUser 대체음보다 샘플 길이·벨로시티 층·자연 감쇠가 뚜렷하게 낫다. 다만 공식 조건상 샘플 또는 sampler instrument 형태로 재배포하면 안 되므로 **사용자 로컬 전용 Orchestra HD 팩**으로 남겨야 한다.
3. 로컬 음원은 총 **1.63 GiB(1.75 GB)**이며, 현재 소스 코드는 8개를 모두 명시적 선택지로 연결한다. GeneralUser와 Philharmonia는 같은 악기라도 별도 ID라 사용자가 음색을 직접 고른다.
4. Aria 화면의 많은 실악기 이름은 전용 고급 음원이 아니라 30.82 MiB짜리 **GeneralUser GS 대체음**이다. 바이올린·플루트·호른·기타·합창 등이 “존재한다”와 “충분히 사실적이다”는 같은 뜻이 아니다.
5. 다음 활용·수집 우선순위는 **이미 내려받은 VSCO 2 CE 전체 원본 활용 → VCSL/FreePats 수집 → University of Iowa 선별팩**이다. 앞의 두 계열은 CC0 중심이라 제품화가 쉽다.
6. 지금 가장 큰 병목은 음원 수보다 **재생 엔진**이다. 현재 JS SF2 렌더러는 stereo link/pan, 필터, LFO, modulators, exclusive group 등을 완전히 재현하지 못한다. GeneralUser 공식 문서도 완전한 SoundFont 엔진이 아니면 많은 프리셋이 제대로 재생되지 않는다고 경고한다. 더 큰 SF2를 계속 추가하기 전에 SoundFont 엔진 교체와 SFZ 지원을 먼저 검토해야 한다.
7. Git에는 음원 바이너리를 넣지 않는다. 앱 안에서 출처·용량·라이선스를 보여주고 다운로드/로컬 빌드를 제공하는 **팩 매니저 + manifest** 구조가 맞다.

## 1. 품질 표시 기준

| 표시 | 의미 |
|---|---|
| 상 | 전용 실녹음, 여러 세기/음역 또는 긴 자연 감쇠가 있고 현재 Aria에서도 핵심 특성의 상당 부분이 살아남음 |
| 중 | 실녹음이지만 일부 레이어·라운드로빈·스테레오·주법이 줄었거나 현재 엔진이 일부 정보를 버림 |
| 스케치 | 작곡·편곡 확인에는 유용하지만 독주·노출 구간에서 합성티/반복/짧은 루프가 드러날 가능성이 큼 |
| 선택 설치 | 프리셋은 노출되지만 필요한 로컬 파일이 없으면 `미설치`로 비활성화됨 |

등급은 공식 스펙, 로컬 SF2 구조, Aria 렌더러 지원 범위와 동일 음정 A/B 구조 검사를 합친 **엔지니어링 판단**이다. 최종 음색 선택은 실제 곡 안에서의 청취 비교로 확정해야 한다.

## 2. 현재 저장 용량

| 구분 | 용량 | 상태 |
|---|---:|---|
| 런타임 SF2 8개 (`~/.aria/soundfonts`) | 1,666.55 MiB / 1.627 GiB / 1.747 GB | 앱이 읽는 설치 음원 |
| 기본·선택 프리셋이 참조하는 SF2 8개 | 1,666.55 MiB | GeneralUser, Salamander piano/drum, VSCO subset, Philharmonia local pack |
| Philharmonia 로컬 선택팩 4개 | 408.88 MiB | GeneralUser판과 별도 ID로 선택 가능; 파일이 없으면 `미설치` 표시 |
| 임시 scratchpad의 원본·변환 중간물 | 약 7.4 GiB | 빌드 스크립트가 아직 이 임시 절대경로에 의존 |
| 음원 관련 총 로컬 점유 | 약 9.0 GiB | 중간물 정리 전 추정 |

scratchpad를 바로 지우면 현재 커스텀 SF2 네 종류를 재현하기 어렵다. 먼저 영구 asset cache와 manifest를 만든 뒤 옮기거나 정리해야 한다.

### 새로 받기 전에 이미 보유한 미활용 원본

| 원본 cache | 로컬 보유량 | 현재 runtime에 사용 | 활용률·판단 |
|---|---:|---:|---|
| VSCO 2 CE | 3,168 WAV / 약 3 GB | 84 sample headers | 약 2.65%. **가장 먼저 확장할 안전한 CC0 자산** |
| Salamander Drumkit | 536 WAV | 28 sample headers | 약 5.22%. 첫 RR만 골라 원본 장점을 대부분 버림 |
| Philharmonia | 14,374 MP3 | 4개 SF2 합계 3,170 sample headers | 약 22.05%. 다만 local-only 조건을 우선해야 함 |
| GeneralUser GS | 287 preset map | Aria가 40개 고유 melodic programs + 3개 drum programs 사용 | 이미 가진 GM 프로그램 대다수가 숨겨져 있음 |

따라서 “아직 수집하지 못했다”는 말을 두 가지로 나눠야 한다. **VSCO와 Salamander 드럼은 원본을 이미 받았지만 앱이 거의 쓰지 못하는 상태**이고, VCSL·Iowa·FreePats·Karoryfer 후보는 실제로 아직 받지 않은 신규 라이브러리다.

## 3. 설치된 SF2 8개 전수표

> “샘플 헤더”는 SF2 내부 헤더 수다. 스테레오 좌·우 채널이나 파생 존을 각각 세므로 독립 녹음 수와 같지는 않다.

| 파일 | 정확한 크기 | 내부 구성 | 원출처·라이선스 | 현재 사용 | 원본 잠재력 | 현재 Aria 품질 | 판단 |
|---|---:|---|---|---|---|---|---|
| `default.sf2` | 30.82 MiB | 287 presets / 324 instruments / 920 sample headers, 767 looped, 6~48 kHz. 내부 이름은 `GeneralUser GS 2.0.3 BETA` | [GeneralUser GS 2.0.3](https://github.com/mrbumpy409/GeneralUser-GS), 전용 허용 라이선스. 음악·소프트웨어 사용/수정 허용, 일부 포함 샘플의 정확한 기원은 저자도 100% 확신하지 못한다고 고지 | **활성 기본값** | 중~상(정상 SoundFont 엔진 기준) | **스케치~중, 악기별 편차 큼** | 31 MiB starter 선택지로 유지. 완전한 엔진 적용 전 품질 기본값으로 과신 금지 |
| `salamander.sf2` | 1,207.79 MiB | Grand Piano 1 preset / 960 sample headers = 480 L+R pairs, A0~C8, 48 kHz, 모든 키 구간 16 velocity layers | Alexander Holm의 Yamaha C5, 48 kHz/24-bit 원본, [CC BY 3.0](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html#SalamanderGrandPiano) | `sf-piano`으로 **활성** | 상 | **중~상** | 보존. 현재 엔진은 stereo pair/pan을 살리지 못해 1.2 GiB stereo 자산을 사실상 mono로 축소하는 것이 병목 |
| `salamander-kit.sf2` | 10.07 MiB | Band Kit 1 preset / 28 sample headers / 12 pieces / 실제 1~3 velocity layers | Alexander Holm Salamander Drumkit. 로컬 archive는 CC BY-SA 3.0, [저자 공식 페이지는 2022-03-04 public-domain 전환](https://rytmenpinne.wordpress.com/sounds-and-such/salamander-drumkit/) 고지 | `sf-band-kit`으로 **활성** | 중~상(원본 전체) | **중 이하** | 현재 변환본은 각 세기의 첫 RR만 택해 원본의 반복 회피 장점을 대부분 버림. 라이선스 증빙도 manifest에 고정 필요 |
| `vsco.sf2` | 8.98 MiB | 6 presets / 84 mono one-shot sample headers: harp, glockenspiel, marimba, xylophone, cello pizz, timpani | [VSCO 2 CE](https://versilian-studios.com/vsco-community/), CC0 | 6개 프리셋으로 **활성** | 중~상(전체판) | **중** | 원본 3,168 WAV를 이미 갖고 있지만 runtime에는 84개만 사용. “미수집”보다 **미활용**이 정확함 |
| `philharmonia.sf2` | 142.10 MiB | 8 presets / 1,091 sample headers, 991 looped: violin, viola, cello, contrabass, violin/viola/contrabass pizz, violin sordino | [Philharmonia 공식 샘플](https://philharmonia.co.uk/resources/sound-samples/). 상업 작품 사용 가능, 샘플 또는 sampler instrument 형태 제공 금지 | **로컬 선택팩 활성** | 상 | **중~상** | `-phil` 현악 8종으로 노출. GeneralUser판과 사용자가 명시적으로 선택 |
| `phil-winds.sf2` | 192.74 MiB | 8 presets / 1,435 sample headers, 전부 looped: flute, oboe, English horn, clarinet, bass clarinet, bassoon, contrabassoon, alto sax | Philharmonia, 위와 동일 | **로컬 선택팩 활성** | 상 | **중~상** | `-phil` 목관·색소폰 8종. bass clarinet/contrabassoon도 독립 음색 |
| `phil-brass.sf2` | 71.44 MiB | 4 presets / 620 sample headers, 전부 looped: trumpet, horn, trombone, tuba | Philharmonia, 위와 동일 | **로컬 선택팩 활성** | 상 | **중~상** | `-phil` 금관 4종. GeneralUser판과 별도 선택 |
| `phil-perc.sf2` | 2.59 MiB | 1 kit / 24 one-shot sample headers / 17 mapped pieces | Philharmonia, 위와 동일 | **로컬 선택팩 활성** | 상 | **중~상** | `sf-orch-kit-phil`; tam-tam·triangle 등 자연 tail 선택지 |

### 전문 팩 내부 악기·레이어 상세

#### Philharmonia strings

| 악기 | sample headers | 실제 녹음 root 범위 | 키별 velocity layers | 주법 |
|---|---:|---|---:|---|
| Violin | 284 | G3~G7 | 4~6 | arco normal |
| Viola | 224 | C3~D7 | 1~5 | arco normal |
| Cello | 208 | C2~C6 | 4~5 | arco normal |
| Contrabass | 231 | C1~G4 | 4~6 | arco normal |
| Violin Pizz | 49 | G3~A6 | 1~3 | pizzicato |
| Viola Pizz | 39 | C3~C6 | 1~2 | pizzicato |
| Contrabass Pizz | 12 | E1~G3 | 1 | pizzicato |
| Violin Sordino | 44 | G3~A6 | 2~3 | con sordino |

#### Philharmonia woodwinds·brass

| 악기 | sample headers | 실제 녹음 root 범위 | 키별 velocity layers |
|---|---:|---|---:|
| Flute | 189 | C4~F7 | 1~5 |
| Oboe | 137 | A#3~A#6 | 1~5 |
| English Horn | 168 | E3~B5 | 5~6 |
| Clarinet | 188 | D3~C7 | 4 |
| Bass Clarinet | 214 | C#2~A#5 | 2~6 |
| Bassoon | 201 | A#1~G5 | 1~5 |
| Contrabassoon | 160 | A#0~D4 | 1~4 |
| Alto Sax | 178 | D3~F6 | 1~6 |
| Trumpet | 98 | E3~E6 | 1~4 |
| French Horn | 122 | A#1~F5 | 1~3 |
| Trombone | 179 | E2~E6 | 1~5 |
| Tuba | 221 | F1~F4 | 5~6 |

이 수치는 “상용 오케스트라 라이브러리급”이라는 뜻은 아니다. 원본은 MP3이고 Aria 빌더가 mono 변환·자동 loop를 적용했으며, normal sustain 중심이라 legato transition·keyswitch·continuous dynamics·RR가 없다. 다만 현재 GeneralUser 대체음보다 독주 악기 정체성과 세기별 실녹음 변화가 훨씬 풍부하다는 근거는 충분하다.

#### Philharmonia percussion

| 피스 | velocity layers | 피스 | velocity layers |
|---|---:|---|---:|
| kick | 2 | snare | 3 |
| tom-l / tom-m / tom-h | 각 1 | crash | 2 |
| ride / tam-tam | 각 1 | tambourine / cowbell | 각 2 |
| agogo / cabasa / guiro | 각 1 | woodblock / triangle / castanets | 각 1 |
| sleigh bells | 2 |  |  |

#### VSCO runtime subset

| 악기 | sample headers | 실제 root 범위 | velocity layers | 한계 |
|---|---:|---|---:|---|
| Harp | 22 | E1~F7 | 1 | pitch stretch와 단일 세기 |
| Glockenspiel | 6 | G4~C7 | 1 | 넓은 pitch stretch |
| Marimba | 10 | F1~C6 | 1 | 단일 세기 |
| Xylophone | 8 | G3~C7 | 1 | 단일 세기 |
| Cello Section Pizz | 26 | C1~F4 | 2 | RR1만 사용 |
| Timpani | 12 | F#1~D#2 | 키별 1~5 | 음역이 좁음 |

#### Salamander Drumkit runtime subset

| 피스 | 실제 layers | 피스 | 실제 layers |
|---|---:|---|---:|
| kick / snare | 각 3 | rim | 1 |
| clap / closed hat | 각 2 | open hat | 3 |
| low/mid/high tom | 각 3 | crash / ride | 각 2 |
| shaker 대체음 | 1 |  |  |

빌드 주석의 “최대 6층”과 달리 설치 SF2 실측은 최대 3층이다. 더 큰 문제는 원본의 velocity별 여러 RR 중 첫 파일만 택한다는 점이다.

### 동일 음정 구조 비교에서 확인된 차이

| 악기·음 | Philharmonia 로컬팩 | GeneralUser 대체음 | 의미 |
|---|---|---|---|
| Cello C3 | 약 2.0~2.3초 source, 약 1.26~1.40초 loop, soft/hard 층 분리 | 약 1.11초 source, 약 0.211초 loop | 긴 음의 결·루프 자연스러움에서 Philharmonia 우위 |
| Clarinet G4 | 약 2.09초 source, 약 1.4초 loop, 4 velocity layers | 약 0.25초 source, 99 ms loop, 1 layer | 다이내믹과 유지음에서 큰 차이 |
| Horn C4 | 약 1.6~1.94초 source, 3 velocity layers | ensemble/composite 성격, 매우 짧은 micro-loop 포함 | 독주 호른 대체로는 Philharmonia가 안전 |
| Tam-tam | 약 8.53초 자연 one-shot | 약 1초 길이의 Chinese-cymbal 계열 loop | 같은 악기로 보기 어려운 수준의 tail 차이 |
| Open triangle | 약 0.72초 자연 one-shot | 약 50 ms loop | 잔향의 금속성·자연 감쇠 차이 |

## 4. 현재 Aria가 노출하는 SoundFont 프리셋 77개

> **2026-08-08 제품 변경:** 코드 안에서 파형을 만들던 선율 신스 13개와 합성 드럼 3개를 제거했다. 현재 목록은 외부 SoundFont 선율 악기 71개와 샘플 드럼 6개뿐이다. GeneralUser와 Philharmonia는 별도 선택지이며, 필요한 파일·bank·program이 없거나 손상됐으면 다른 악기로 자동 대체하지 않고 설치 오류를 표시한다.

### 4.1 SoundFont 선율 악기 71개

| ID | 화면 이름 | 현재 실제 소스 | 현재 품질 | 비고 |
|---|---|---|---|---|
| `sf-piano-gm` | Grand Piano (GM) | GeneralUser GM0 | 스케치~중 | 경량 기본 피아노 |
| `sf-piano` | Grand Piano (Salamander) | Salamander C5 | 중~상 | 기존 곡 호환 ID. 전용 1.2 GiB 팩 |
| `sf-epiano` | Tine E.Piano (GM) | GeneralUser | 스케치~중 | 전용 Rhodes/Tine 라이브러리 미수집 |
| `sf-fm-epiano` | Electric Piano 2 (GM) | GeneralUser GM5 | 스케치 | Wurli 계열 곡의 외부 샘플 대체음 |
| `sf-music-box` | Music Box (GM) | GeneralUser GM10 | 스케치 | 오르골 계열 샘플 |
| `sf-vibes` | Vibraphone (GM) | GeneralUser | 스케치 | VCSL/VSCO의 전용 후보 있음 |
| `sf-glockenspiel-gm` | Glockenspiel (GM) | GeneralUser GM9 | 스케치 | VSCO판과 별도 선택 |
| `sf-marimba-gm` | Marimba (GM) | GeneralUser GM12 | 스케치 | VSCO판과 별도 선택 |
| `sf-xylophone-gm` | Xylophone (GM) | GeneralUser GM13 | 스케치 | VSCO판과 별도 선택 |
| `sf-organ` | Drawbar Organ (GM) | GeneralUser | 스케치~중 | GeneralUser modulators를 현재 엔진이 온전히 재현하지 못함 |
| `sf-nylon` | Nylon Guitar (GM) | GeneralUser | 스케치 | strum, fret position, mute, release 미지원 |
| `sf-steel` | Steel Guitar (GM) | GeneralUser | 스케치 | 실제 기타 주법 라이브러리 필요 |
| `sf-bass` | Finger Bass (GM) | GeneralUser | 스케치 | slide/ghost/mute/release 미지원 |
| `sf-synth-bass` | Synth Bass 1 (GM) | GeneralUser GM38 | 스케치 | 전자 베이스의 정적 SoundFont 샘플 |
| `sf-pizzicato` | Pizzicato Pluck (GM) | GeneralUser GM45 | 스케치 | 플럭 역할의 외부 샘플 대체음 |
| `sf-harp-gm` | Orchestral Harp (GM) | GeneralUser GM46 | 스케치 | VSCO판과 별도 선택 |
| `sf-timpani-gm` | Timpani (GM) | GeneralUser GM47 | 스케치 | VSCO판과 별도 선택 |
| `sf-strings` | String Ensemble (GM) | GeneralUser | 스케치~중 | 앙상블 sketch용 |
| `sf-fantasia` | New Age Pad (GM) | GeneralUser GM88 | 스케치 | 패드 계열 정적 샘플 |
| `sf-warm-pad` | Warm Pad (GM) | GeneralUser GM89 | 스케치 | 웜 패드 계열 정적 샘플 |
| `sf-square-lead` | Square Lead (GM) | GeneralUser GM80 | 스케치 | chip-inspired 정적 샘플 |
| `sf-saw-lead` | Saw Lead (GM) | GeneralUser GM81 | 스케치 | 전자 리드 정적 샘플 |
| `sf-violin` | Violin (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-viola` | Viola (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-cello` | Cello (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-contrabass` | Contrabass (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-violin-pizz` | Pizzicato Strings High (GM) | GeneralUser GM45 | 스케치 | 독주 violin pizz가 아니라 ensemble 대체음 |
| `sf-viola-pizz` | Pizzicato Strings Mid (GM) | GeneralUser GM45 | 스케치 | 위와 동일 |
| `sf-contrabass-pizz` | Acoustic Bass Pizz. (GM) | GeneralUser GM32 | 스케치 | orchestral contrabass pizz가 아닌 acoustic bass 대체 |
| `sf-violin-sord` | Slow Strings (GM) | GeneralUser GM49 | 스케치 | sordino 독주가 아닌 slow strings 대체 |
| `sf-choir` | Choir Aahs (GM) | GeneralUser | 스케치 | 전용 choir/voice 라이브러리 없음 |
| `sf-brass` | Brass Section (GM) | GeneralUser | 스케치~중 | 섹션 스탭 확인용 |
| `sf-sax` | Alto Sax (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-flute` | Flute (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-oboe` | Oboe (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-english-horn` | English Horn (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-clarinet` | Clarinet (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-bass-clarinet` | Bass Clarinet (GM Sketch) | GeneralUser clarinet 저역 | 스케치 | 전용 Philharmonia판과 별도 선택 |
| `sf-bassoon` | Bassoon (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-contrabassoon` | Contrabassoon (GM Sketch) | GeneralUser bassoon 저역 | 스케치 | 전용 Philharmonia판과 별도 선택 |
| `sf-horn` | French Horn (GM) | GeneralUser | 스케치 | ensemble 성격이 강하며 Philharmonia판과 별도 선택 |
| `sf-trumpet` | Trumpet (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-trombone` | Trombone (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-tuba` | Tuba (GM) | GeneralUser | 스케치 | Philharmonia판과 별도 선택 |
| `sf-timpani` | Timpani (VSCO) | VSCO 선별팩 | 중 | 키에 따라 1~5층, F#1~D#2 범위 제한 |
| `sf-harp` | Harp (VSCO) | VSCO 선별팩 | 중 | 22 headers, 단일 velocity 선별본 |
| `sf-glockenspiel` | Glockenspiel (VSCO) | VSCO 선별팩 | 중 | 단일 계열 선별본 |
| `sf-marimba` | Marimba (VSCO) | VSCO 선별팩 | 중 | 단일 계열 선별본 |
| `sf-xylophone` | Xylophone (VSCO) | VSCO 선별팩 | 중 | 단일 계열 선별본 |
| `sf-cello-pizz` | Cello Pizz (VSCO) | VSCO 선별팩 | 중 | 2 velocity, RR1만 사용 |
| `sf-bandoneon` | Tango Accordion (GM) | GeneralUser | 스케치~중 | 실제 bandoneon 전용팩은 없음 |
| `sf-violin-phil` | Violin (Philharmonia) | Philharmonia strings | 중~상 | 4~6 velocity layers/key |
| `sf-viola-phil` | Viola (Philharmonia) | Philharmonia strings | 중~상 | 1~5 layers/key |
| `sf-cello-phil` | Cello (Philharmonia) | Philharmonia strings | 중~상 | 4~5 layers/key |
| `sf-contrabass-phil` | Contrabass (Philharmonia) | Philharmonia strings | 중~상 | 4~6 layers/key |
| `sf-violin-pizz-phil` | Violin Pizz. (Philharmonia) | Philharmonia strings | 중~상 | 독주 violin pizzicato |
| `sf-viola-pizz-phil` | Viola Pizz. (Philharmonia) | Philharmonia strings | 중~상 | 독주 viola pizzicato |
| `sf-contrabass-pizz-phil` | Contrabass Pizz. (Philharmonia) | Philharmonia strings | 중 | 단일층이지만 전용 악기 |
| `sf-violin-sord-phil` | Violin Sordino (Philharmonia) | Philharmonia strings | 중~상 | 전용 con sordino 2~3층 |
| `sf-flute-phil` | Flute (Philharmonia) | Philharmonia winds | 중~상 | 1~5 layers/key |
| `sf-oboe-phil` | Oboe (Philharmonia) | Philharmonia winds | 중~상 | 1~5 layers/key |
| `sf-english-horn-phil` | English Horn (Philharmonia) | Philharmonia winds | 중~상 | 5~6 layers/key |
| `sf-clarinet-phil` | Clarinet (Philharmonia) | Philharmonia winds | 중~상 | 4 layers/key |
| `sf-bass-clarinet-phil` | Bass Clarinet (Philharmonia) | Philharmonia winds | 중~상 | GeneralUser 저역 근사와 다른 전용 음색 |
| `sf-bassoon-phil` | Bassoon (Philharmonia) | Philharmonia winds | 중~상 | 1~5 layers/key |
| `sf-contrabassoon-phil` | Contrabassoon (Philharmonia) | Philharmonia winds | 중~상 | GeneralUser 저역 근사와 다른 전용 음색 |
| `sf-sax-phil` | Alto Sax (Philharmonia) | Philharmonia winds | 중~상 | 1~6 layers/key |
| `sf-trumpet-phil` | Trumpet (Philharmonia) | Philharmonia brass | 중~상 | 1~4 layers/key |
| `sf-horn-phil` | French Horn (Philharmonia) | Philharmonia brass | 중~상 | 1~3 layers/key |
| `sf-trombone-phil` | Trombone (Philharmonia) | Philharmonia brass | 중~상 | 1~5 layers/key |
| `sf-tuba-phil` | Tuba (Philharmonia) | Philharmonia brass | 중~상 | 5~6 layers/key |

### 4.2 샘플 드럼 6개

| ID | 화면 이름 | 현재 실제 소스 | 현재 품질 | 비고 |
|---|---|---|---|---|
| `sf-kit` | Studio Kit (GM) | GeneralUser Standard Kit | 스케치~중 | 완전한 SoundFont engine 적용 시 개선 여지 |
| `sf-808-kit` | Electronic Kit (GM) | GeneralUser Electronic Kit | 스케치 | 전자 드럼의 정적 SoundFont 샘플 |
| `sf-brush-kit` | Brush Kit (GM) | GeneralUser Brush Kit | 스케치 | 브러시 드럼의 정적 SoundFont 샘플 |
| `sf-band-kit` | Band Kit (Salamander) | Salamander 축소 변환본 | 중 이하 | 12 pieces, 28 headers. 원본 RR·피스 다양성을 크게 줄임 |
| `sf-orch-kit` | Extended Percussion (GM) | GeneralUser Orchestral/GM mapping | 스케치 | tam-tam 등 일부는 전용 Philharmonia와 질적으로 다름 |
| `sf-orch-kit-phil` | Orchestral Percussion (Philharmonia) | Philharmonia local pack | 중~상 | 17피스 전용 실녹음; 파일이 없으면 비활성 |

### 4.3 GeneralUser 안에 있지만 UI에 숨겨진 자산

`default.sf2`는 GM bank 0의 128개 melodic programs를 모두 포함하지만 Aria의 현재 GeneralUser 선율 ID는 **40개 고유 프로그램**만 사용한다. 즉 88개 GM 프로그램과 여러 추가 drum kits, 다수 GS variation이 UI에서 선택되지 않는다. harpsichord, clavinet, celesta, soprano/tenor/baritone sax, piccolo, recorder, pan flute, tubular bells, ethnic instruments 등이 여기에 포함된다.

이를 전부 버튼으로 노출할 필요는 없다. Aria의 단순한 UX는 유지하되 AI가 필요할 때 내부적으로 고르거나, `건반 > 밝은 피아노/하프시코드`, `관악 > 높은 플루트/낮은 색소폰`처럼 쉬운 의미 그룹으로 선별하는 편이 낫다.

서로 다른 UI 이름이 실제로 같은 GeneralUser 프로그램을 쓰는 경우도 있다.

| UI ID | 실제 프로그램 | 의미 |
|---|---|---|
| `sf-violin-pizz`, `sf-viola-pizz` | GM45 Pizzicato Strings | 음역만 달리 쓰는 같은 ensemble 소스 |
| `sf-clarinet`, `sf-bass-clarinet` | GM71 Clarinet | bass clarinet은 실제 전용 음원이 아님 |
| `sf-bassoon`, `sf-contrabassoon` | GM70 Bassoon | contrabassoon은 실제 전용 음원이 아님 |
| `sf-kit`, `sf-orch-kit` | Bank 128 Program 0 Standard 1 | 이름·piece mapping만 다름. `tamtam`은 실제 Chinese Cymbal, `sleigh`는 Jingle Bell에 대응 |

## 5. 중복은 어떻게 정리할 것인가

중복을 전부 삭제하면 안 된다. 같은 악기라도 **경량 starter**, **고품질 실녹음**, **캐릭터 샘플**의 역할이 다르다. 다만 이 선택은 별도 프리셋으로 노출해야 하며, 파일이 없을 때 다른 음원으로 몰래 바꾸면 안 된다.

| 악기군 | 겹치는 소스 | 권장 기본 | 남겨둘 이유 |
|---|---|---|---|
| Grand piano | GeneralUser bank / Salamander | 용도에 따라 명시적으로 선택 | `sf-piano-gm`은 경량 GM, `sf-piano`는 HD. 어느 쪽도 다른 쪽으로 자동 대체하지 않음 |
| 현악 독주 | GeneralUser / Philharmonia | 두 소스를 별도 프리셋으로 제공 | GeneralUser는 경량 starter, Philharmonia는 로컬 전용 고품질 선택지 |
| 목관·금관 | GeneralUser / Philharmonia | 두 소스를 별도 프리셋으로 제공 | bass clarinet·contrabassoon의 실제 전용 음색 보존 |
| 말렛·harp·timpani | GeneralUser / VSCO subset | VSCO subset | GeneralUser판이 필요하면 별도 경량 프리셋으로 노출 |
| 드럼 | GeneralUser studio/electronic/brush / Salamander band | 사용 목적에 따라 명시적으로 선택 | GeneralUser는 경량·전자 색채, Salamander는 실드럼 질감 담당 |
| 오케스트라 타악 | GeneralUser / Philharmonia | 두 소스를 별도 프리셋으로 제공 | 긴 자연 tail과 악기 정체성이 다름 |
| EP/organ | GeneralUser | 현재는 경량 샘플만 사용 | 전용 실녹음 EP와 조절 가능한 tonewheel/Leslie는 아직 없음 |

UI에서는 악기 하나 아래에 `GM`, `Philharmonia`, `VSCO` 변형으로 묶어 보여주고, 77개를 평평한 목록으로 늘어놓지 않는 편이 Aria의 비전과 맞다.

## 6. 아직 부족하거나 사실상 없는 음원

| 악기군 | 현재 상태 | 실질 공백 | 우선도 |
|---|---|---|---:|
| Solo/section strings | Philharmonia normal/pizz/sord가 로컬 선택지로 활성 | staccato, tremolo, legato/transition, 여러 RR와 section 운용 | P1: articulation·section 확장 |
| Woodwinds/brass | Philharmonia normal 중심 | staccato/accent/legato, piccolo, bass flute, soprano/tenor/baritone sax, bass trombone | P1 |
| Acoustic/electric guitar | GeneralUser 근사만 있음 | 실제 strum, palm mute, fret/position, release/noise, chord voicing | P1 |
| Electric/acoustic bass | GeneralUser 샘플 | finger/pick/slap/ghost/slide/mute/RR | P1 |
| Band drums | 28-header 축소본 | RR, 더 많은 cymbal/hat articulation, brush, mic/room 선택 | P1 |
| Rhodes/Wurli/organ | GeneralUser 샘플 | 전용 실녹음 EP, pedal/release, Leslie/rotor | P1~P2 |
| Choir/voice | GeneralUser Aahs뿐 | 남녀/section, vowels, dynamics, releases, phrases가 아닌 chromatic playable choir | P1, 단 권리 검토 중요 |
| World/folk | GeneralUser 내부 일부가 UI에 노출되지 않음 | kalimba/mbira, recorders, harmonica, didgeridoo, hand percussion, regional strings | P2 |
| Orchestral color percussion | VSCO 4 mallet + Philharmonia 일부 | vibraphone, tubular bells, gong, bell tree, mark tree, hand percussion 확장 | P1~P2 |
| Sound effects/foley | GeneralUser SFX가 사실상 숨겨짐 | 현대적 field/foley 및 디자인 팩 | P3, 작곡 코어와 분리 |

## 7. 미수집 후보 조사

### 7.1 제품에 넣거나 앱에서 직접 설치하기 좋은 후보

| 후보 | 규모·악기 | 포맷 | 라이선스 | 품질 근거 | Aria 판단 |
|---|---|---|---|---|---|
| [VSCO 2 CE 전체판](https://versilian-studios.com/vsco-community/) | 약 3 GB / 약 3,000 samples. strings section 다중 주법, woodwinds, brass, harp, piano, organ, timpani, mallets, percussion | Raw WAV 44.1 kHz 16/24-bit + Vanilla SFZ | **CC0** | 공식 설명상 자연스럽고 ambient/calm에 강한 대신 GM보다 느슨할 수 있음 | **P1 최우선. 원본 3,168 WAV는 이미 scratchpad에 있다.** 새 다운로드가 아니라 SFZ engine 또는 재현 가능한 curated pack이 필요 |
| [VCSL](https://versilian-studios.com/vcsl/) | 약 5 GB / 4,000+ samples. pianos, harpsichords, organs, harps, recorders, harmonicas, sax, world instruments, 방대한 타악 | WAV + SFZ | **CC0** | 전문 녹음·편집, pitch consistency 우선. 대신 많은 RR/velocity/articulation보다 폭넓은 악기 수에 초점 | **P1.** 건반·월드·타악 공백을 한 번에 메움. 전체 다운로드보다 악기별 선택 설치 권장 |
| [VCSL Keys](https://versilian-studios.com/vcsl-keys/) | 680 MB / 1,466 samples. 3 grands, 2 uprights, 5 harpsichords | SFZ + lossless FLAC | **CC0** | releases 포함, 각기 다른 빈티지/실사용 피아노 캐릭터 | P2. Salamander와 기능 중복이 커서 “피아노 색채 팩”으로 선택 설치 |
| [University of Iowa MIS](https://theremin.music.uiowa.edu/MIS.html) | 관현악, sax, bass flute/clarinet, bass trombone, guitar, piano, mallets/hand percussion. pp/mf/ff와 일부 주법 | Raw audio, 구형 16/44.1 mono + 신형 24/96 stereo | 공식 사이트가 “any projects, without restrictions” 고지. 표준 SPDX 라이선스는 아님 | anechoic/dry 녹음, 일부 고해상도 Decca Tree 세션 | **P1~P2 선별팩.** 저음 목관·sax·bass trombone 구멍에 특히 좋음. loop/level/SFZ 제작 필요 |
| [FreePats](https://freepats.zenvoid.org/) 개별 음원 | clarinet, timpani, guitars, recorders, percussion 등 악기별 소형 bank | SF2 또는 SFZ/WAV/FLAC | 개별 CC0/CC BY/GPL+exception | 원저작자·출처·라이선스를 엄격히 검증하는 프로젝트 | **P1 구멍 메우기.** 각 악기 license/hash를 manifest에 별도 기록. 불완전 GM bank를 기본값으로 쓰지는 않음 |
| [MuseScore General](https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/) | full GM + GS/표현 변형, SF2 약 206 MB | SF2 / SF3 | MIT, 원 저작권·라이선스 고지 유지 | sample-source 표가 공개되어 GeneralUser보다 provenance가 명확한 편. 다만 SoundFont 2.01 modulators를 충분히 처리하는 재생기가 필요 | **P2 starter A/B 후보.** 현재 Aria 부분 파서에 파일만 바꿔 끼우면 원래 음색을 재현한다고 보장할 수 없음 |
| [Karoryfer 무료팩](https://shop.karoryfer.com/pages/free-samples) | bass guitars, double bass, guitars, drums, cello, sax, tuba, experimental voice 등 | 주로 WAV + SFZ | 공식 목록상 **CC0**, Marie Ork 예외 | 악기별 상세 샘플·주법을 제공하는 독립팩 | **P1 band 후보.** 기타·베이스·드럼을 작은 단위로 실제 A/B한 뒤 채택 |
| [Salamander Drumkit 원본](https://rytmenpinne.wordpress.com/sounds-and-such/salamander-drumkit/) 재구성 | 여러 velocity와 다수 반복 샘플, 더 많은 cymbal/hat articulation | WAV + SFZ | 공식 2022 PD 고지; archive의 구형 CC BY-SA 문구와 함께 증빙 보존 필요 | 현재 28-header 축소본보다 원본의 RR 구조가 훨씬 풍부 | **P1.** 새 음원을 찾기 전에 이미 가진 원본을 제대로 재생하는 편이 효율적 |

### 7.2 밴드·건반·월드 후보 상세

#### 현재 SF2 엔진에서 바로 A/B할 수 있는 소형 후보

| 후보 | 악기·용량 | 라이선스 | 기술·품질 정보 | 판단 |
|---|---|---|---|---|
| [FreePats World & Rare Percussion](https://freepats.zenvoid.org/Percussion/world-and-rare-percussion.html) | SF2 4.9 MiB. cajón, bongos, shaker, tambourine, clap, claves, castanets, conga, maracas, darbuka | CC0 | SFZ/Hydrogen판에는 RR/random layer가 있지만 SF2 변환에서는 손실 | **P1 초소형 world percussion 팩.** 가장 적은 비용으로 공백을 메움 |
| [AVL Drumkits](https://www.bandshed.net/avldrumkits/) | Black Pearl 19 MiB, Red Zeppelin 25 MiB, Blonde Bop 30 MiB, Hot Rod 29 MiB, Buskman percussion 42 MiB | CC BY-SA 3.0. 제작 음악은 attribution 없이 상업 사용 가능, 샘플/포맷 수정·포크는 표시와 share-alike 필요 | 공식 설명상 4 kits, 28 zones, 5 velocity layers. RR는 명시되지 않음 | Salamander의 절대 상위호환보다 rock/jazz/root 캐릭터 다양화. 별도 선택팩 |
| [FreePats Muldjord stereo kit](https://freepats.zenvoid.org/Percussion/acoustic-drum-kit.html) | SF2 53 MiB. 2 kicks, snare, 4 toms, HH, crashes, rides, china | CC BY 4.0 | velocity layers. randomized 동작은 SFZ판에만 있음 | metal/rock 확장용 즉시 A/B 후보 |
| [FreePats clean/jazz/direct electric guitar](https://freepats.zenvoid.org/ElectricGuitar/clean-electric-guitar.html) | SF2 129/66/60 MiB | CC0 | Fender direct와 amp/effect 처리 버전. layer/RR 상세는 불명 | GeneralUser보다 출처는 명확. **청취 전 premium 판정 금지** |
| [FreePats distorted electric guitar](https://freepats.zenvoid.org/ElectricGuitar/distorted-electric-guitar.html) | SF2 317/121 MiB | CC0 | distorted/processed 버전, layer/RR 상세 불명 | rock guitar 색채 A/B 후보. amp/cab 편집성은 낮음 |
| [FreePats clean electric bass](https://freepats.zenvoid.org/ElectricGuitar/clean-electric-bass.html) | pick 2.2 MiB / finger 2.5 MiB SF2 | CC0 | layer/RR 상세 불명 | 크기는 좋지만 flagship가 아니라 경량 선택지 후보 |
| [FreePats electric organ](https://freepats.zenvoid.org/Organ/electric-organ.html) | drawbar 5.8 MiB, percussive 12 MiB, rock 12 MiB SF2 | CC0 | setBfree 출력을 정적으로 샘플한 bank | 즉시 사용 가능하지만 drawbar/Leslie 조절은 없음 |
| [FreePats synthesized FM piano](https://freepats.zenvoid.org/ElectricPiano/synthesized-piano.html) | 13/4.6 MiB SF2 | CC0 | synth 출력의 정적 sample | 현재 GeneralUser Electric Piano 2와 역할이 겹친다. 낮은 우선순위 |

#### SFZ 또는 전용 mapping을 도입할 때 가치가 큰 후보

| 후보 | 악기·용량 | 라이선스 | 표현력 근거 | 판단 |
|---|---|---|---|---|
| [Karoryfer Emilyguitar](https://shop.karoryfer.com/pages/free-emilyguitar) | 98 MiB, 323 samples, 24-bit WAV+SFZ | CC0 | 4 velocity × 3 RR, release 4 RR, noises 5 RR, chord/unison mappings | **electric guitar P1.** 크기 대비 가장 설득력 있음. DI 성격이라 Aria amp/cab가 없으면 dry하게 들릴 수 있음 |
| [Karoryfer Black & Blue Basses](https://shop.karoryfer.com/pages/free-black-and-blue-basses) | 1.009 GB release, 2,000+ samples. 두 5-string bass | CC0 | finger: pluck 4 dynamics × 4 RR, releases 4 RR, ghost/staccato. pick: 고음 8 RR/저음 4 RR | **bass flagship P1.** 다만 slap/pop은 여전히 공백 |
| [Greg Sullivan E-Pianos](https://sfzinstruments.github.io/pianos/greg_sullivan_e-pianos/) | 21.5 MiB. Yamaha CP80, Hohner Pianet T, Wurlitzer EP200 | CC BY 3.0 | SFZ v2/ARIA extension + FLAC의 매우 작은 실악기 팩 | **EP P1.** 실제 Rhodes는 포함하지 않음 |
| [Virtuosity Drums](https://github.com/sfzinstruments/virtuosity_drums) | 약 1.14 GiB. modern jazz kit, 약 1,000 performances/4,900 files, 6 mixable mic positions | CC0 | snare/tom/HH/cymbal 다수 articulations와 GM percussion | **jazz/general drum 품질 후보.** 현재 mono/SF2 renderer와 맞지 않아 SFZ·streaming 뒤에 평가 |
| [Karoryfer Swirly Drums](https://shop.karoryfer.com/pages/free-swirly-drums) | 868.6 MiB, 4,700+ brush samples | CC0 | stir/flutter, HH 6 openness, 5 toms, cymbals, cajón/djembe/bongo/darbuka | brush/indie-jazz 공백에 독보적. 단순 SF2 변환 시 장점 손실 |
| [Karoryfer Gogodze Phu Vol. I](https://shop.karoryfer.com/pages/free-gogodze-phu-vol-i) | 90 MiB, 544 WAV. Ghana bobobo drums 5종 + cajón | CC0 | world percussion 특화 실녹음 | VCSL 전체가 너무 클 때 작은 특화팩으로 적합 |
| [University of Iowa classical guitar](https://theremin.music.uiowa.edu/MISguitar.html) | AIFF 243 MiB(16/44.1 stereo) 또는 1.22 GB(24/96 stereo) | 공식 unrestricted project use | Raimundo 118을 현별 chromatic, pp/mf/ff, anechoic/Decca Tree로 녹음 | **nylon guitar P1 원천.** RR 없음, 직접 mapping 필요. 깨끗한 steel-string acoustic은 별도 공백 |

### 7.3 Choir·voice 조사 결론

**제품에 재배포할 수 있고, 실제 합창이며, chromatic하게 연주 가능하고, 범용 기본팩으로 삼을 만한 후보는 이번 조사에서 확정하지 못했다.** 현재 가장 명확한 실질 공백이다.

| 후보 | 구성 | 라이선스/제약 | 판단 |
|---|---|---|---|
| [Dave Choir](https://www.decentsamples.com/product/dave-choir-kontakt/) | 68 MiB, 한 baritone voice를 16회 overdub, Ah/Ooh, 352 notes, 1 layer/0 RR | 무료 SFZ/Kontakt/Decent Sampler지만 [EULA](https://www.decentsamples.com/decent-samples-end-user-license-agreement/)가 샘플 재배포를 금지 | 링크를 통한 user-installed 비교만. flagship choir로는 얕음 |
| [Karoryfer 272 Merry Orks](https://shop.karoryfer.com/pages/free-272-merry-orks) | 38 MiB, female death-metal phonemes, vowels 3 RR/consonants 4 RR | CC0 | 특수 보컬 효과. choir 대체가 아님 |
| Karoryfer Hadziha/Torgbe | 약 0.98/1 GB, 2,300/3,800 samples의 실제 choir 상품 | 유료 SFZ이며 sample redistribution 허용 근거 없음 | user-installed 상용팩 후보일 뿐 Aria 배포 자산 아님 |
| [FreePats Synth Pad Choir](https://freepats.zenvoid.org/Synthesizer/synth-pad.html) | 소형 SF2 | CC0 | 합성 pad | 현재 GeneralUser pad 영역과 중복, 실제 choir 아님 |

추가로 남은 진짜 공백은 **permissive steel-string acoustic guitar, slap/pop bass, true Rhodes/Clavinet, 조절 가능한 tonewheel+Leslie organ, redistributable real choir/solo voice**다. 이름이 비슷한 근사 음원을 억지로 “수집 완료”로 표시하면 안 된다.

### 7.4 로컬 직접 다운로드에는 좋지만 Aria가 재배포하면 복잡한 후보

| 후보 | 장점 | 라이선스/제품화 위험 | 판단 |
|---|---|---|---|
| [Virtual Playing Orchestra 3.3](https://virtualplaying.com/virtual-playing-orchestra/) | 603 MB WAV, solo+section, sustain/normal/staccato/accent, strings pizz/tremolo, 일부 RR·dynamic crossfade | Sonatina, NBO, VSCO, Iowa, Philharmonia 등 **혼합 라이선스**. 상업 음악 사용은 허용되지만 재포장·파생팩은 출처별 조건과 무료 유지 요구 | 사용자 로컬 설치 팩/음질 비교에는 좋음. Aria 공식 배포 원천으로는 제외 |
| [Sonatina Symphonic Orchestra 4](https://github.com/peastman/sso) | 1.39 GB, 넓은 full orchestra와 다중 주법, choir/organ 포함 | CC Sampling Plus 1.0, Philharmonia와 구형 출처 불명 샘플을 README가 직접 고지 | 표현력 연구·로컬 비교만. 제품 자산으로 채택 금지 권고 |
| Philharmonia 원본 전체 | 이미 검증된 전문 단원 녹음, guitar/mandolin/banjo와 방대한 percussion까지 존재 | sampler instrument로 제공 금지 | 앱이 공식 원본 링크를 열고 **사용자 컴퓨터에서만** 변환하도록 설계. 변환 SF2 호스팅 금지 |

### 7.5 내장 후보가 아니라 품질·UX 기준점으로만 볼 것

| 후보 | 규모·특징 | 왜 내장하지 않는가 | 활용 |
|---|---|---|---|
| [Berlin Free Orchestra](https://www.orchestraltools.com/berlin-free-orchestra) | 34 instruments, 67 articulations, 최대 2 dynamics/RR, 약 3 GB | SINE 전용, 샘플 추출·변환·재배포 금지 | 프로 오케스트라 음질·articulation UX benchmark |
| [BBC Symphony Orchestra Discover](https://www.spitfireaudio.com/en-us/products/bbc-symphony-orchestra-discover) | 34 instruments, 47 techniques, 약 240 MB | Spitfire 전용 plugin, 샘플 재배포 금지 | 작은 용량에서의 instrument/technique 설계 benchmark |
| [ProjectSAM Free Orchestra](https://projectsam.com/libraries/the-free-orchestra-2) | cinematic ensemble, choir, effects, 1.8+8.6 GB uncompressed | Kontakt Player/Native Access, 파생 sampler 재배포 금지 | cinematic texture와 preset UX benchmark |

## 8. “더 다운로드”보다 먼저 고칠 재생 품질 병목

| 현재 누락/제약 | 소리에 미치는 영향 | 권장 |
|---|---|---|
| SoundFont modulators 미지원 | GeneralUser의 velocity/filter/controller 설계가 사라져 악기별 음색·세기 변화가 틀어짐 | [SpessaSynth core](https://github.com/spessasus/spessasynth_core) 같은 완전한 JS SoundFont 엔진을 우선 A/B하거나 FluidSynth bridge 검토 |
| Filter/LFO 미지원 | synth brass, pads, EP, organ 등에서 원래 의도와 다른 거친/평평한 소리 가능 | 위와 동일 |
| Stereo sample link·zone pan 미재현 | Salamander 같은 stereo 녹음의 공간감이 mono 합에 가까워질 수 있음 | stereo pair와 pan을 보존하는 renderer 필요 |
| 커스텀 빌더가 stereo WAV를 mono 평균 | 이후 엔진을 고쳐도 이미 만든 Philharmonia/VSCO 파생팩에는 원래 공간 정보가 없음 | source가 stereo인 팩은 channel/link를 보존해 재빌드 |
| Velocity layer hard switch | layer 경계에서 음색과 음량이 갑자기 바뀔 수 있음 | 원본 의도에 맞는 layer curve/crossfade 지원 |
| Exclusive group 미지원 | open/closed hi-hat choke 등 실제 드럼 동작이 어색함 | SF2 exclusiveClass 및 SFZ group/off_by 지원 |
| Round robin 미보존 | 같은 드럼/short articulation 반복에서 machine-gun 효과 | 원본 RR을 manifest/build/runtime 모두에 유지 |
| SFZ 미지원 | VSCO/VCSL/VPO의 공식 patch와 articulation을 버리고 축소 변환해야 함 | 필요한 SFZ opcode subset 구현 또는 별도 engine 검토. [sfizz](https://github.com/sfztools/sfizz)는 BSD-2-Clause지만 2026-06-21 archive되어 유지보수 인수/포크 위험을 먼저 평가. [liquidsfz](https://github.com/swesterfeld/liquidsfz)는 RR·keyswitch·CC crossfade를 지원하는 현행 PoC 후보지만 macOS/Windows 빌드와 MPL-2.0 통합을 먼저 검증 |
| 모든 SF2를 통째로 메모리에 로드/cache | 1.2 GiB piano와 향후 3~5 GB 팩에서 메모리 압박 | sample streaming, lazy zone/sample load, FLAC/SF3 전략 |

GeneralUser 공식 문서는 standards-compliant synth 의존성이 높고 BASSMIDI, FluidSynth, SpessaSynth 등을 호환 대상으로 든다. 따라서 현재 `src/sf2.js`의 “기본 재생 품질에는 현재 부분집합으로 충분하다”는 주석은 실제 제품 판단 기준으로는 너무 낙관적이다.

## 9. 권장 음원 팩 구조

| 팩 | 기본 포함 여부 | 내용 | 설치 방식 |
|---|---|---|---|
| Starter | 예 | GeneralUser 또는 더 명확한 외부 starter bank | 앱 첫 실행 시 경량 다운로드. 완전한 SF2 engine 전제 |
| Piano HD | 선택 | Salamander C5 | 공식 출처/저자/CC BY 표시 후 다운로드, attribution 보존 |
| Orchestra HD Local | 선택 | Philharmonia strings/winds/brass/perc | 공식 원본을 사용자 컴퓨터가 직접 받아 로컬 빌드. 변환본 재배포 금지 |
| Orchestra Open | 선택 | VSCO 2 CE full + 필요한 FreePats/Iowa 보강 | CC0 중심. 악기/주법 단위 선택 설치 |
| Band | 선택 | 실제 guitar/bass/drums/EP/organ | Karoryfer·Salamander 원본 등 검증된 팩을 A/B 후 선별 |
| Color & World | 선택 | VCSL recorders, harmonicas, mbira/kalimba, hand percussion 등 | VCSL 악기별 선택 설치 |
| Voice/Choir | 보류 | 전용 playable choir/voice | 권리·언어·음소·용량 검증 후 별도 팩. 현재는 신뢰할 만한 범용 기본팩 미확정 |

### manifest에 반드시 넣을 필드

| 필드 | 예시/용도 |
|---|---|
| `id`, `version`, `displayName` | 곡 저장값과 UI 이름을 안정적으로 유지 |
| `sourcePage`, `downloadUrl` | 원본 페이지를 항상 사용자에게 노출; hotlink 금지 정책이 있으면 페이지 열기만 제공 |
| `authors`, `recordingCredit` | 연주자·녹음자·편집자 기록 |
| `licenseId`, `licenseUrl`, `licenseSnapshot` | 나중에 페이지가 바뀌어도 설치 당시 근거 보존 |
| `redistribution` | `bundle`, `download`, `local-build-only`, `external-only` 중 하나 |
| `format`, `engineRequirements` | SF2/SF3/SFZ/WAV, 필요한 opcode/engine |
| `bytes`, `sha256`, `installedFiles` | 다운로드 무결성·중복·업데이트 판단 |
| `instruments`, `articulations`, `velocityLayers`, `roundRobins`, `micPositions` | 품질과 기능을 UI/AI가 이해하는 데이터 |
| `replacementPreset`, `legacyAliases`, `missingAssetBehavior` | 기존 곡 이전 후보를 기록하되 자동 대체하지 않고 설치/교체 선택지를 명시 |
| `qualityEvidence`, `knownLimitations` | 홍보 문구와 실제 Aria 재생 품질을 분리 |

권장 경로는 `~/.aria/assets/<pack-id>/<version>/`이며, 원본 cache와 생성된 runtime pack을 분리한다. Git에는 manifest, 빌더, 라이선스/attribution 텍스트만 추적한다.

## 10. 현재 빌드·관리상의 확정 문제

| 문제 | 현재 증거 | 영향 | 수정 방향 |
|---|---|---|---|
| 임시 절대경로 의존 | `tools/build-*.mjs` 네 파일이 `/private/tmp/.../scratchpad`를 하드코딩 | 다른 컴퓨터·새 세션에서 재빌드 불가 | manifest의 asset root 또는 CLI 인자로 전환 |
| SF2 저작권 메타데이터 | writer의 Philharmonia 고정값은 제거했고 빌더가 팩별 `ICOP`를 전달 | 기존에 이미 생성한 파일은 재빌드 전까지 옛 메타가 남을 수 있음 | manifest·라이선스 스냅샷을 만든 뒤 팩별로 재빌드 |
| 라이선스 파일 미동봉 | 런타임 폴더에는 SF2만 있고 attribution/license manifest 없음 | 배포·감사·업데이트 시 근거 소실 | 각 팩 옆에 license snapshot과 provenance JSON 저장 |
| Aria 자체 LICENSE/NOTICE 없음 | 저장소 root에 프로젝트 라이선스와 third-party notice가 없음 | 공개 배포 범위와 제3자 자산 고지가 불명확 | 코드 라이선스 결정 후 root LICENSE + THIRD_PARTY_NOTICES 추가 |
| 악기 선택 목록의 탐색성 | 같은 악기의 GM/Philharmonia/VSCO/Salamander 변형은 현재 악기 가족별로 묶임 | 71개 선율 악기가 늘면 가족 자체를 찾는 스크롤은 여전히 길어질 수 있음 | 현재 묶음과 저장 ID·strict 누락 표시는 유지하고, 필요할 때 악기 대분류나 검색을 추가 |
| Salamander drum RR 손실 | builder가 velocity별 첫 RR만 선택 | 반복 드럼이 기계적으로 들릴 수 있음 | 원본 RR 보존 가능한 SFZ/runtime 구조로 재작성 |
| GeneralUser 엔진 불일치 | 공식 문서는 완전한 synth 의존, 현재 parser는 modulator/filter/LFO 생략 | 작은 파일의 장점을 제대로 못 살림 | 엔진 A/B 후 parser 교체/보강 |

## 11. 실행 우선순위

### P0 — 가진 것을 잃지 않고 정상화

1. 현재 별도 프리셋으로 연결된 Philharmonia 4개를 `local-only` manifest에 등록한다.
2. 현재 구현된 악기별 `GM / Philharmonia / VSCO / Salamander` 변형 묶음과 미설치 표시를 회귀 테스트로 유지한다.
3. 임시 scratchpad 7.4 GiB를 영구 asset cache로 옮기고 원출처 URL·라이선스·hash를 연결한다.
4. `sf2write`의 잘못된 `ICOP`와 빌드 절대경로를 수정한다.
5. 현재 8개 파일의 동일 음정 A/B와 대표 곡 회귀 청취를 보존한다.

### P1 — 재생 엔진과 가장 큰 공백

1. SpessaSynth core를 현재 parser와 동일 MIDI 구간으로 A/B해 GeneralUser·Salamander 품질과 CPU/RAM을 비교한다.
2. SFZ 지원 경로를 결정한다. 이 결정 전에는 3~5 GB 원본을 무작정 내려받지 않는다.
3. 이미 로컬에 있는 VSCO 2 CE 전체 원본에서 strings/winds/brass articulation을 선별 설치한다.
4. Salamander Drumkit RR 복구 또는 Karoryfer/DrumGizmo 후보로 band drum을 강화한다.
5. guitar·bass 전용 SFZ 후보를 실제 곡에서 비교해 각 1개만 기본 후보로 채택한다.

### P2 — 색채 확장

1. VCSL의 world/hand percussion/recorders/harmonicas/organ을 악기 단위로 추가한다.
2. Iowa에서 bass flute, bass clarinet, sax, bass trombone 등을 선별한다.
3. 전용 Rhodes/Wurli/organ 팩을 검증한다.
4. 범용 choir는 권리와 재생 방식이 명확한 후보가 나올 때까지 GeneralUser Choir Aahs를 현재 선택지로 남긴다.

## 12. 파일 무결성 부록

| 파일 | SHA-256 |
|---|---|
| `default.sf2` | `9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe` |
| `salamander.sf2` | `712d0e681efbe5203a8014e9b3e84168f1908c82f2f6fb13bd2c77d6d72c70b7` |
| `salamander-kit.sf2` | `5b0de0a1b8f82050a8f5a371eb05c3bb8d9b32bc1a4941e59477eda37cf191dc` |
| `vsco.sf2` | `1e6032926a478a781cfc91bc3161fb7908e87477e31eae63a8f4f7226999f34b` |
| `philharmonia.sf2` | `5afd66cc7be95c16a90a438b04fa67fa7991b2b7a25cbe30d47f1c11ef42476e` |
| `phil-winds.sf2` | `4747cac5d5adec7d5280e6562fb0c190aeec8204f81dddb544cc3e4d12968a5e` |
| `phil-brass.sf2` | `d678a2d992ad12cf496403b7da0dc8ecd68a86f97068e812b12d628dada24ac2` |
| `phil-perc.sf2` | `0555ff5f071bbd010ac9b598861d7cddba4fdf9480e6952ee3e705e1bff54443` |

## 13. 근거와 한계

- 1차 근거는 로컬 바이너리·소스 코드·공식 프로젝트 페이지·공식 라이선스 문서다. 랜덤 SoundFont 모음, 출처가 불명확한 재업로드와 커뮤니티의 “royalty free” 주장만 있는 팩은 후보에서 제외했다.
- “상/중/스케치”는 녹음 예술성의 절대 점수가 아니다. 샘플 구조와 현재 Aria 엔진에서 얻을 수 있는 현실적인 결과를 나타낸다.
- 공개 샘플의 “음악 제작 허용”과 “샘플러로 재배포 허용”은 다르다. Philharmonia가 대표적인 사례다.
- Salamander Drumkit은 로컬 archive의 구형 CC BY-SA 문구와 저자의 2022 public-domain 공지가 함께 존재한다. 최종 배포 manifest에는 두 근거를 모두 보존하고, 법적 보수성 때문에 attribution을 계속 제공하는 것이 안전하다.
- choir/voice는 특히 출처와 연주자 동의, phoneme/언어, 파생 샘플 배포 조건이 복잡하다. 이번 조사에서는 제품 기본팩으로 바로 채택할 만큼 명확하고 범용적인 후보를 확정하지 않았다.

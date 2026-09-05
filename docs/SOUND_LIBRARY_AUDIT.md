# Aria 음원·샘플 재생 현황

처음 설치하는 사용자의 다운로드·파일 선택·소리 확인 흐름과 2026-09-05 공식 조건 재검토는 [소리 준비하기](SOUND_SETUP.md)를 참고하세요. 아래의 설치 개수는 당시 로컬 상태이며 새 설치에 음원이 포함된다는 뜻이 아닙니다.

- 기준일: 2026-08-09
- 목적: 현재 **설치됨**과 아직 비교가 필요한 **후보**를 섞지 않고, 실제 레지스트리·팩 manifest·설치 메타데이터가 말하는 범위를 기록한다.
- 원칙: 파일 수가 많다는 이유만으로 품질을 단정하지 않는다. 원본 녹음, 주법·강약·라운드로빈 보존, 엔진 재현, 실제 곡 안의 A/B를 따로 본다.

## 결론

1. Aria 자체 합성 신스는 제거됐다. 현재 제품은 외부 샘플 프리셋(SF2/SFZ)을 검증된 오픈소스 엔진으로 재생한다.
2. SF2/DLS는 `spessasynth_core@4.3.16`, SFZ는 고정 버전의 `sfizz` 사이드카가 실제 재생·WAV·스템 경로에 연결돼 있다.
3. 필요한 팩·프리셋·bank/program·키·벨로시티 샘플이 없거나 손상되면 명시적으로 실패한다. 비슷한 악기나 무음으로 몰래 대체하지 않는다.
4. VSCO 2 CE, Philharmonia 전체판, Salamander Drumkit v4는 모두 `~/.aria/packs/`에 설치돼 있고 checksum 검증을 통과했다. 세 팩의 manifest 카탈로그는 각각 462, 1,565, 10개다.
5. 현재 전체 레지스트리는 **2,114/2,114개 사용 가능**이다. 음정 악기 333개, 드럼·타악 90개, 사용자와 MCP에 공개된 Recorded Clip(녹음 클립) 1,691개다. 드럼·타악과 클립 레지스트리를 합치면 1,781개다.
6. VSCO 원본 WAV 3,168/3,168, Philharmonia 정상 원본 13,681/13,681, Salamander WAV 536/536이 실제 재생 항목에 연결됐다. Philharmonia의 공식 archive에 처음부터 들어 있던 0-byte 파일 2개는 정상 음원으로 가장하지 않고 결함으로 기록한다.
7. GUI와 MCP는 VSCO 키스위치 프리셋 8개의 실제 아티큘레이션을 선택할 수 있다. Salamander key 42의 닫힌 하이햇과 반열림 7단계는 피스 ID를 고르면 CC64 값이 자동으로 전달된다.
8. GUI에는 음원 팩의 출처·라이선스·상태를 보여 주는 **음원 관리**와 이름·악기군·출처·주법으로 찾는 **검색형 프리셋 선택창**이 있다. 사용할 수 없는 항목이 생겨도 숨기거나 다른 음색으로 대체하지 않고 이유를 표시한다.
9. 지금 가장 중요한 남은 품질 문제는 “엔진이 없어서”가 아니다. 실제 transition sample(전이 녹음)을 포함한 레가토와 장르별 필요한 주법이 원본에 있는지, 대형 팩의 로딩 비용이 적절한지, 곡 안에서 각 음색이 역할에 맞는지가 핵심이다.

## 현재 상태

| 구분 | 상태 | 규모 | 의미 |
|---|---|---:|---|
| GeneralUser GS 등 로컬 SF2 | 사용 가능 | 로컬 SoundFont별 상이 | 경량 GM·전자음·패드·리드와 기존 음색 선택지 |
| Salamander Grand Piano SF2 | 사용 가능 | 약 1.2 GiB, 16 velocity layers | Yamaha C5 고해상도 피아노 선택지 |
| VSCO 2 CE 전체 SFZ판 | **설치됨·전수 연결 완료** | 카탈로그 462, WAV 3,168/3,168 | 원래 SFZ 75개 보존 + 보강·alias 정리; 음정 악기 78 + 킷 1 + 클립 383 |
| Philharmonia 전체 SFZ판 | **설치됨·전수 판정 완료** | 카탈로그 1,565, 공식 MP3 13,683 | 음정 악기 184 + 무음정 one-shot 74 + 클립 1,307; 정상 13,681, 공식 0-byte 결함 2 |
| Salamander Drumkit SFZ v4 | **설치됨·전수 연결 완료** | 카탈로그 10, WAV 536/536 | 킷·모듈 9 + 미편집 반복 킥 클립 1; 정상 킷 535 + 클립 1 |

이 표를 포함한 전체 레지스트리에는 로컬 SF2 선택지도 함께 들어가므로 세 managed SFZ 팩의 카탈로그 합계와 2,114개 전체 프리셋 수는 같지 않다. 설치 상태의 최종 source of truth는 GUI의 **음원 관리**, `/api/packs`, 각 팩의 `.aria-pack.json`이다. MCP 작업에서는 `list_presets` 요약과 필터 검색으로 현재 상태를 다시 확인한다.

## 재생 엔진

| 포맷 | 활성 엔진 | 현재 보존하는 핵심 정보 | 남은 제약 |
|---|---|---|---|
| SF2/DLS | [SpessaSynth Core 4.3.16](https://github.com/spessasus/spessasynth_core) | 스테레오 sample link와 zone pan, 필터, LFO(저주파 진동기), 엔벌로프, 모듈레이터, bank/program, 벨로시티 레이어, exclusive class | 비압축 PCM만 지원하며 SF3는 지원하지 않음. 큰 SF2는 처음 해석할 때 순간 메모리 사용량이 큼 |
| SFZ | [sfizz](https://github.com/sfztools/sfizz) commit `f5c6e29f23b8057867c08e88f5f6ac6738baa30b` | 정확한 sample path와 key/velocity 범위, 라운드로빈, 기본 pitch bend, keyswitch/CC, `off_by` 계열 드럼 초크 | 현재 동기식 로컬 사이드카. 앱과 격리된 worker/process로 옮기는 성능 최적화는 남음 |

sfizz 바이너리 SHA-256은 `d2138b1723d0d75d58391f0353a5ee4d4c8a422ad616a2df02f9c4dfae2fed43`이며, AppleClang 호환 패치와 제3자 라이선스 고지를 함께 고정한다. 엔진 계약과 검증 범위는 [ENGINE_BACKENDS.md](./ENGINE_BACKENDS.md)를 따른다.

### Strict no fallback(엄격한 자동 대체 금지)

아래 상태를 “대충 비슷한 소리”로 감추지 않는다.

- 팩 또는 파일이 설치되지 않음
- manifest·entry·sample checksum이 다름
- SF2 bank/program 또는 SFZ entry가 없음
- 요청한 음정·벨로시티에 대응하는 zone/sample이 없음
- include/sample path가 팩 밖으로 벗어나거나 파일이 손상됨

UI와 MCP는 가능한 경우 설치할 팩과 정확한 원인을 함께 보여 준다. 이 계약은 사용자가 지금 듣는 음색의 출처를 믿을 수 있게 하는 제품 기능이다.

## 탑재 팩

### VSCO 2 CE 전체 SFZ판 — 설치됨

| 항목 | 값 |
|---|---|
| 공식 출처 | [VSCO 2 Community Edition SFZ 저장소](https://github.com/sgossner/VSCO-2-CE) |
| 고정 소스 | 공식 commit `6dd651d55dde97fd4028699be9d4481f26917891`, tree `553ef3b90c87fe43ef19a3a8f8965a4a2945d570`; 관리 archive SHA-256 `bbd116c767cccc48778c43d79568fd19ee1c48d748444792ae95a944d54dac74` |
| 라이선스 | CC0-1.0 |
| 원본 정의 | 공식 SFZ 75개, 공식 정의가 직접 참조한 고유 WAV 2,034개 |
| 보강·alias 회계 | 생성 정의 415개 중 byte-identical alias 28개를 중복 항목으로 만들지 않아 순보강 387개; `75 + 415 - 28 = 462` |
| Aria 카탈로그 | 462개: pitched instrument(음정 악기) 78 + 드럼·타악 킷 1 + Recorded Clip 383 |
| 전수 범위 | 원본 WAV 3,168개 중 3,168개 재생 가능, 미연결 0 |
| 실제 주법 선택 | 키스위치 프리셋 8개: cello ensemble, clarinet, contrabass, flute, solo violin, tuba, viola ensemble, violin ensemble |
| 설치 메타데이터 | 3,691 tracked payload files; checksum catalog `9c8a2d1f73958c5875dd5fdea57ae7dc9315662f4a909ce0babaa4cc5b9b14ee` |

과거 `vsco.sf2`는 일부 음색만 고른 축소 변환본이었다. 현재 전체판은 공식 75개 정의를 byte-for-byte로 보존하면서 공식 정의가 참조하지 않던 1,134개 WAV도 의미 있는 음정 악기 또는 Recorded Clip으로 연결했다. phrase, fall, effect, roll처럼 음계 악기로 해석하면 틀리는 자산은 key 60에서 원형 그대로 한 번 재생한다. 키스위치 프리셋 8개는 `list_presets`가 보여 주는 정확한 `articulation` ID를 `add_track` 또는 `set_track`에 주면 sfizz가 실제 제어 음을 보낸다.

### Philharmonia 전체판 — 설치됨

| 항목 | 값 |
|---|---|
| 공식 출처 | [Philharmonia Orchestra sound samples](https://philharmonia.co.uk/resources/sound-samples/) |
| 공식 archive SHA-256 | `411f789ed17194603689a7d47ae8e4488ec49e94047c67899252599eaa4838a3` |
| 공식 원본 | 13,683 MP3: 정상 13,681 + 원본 0-byte 결함 2 |
| 악기 SFZ | 258개: pitched instrument(음정 악기) 184개 + unpitched instrument(무음정 악기) 74개 |
| Recorded Clip(녹음 클립) | 1,307개 one-shot SFZ |
| 전체 런타임 | 1,565 SFZ; 정상 원본 13,681개 전부 연결; runtime missing 0 |
| 공식 결함 | `saxophone_Fs3_15_fortissimo_normal.mp3`, `viola_D6_05_piano_arco-normal.mp3`가 0 byte |
| 설치 메타데이터 | 15,253 tracked payload files; checksum catalog `7b36488748905181fbb40241be723d117447860ebddd2ff30fbfebcff6da483a` |

phrase·glissando·effect·rhythm·crescendo/decrescendo처럼 단일 음정 악기로 해석하면 틀리는 녹음은 모두 Recorded Clip(녹음 클립)으로 분리했다. 한 번 재생하는 원형 자산이며, 임의의 음계 악기처럼 늘이지 않는다.

Philharmonia 공식 조건은 샘플을 음악 작품과 상업 작품에 사용할 수 있게 하지만, 샘플 자체를 판매하거나 원형으로 제공하는 것은 허용하지 않는다. 따라서 archive와 변환본은 사용자 컴퓨터 안에서만 다루고 Aria 저장소나 배포 서버에 음원 바이너리를 올리지 않는다.

### Salamander Drumkit 전체 v4 — 설치됨

| 항목 | 값 |
|---|---|
| 공식 archive | [Salamander Drumkit](https://archive.org/details/SalamanderDrumkit) |
| archive SHA-256 | `34e746ec1721bb530b1caf5b17443ae3cde45a2cce1a80e2637e4c11d6f1e3f5` |
| 원본 | 536 WAV, 공식 SFZ 8개 |
| Aria 카탈로그 | 10개: 전체 킷 2 + 악기 모듈 7 + Recorded Clip 1; `salamander-all-full`이 권장 전체 킷 |
| 전수 범위 | WAV 536/536 재생 가능; 정상 킷 535개 + 미편집 반복 킥 원본 클립 1개 |
| 보존·교정 | key 35–64, velocity 1–127, random RR, open/closed hat choke; 공식 ALL에서 빠진 4개 take도 기존 그룹에 기록 후 편입 |
| key 42 하이햇 | Closed(닫힘) + Semi-open 1–7(반열림 1–7); 피스 ID별 CC64 값 `0, 10, 27, 45, 63, 81, 99, 118` 자동 선택 |
| 설치 메타데이터 | 559 tracked payload files; checksum catalog `052af2e1741e0ee0971b87edca4788f7b9c6318185b2c2e212c54944e0645dcf` |

공식 SFZ에 있던 잘못된 숫자, 빈 구간, 겹친 random/velocity 범위는 무시하지 않고 `catalog/repairs.json`에 근거를 남겨 교정했다. 44.556초짜리 `kick_OH_P_1.wav`는 정상적인 단발 킥으로 가장하거나 임의로 자르지 않았다. 일반 킷의 라운드로빈에서 제외하고 `Recorded Clip (녹음 클립) — 미편집 킥 반복 원본`으로 따로 노출했으며, 긴 끝부분까지 실제 sfizz 렌더로 확인했다.

아카이브 README는 CC BY-SA 3.0을 적고, 저자의 [공식 페이지](https://rytmenpinne.wordpress.com/sounds-and-such/salamander-drumkit/)는 2022년 public-domain 전환을 고지한다. 두 근거를 manifest와 고지에 함께 보존하고, 명확한 재라이선스 판단 전에는 보수적으로 attribution을 유지한다.

## “전부 탑재”의 의미

전수 탑재는 수천 파일을 한 악기 이름에 무작정 합치는 것이 아니다. 원본의 의미를 잃지 않으면서 모든 정상·허용 자산에 접근할 수 있게 하는 계약이다.

1. 원본 경로·크기·hash를 전수 기록한다.
2. 정상이고 사용이 허용된 모든 샘플을 instrument zone, articulation(주법), velocity layer(강약 층), round robin(반복 변형), recorded clip 중 하나에 연결한다.
3. 손상·완전 동일 중복·사용 불허 파일을 제외하면 이유를 기록한다. 단순히 “대표 샘플만 필요”하다는 이유로 버리지 않는다.
4. stereo channel, velocity, RR, release, mic position, keyswitch/CC, choke 관계를 원본 수준에서 보존한다.
5. source 수와 used + excluded 수가 맞지 않으면 팩 생성·설치를 실패시킨다.
6. 설치 후에도 manifest와 entry/sample checksum을 다시 검증한다.

이 계약에 따라 VSCO는 이전 미참조 WAV 1,134개까지 모두 연결했고, Philharmonia의 정상 원본 13,681개와 Recorded Clip 1,307개도 빠짐없이 노출했다. Philharmonia의 공식 0-byte 결함 2개는 제외 이유가 남아 있다. Salamander는 정상 킷 샘플 535개와 미편집 반복 원본 1개를 구분해 WAV 536개 전부에 접근할 수 있게 했다.

## 표현 품질을 해석하는 법

### 엔진이 해결하는 것

- 원래 매핑된 음정·강약·스테레오·필터·엔벌로프 재현
- 라운드로빈과 드럼 초크처럼 반복·상호작용 규칙 재현
- 실제 bank/program/entry를 엄격하게 고르는 것

### 엔진만으로 해결하지 못하는 것

- 원본에 녹음되지 않은 주법
- 짧게 녹음된 샘플의 자연스러운 무한 지속
- 현악기의 실제 활 방향과 음 사이 전이
- 기타의 strum·fret position·mute·release noise
- 여러 마이크 위치가 없는 원본에서 close/room stem을 만드는 것

특히 레가토(Legato, 음 사이를 부드럽게 이어 연주하는 주법)는 단순히 릴리스(Release, 음을 놓은 뒤 남는 여운)를 늘리는 효과가 아니다. true legato(실제 전이 레가토)는 앞 음에서 다음 음으로 넘어가는 transition sample(전이 녹음)과 전용 매핑이 있어야 한다. Philharmonia의 레가토·프레이즈 녹음 클립은 원형을 들을 수 있지만, 아직 모든 음정 사이를 연결하는 true-legato 악기로 재구성한 것은 아니다.

### Portable MIDI(다른 프로그램으로 옮길 수 있는 표준 MIDI) 계약

- 실제 노트가 있는 트랙에 `track.articulation`이 명시돼 있으면 MIDI 내보내기를 실패시킨다. VSCO의 녹음 주법과 키스위치를 단순 GM program으로 바꾸면서 조용히 버리지 않기 위한 strict 정책이다.
- 현재 소리를 보존하려면 WAV를 내보낸다. 편집 가능한 GM 근사가 목적이면 `set_track({track:"트랙 이름", articulation:null})`로 프리셋 기본 주법에 되돌린 뒤 MIDI를 내보낸다.
- `articulation`이 생략됐거나 `null`인 기본 주법은 기존 GM program 근사를 허용한다.
- 이 차단은 트랙 아티큘레이션에만 적용한다. Salamander 하이햇처럼 드럼 피스가 선언한 CC64는 해당 note-on 앞에 MIDI CC로 기록하므로 기존 피스 제어를 보존한다.

## 팩 관리와 검색 UX

- **음원 관리**: 팩 이름, 출처, 라이선스, 포맷, entry/sample 수, 설치 용량, 설치 가능·설치됨·오류 상태를 표시한다.
- **검색형 프리셋 선택**: 이름·ID·설명·악기군·출처·주법으로 검색하고, 선율 악기/드럼·타악을 나눠 볼 수 있다.
- **미설치 항목 표시**: 목록에서 숨기지 않고 선택 불가 상태와 정확한 이유를 보여 준다.
- **MCP 검색**: `list_presets()`는 먼저 출처·악기군 요약을 반환한다. 이후 `query`, `family`, `source`, `available_only`로 실제 ID와 드럼 피스를 좁힌다. 거대한 전체 목록을 매번 컨텍스트에 넣지 않는다.
- **종류별 검색**: `kind:"instrument"`, `kind:"percussion"`, `kind:"clip"`으로 333개 음정 악기, 90개 드럼·타악, 1,691개 공개 녹음 클립을 분리한다. 현재 설치 상태에서는 합계 2,114/2,114개가 사용 가능하다.
- **실제 주법과 피스 제어**: VSCO의 `articulation` 선택은 실제 키스위치를 보내며, Salamander의 하이햇 피스 ID는 실제 CC64 값을 보낸다. 화면용 이름만 바꾸는 장식 메타데이터가 아니다.
- **표현 방식**: 전문 용어를 먼저 쓰고 바로 쉬운 한국어 설명을 붙인다. 비음악인을 낮춰 부르지 않으면서도 원래 용어를 익힐 수 있게 한다.

## 라이선스·배포 원칙

| 자산 | 현재 판단 |
|---|---|
| VSCO 2 CE | CC0-1.0. 출처·commit·license hash를 manifest에 고정 |
| Salamander Grand Piano | CC BY 3.0. 저자와 출처 표시 유지 |
| Salamander Drumkit | archive의 CC BY-SA 3.0과 저자의 2022 public-domain 고지를 함께 보존; 보수적으로 attribution 유지 |
| Philharmonia | 음악 작품 사용은 허용되지만 샘플 원형 제공은 금지. 사용자 로컬 다운로드·변환만 허용 |
| GeneralUser GS | 프로젝트의 전용 허용 라이선스와 포함 샘플 provenance 주의사항을 함께 보존 |

Git에는 대용량 음원 바이너리를 넣지 않는다. manifest, 변환·설치 도구, 라이선스·attribution 스냅샷, checksum만 추적한다. “음악 제작에 무료”와 “샘플러 팩으로 재배포 가능”은 다른 권리다.

## 다음 비교 후보

현재 확보한 세 팩의 전수 연결과 설치는 끝났다. 비슷한 관현악 샘플을 무작정 더 모으기보다 실제 곡 A/B와 로딩 비용을 확인한다. 다음 음색 공백은 현대 대중음악의 기타·베이스·전자 건반·보컬·월드 타악 쪽이다.

| 후보 | 강점 | 판단 |
|---|---|---|
| [VCSL](https://versilian-studios.com/vcsl/) | CC0, 건반·월드·희귀 타악의 폭 | 전체가 아니라 실제 공백 단위로 비교 |
| [FreePats](https://freepats.zenvoid.org/) | 개별 SF2/SFZ와 출처·라이선스 관리 | 작은 보강 팩 후보; 자산별 조건 확인 |
| [University of Iowa MIS](https://theremin.music.uiowa.edu/MIS.html) | 관현악·기타·말렛의 dry/high-resolution 녹음 | 직접 SFZ 매핑 비용과 표준 SPDX 부재를 고려 |
| [Karoryfer 무료 샘플](https://shop.karoryfer.com/pages/free-samples) | 기타·베이스·드럼·실험 음색의 다층/RR SFZ | 현대 band 공백의 우선 A/B 후보; 팩별 라이선스 확인 |
| [AVL Drumkits](https://www.bandshed.net/avldrumkits/) | rock/jazz 계열 킷 다양성 | Salamander의 대체가 아니라 다른 캐릭터 후보 |
| [Virtuosity Drums](https://github.com/sfzinstruments/virtuosity_drums) | CC0, 다수 주법과 6 mic positions | sfizz는 이미 재생 가능하므로 용량·믹스 UX를 먼저 검증 |

상용 [BBC Symphony Orchestra Discover](https://www.spitfireaudio.com/en-us/products/bbc-symphony-orchestra-discover)나 [ProjectSAM Free Orchestra](https://projectsam.com/libraries/the-free-orchestra-2)는 음질·주법 UX 비교 대상으로는 유용하지만, 전용 플러그인과 재배포 제한 때문에 Aria 공식 샘플 팩으로 가져오지 않는다.

## 다음 검증 순서

1. VSCO 키스위치 8개, Salamander 하이햇 CC64 8단계, 긴 Recorded Clip의 시작·끝을 실제 곡 안에서 A/B한다.
2. GM / VSCO / Philharmonia / Salamander 변형을 같은 악기로 속이지 않고 출처·주법별 선택지로 유지한다.
3. 대형 SF2의 초기 메모리 피크와 동기식 sfizz 사이드카의 지연을 측정해 worker/process 격리 우선순위를 정한다.
4. true legato(실제 전이 레가토)가 필요하면 transition sample과 전용 매핑이 확인되는 음원을 별도 비교한다. 단순 릴리스나 단일 프레이즈 클립을 true legato라고 부르지 않는다.
5. 그 뒤 현대 band·pop의 실제 공백을 Karoryfer/VCSL/FreePats/Iowa 후보와 비교한다.

## 근거 파일

- 엔진 계약: [`docs/ENGINE_BACKENDS.md`](./ENGINE_BACKENDS.md)
- SF2 어댑터: [`src/spessa-engine.js`](../src/spessa-engine.js), [`test/spessa-engine.js`](../test/spessa-engine.js)
- SFZ 어댑터: [`src/sfizz-engine.js`](../src/sfizz-engine.js), [`test/sfizz-engine.js`](../test/sfizz-engine.js), [`test/sfizz-sampler-renderer.js`](../test/sfizz-sampler-renderer.js)
- 공통 렌더 경로: [`src/sampler-renderer.js`](../src/sampler-renderer.js), [`test/sampler-renderer.js`](../test/sampler-renderer.js)
- Portable MIDI 계약: [`src/midi.js`](../src/midi.js), [`test/smoke.js`](../test/smoke.js)
- 팩 manifest: [`packs/vsco2-ce.json`](../packs/vsco2-ce.json), [`packs/philharmonia-all-sfz.json`](../packs/philharmonia-all-sfz.json), [`packs/salamander-drumkit-sfz.json`](../packs/salamander-drumkit-sfz.json)
- 팩 설치·검증: [`tools/install-pack.mjs`](../tools/install-pack.mjs), [`tools/install-prepared-pack.mjs`](../tools/install-prepared-pack.mjs), [`test/pack-installer.js`](../test/pack-installer.js), [`test/prepared-pack-installer.js`](../test/prepared-pack-installer.js)
- 전체 팩 변환: [`tools/prepare-vsco2-ce-sfz.mjs`](../tools/prepare-vsco2-ce-sfz.mjs), [`tools/prepare-philharmonia-sfz.mjs`](../tools/prepare-philharmonia-sfz.mjs), [`tools/prepare-salamander-sfz.mjs`](../tools/prepare-salamander-sfz.mjs)

모든 수치와 상태는 공식 archive/repository, 로컬 manifest, checksum catalog, 엔진 회귀 테스트를 우선 근거로 삼는다. 출처가 불명확한 재업로드나 “royalty free”라는 제3자 주장만으로 팩을 채택하지 않는다.

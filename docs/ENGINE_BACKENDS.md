# Aria 샘플 엔진 백엔드

- 결정일: 2026-08-09
- 원칙: Aria는 범용 샘플 재생 DSP를 새로 만들지 않는다. 검증된 오픈소스 엔진을 교체 가능한 어댑터 뒤에 두고, 곡 상태·AI 편집·연주법 선택·감각적인 믹싱 UI에 집중한다.

## 현재 구현 상태

- **PCM SoundFont(SF2/DLS):** `spessasynth_core@4.3.16` 어댑터가 Aria runtime에 연결되어 있다. 압축 sample을 담은 SF3는 현재 동기 경로에서 명시적으로 거부한다.
- **SFZ:** 고정 commit의 `sfizz_render`를 검증된 sidecar로 Aria의 재생·WAV·stem 경로에 연결했다. 관리형 pack의 manifest·entry checksum과 SFZ include/sample/key/velocity를 먼저 검사한 뒤 원본 stereo를 렌더한다.
- 두 경로 모두 등록한 음원이 없거나 손상됐을 때 다른 악기 또는 무음으로 성공 처리하지 않는다.

## 확정 구조

| 담당 | 백엔드 | 버전·라이선스 | 쓰는 이유 | 주의점 |
|---|---|---|---|---|
| 기존 SF2 | [SpessaSynth Core](https://github.com/spessasus/spessasynth_core) | `4.3.16` 고정, Apache-2.0, **runtime 활성** | Node ESM에서 dry stereo Float32 PCM을 직접 반환하고 SoundFont의 stereo link, filter, LFO, envelope, modulators와 MIDI controller를 해석한다 | 대형 SF2를 읽을 때 파일 크기의 약 2배 이상 순간 메모리를 쓸 수 있다. 폰트별로 순차 처리하고 실제 곡에 필요한 preset/key/velocity만 남긴다. 현재 압축 SF3는 지원하지 않는다 |
| 원본 WAV/FLAC/MP3+SFZ | [sfizz](https://github.com/sfztools/sfizz) | `f5c6e29f23b8057867c08e88f5f6ac6738baa30b` 고정, BSD-2-Clause, **runtime 활성** | round-robin, keyswitch/CC 주법, `trigger=first/legato`, `group/off_by` 초크, velocity/CC crossfade, stereo와 disk streaming을 지원한다 | 저장소가 2026-06-21 archive됐다. exact pin·4줄 AppleClang 패치·29개 의존 라이선스 묶음을 보존한다. 현재 동기 child process이므로 긴 렌더를 worker로 격리하는 후속 최적화가 필요하다 |
| SF2 장기 대안 | [FluidSynth](https://github.com/FluidSynth/fluidsynth) | `2.5.7` 비교 기준, LGPL-2.1-or-later | 성숙한 SF2 구현, native 성능, dynamic sample loading | CLI에 MIDI만 넘기면 Aria의 note별 bend와 일부 표현 데이터가 빠진다. 채택하려면 direct C API sidecar가 필요하다 |
| SFZ 교체 후보 | [liquidsfz](https://github.com/swesterfeld/liquidsfz) | `0.4.1` 비교 기준, MPL-2.0 | 현재 유지보수 중이며 RR, keyswitch, choke, crossfade, stereo와 cache streaming을 지원한다 | 현재 sfizz보다 `trigger=first/legato`, note polyphony, 다중 output 지원이 좁다 |

SpessaSynth와 sfizz는 서로 대체 관계가 아니다. 전자는 SoundFont를, 후자는 VSCO·Salamander·Philharmonia 같은 원본 SFZ pack의 여러 테이크와 주법을 재생하는 활성 backend다.

## 목표 처리 흐름

```text
Aria 곡/트랙/노트
  → 타임라인 계획(노트 on/off, bend, 주법, CC)
  → 샘플 엔진 어댑터(SpessaSynth 또는 sfizz sidecar)
  → dry stereo PCM
  → Aria 트랙 gain·EQ·공간 send
  → Aria master·WAV·재생
```

엔진 어댑터는 악기를 고르거나 편곡하지 않는다. Aria가 지정한 `asset pack + instrument + articulation`을 정확히 열고 PCM만 돌려준다. SpessaSynth와 sfizz 경로가 같은 트랙·믹스·마스터 계약으로 연결돼 있다.

## 반드시 지키는 계약

1. 폰트·bank·program·악기·주법이 없으면 명시적으로 실패한다. 비슷한 악기로 자동 대체하지 않는다.
2. 원본 stereo, velocity layer, round-robin, release sample, keyswitch/CC, mic position을 manifest에서 숨기지 않는다.
3. 실제 transition sample이 없는 음원은 엔진이 진짜 레가토를 만들어낼 수 없다. 이때는 `레가토 근사 (Legato approximation) — 음 사이를 겹쳐 덜 끊기게`처럼 표시한다.
4. 공식 용어를 먼저 쓰고 설명을 붙인다. 예: `스타카토 (Staccato) — 짧고 또렷하게 끊어 연주`.
5. 엔진 자체 reverb와 Aria 공용 reverb를 동시에 몰래 적용하지 않는다. 두 어댑터 모두 Aria 후단 믹서가 처리할 dry stereo를 반환한다.
6. SoundFont 원래 velocity·pan 처리를 되살린 뒤 Aria의 예전 mono 보정을 이중 적용하지 않는다.
7. 엔진 이름·버전·asset pack·주법·근사 여부를 곡과 진단 결과에 남긴다.

## SpessaSynth 합격 기준

- Salamander piano의 좌·우 PCM이 서로 달라 원래 stereo가 보존된다.
- GeneralUser의 filter/LFO/modulators를 끄지 않고 재생한다.
- GM Standard, 808/909, Brush kit와 Philharmonia 내부 program을 정확히 고른다.
- 없는 preset 또는 해당 key/velocity sample은 무음이나 다른 악기가 아니라 오류가 된다.
- note별 bend는 노트 길이에 걸친 곡선으로 유지한다. 같은 pitch의 서로 다른 bend가 겹치면 별도 channel lane으로 분리한다.
- 마지막 note-off 뒤 SoundFont release가 끝날 때까지 렌더하되 안전 상한을 둔다.
- 동일 입력의 PCM은 반복 렌더에서 동일하고 NaN/Infinity가 없다.
- 1.2 GiB Salamander를 포함한 대표 곡에서 peak memory와 render time을 기록한다.

## SFZ 합격 기준

다음 항목은 `test/sfizz-engine.js`와 `test/sfizz-sampler-renderer.js`, pack 준비·설치 테스트가 지키는 회귀 계약이다.

- Salamander Drumkit의 모든 round-robin과 open/closed hi-hat choke가 작동한다.
- VSCO의 sustain/pizzicato/staccato/tremolo 등 수집된 주법을 별도 선택할 수 있다.
- `trigger=first/legato`가 있는 실제 transition patch와 단순 note overlap 근사를 UI에서 구분한다.
- stereo와 velocity/CC crossfade를 mono·hard switch로 축소하지 않는다.
- 지원하지 않는 opcode가 있으면 설치 검사에서 파일명과 opcode를 명시하고 실패한다.
- sidecar가 실패해도 Aria 곡 데이터는 유지되고 오류 코드·음원 경로를 명시한다.

## 로컬 1회 관찰값

2026-08-09 개발 Mac에서 SpessaSynth Core 임시 PoC를 한 차례 실행해 관찰한 값이다. 측정 harness·기기 세부 정보·반복 횟수를 아직 저장하지 않았으므로 성능 보장이나 재현 가능한 회귀 기준으로 사용하지 않는다.

| 시험 | 결과 |
|---|---:|
| GeneralUser 약 31 MiB, 바이올린 1초 | 로드+렌더 약 78 ms |
| GeneralUser, 64 지속 voice, 30초 | 약 1.132초(약 26.5배 실시간) |
| Salamander 1.18 GiB, C4 1초 | 로드+렌더 약 580 ms |
| Salamander stereo | L/R difference RMS 약 0.0295 |
| Salamander parse 순간 ArrayBuffer | 약 2.36 GiB |
| C4/velocity 100에 필요한 zone만 trim | 960 samples → 2 samples, 약 4.5 MiB |

이 1회 관찰만으로 일반 성능을 보장할 수는 없다. 다만 현재 64 GiB 개발 환경에서도 모든 폰트를 한꺼번에 메모리에 보관하지 않는다는 설계 원칙은 유지한다.

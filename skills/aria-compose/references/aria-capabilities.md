# Aria 현재 기능과 안전한 사용법

이 문서는 일반 작곡 지식이 아니라 현재 Aria 구현의 동작을 정리한다. 실제 실행 결과와 현재 소스·테스트에서 검증한 동작이 우선하며, 도구 설명이 둘과 충돌하면 설명을 사실로 가정하지 말고 수정 대상으로 남긴다. Aria가 업데이트되면 `scripts/audit-skill.mjs`로 도구 목록이 어긋났는지 확인한다.

<!-- aria-tools: new_song,get_song,set_song,list_presets,add_track,remove_track,set_track,set_tempo,clear_tempo,humanize,swing,quantize,set_section,remove_section,check_key,add_notes,clear_notes,delete_note,move_note,resize_note,split_note,insert_bars,set_bend,set_velocity,copy_bars,delete_bars,move_notes,delete_notes,set_region_gain,undo_edit,redo_edit,edit_history,play,stop,export,import_midi,ab_save,ab_load,save_song,load_song,list_songs,list_feedback,resolve_feedback,add_feedback -->

## 상태 모델

- **[사실]** Aria 앱이 현재 곡의 단일 상태를 보유한다. MCP 편집과 GUI 편집은 같은 상태를 거쳐야 한다. [S69][S70]
- `get_song`으로 제목, 템포, 박자표, 구간, 트랙, 노트, 재생 상태, GUI 주소를 확인한다.
- `new_song`과 `set_song`은 전체 곡을 바꾸므로 가장 위험하다. 기존 작업을 `save_song` 또는 `ab_save`로 보존한다.
- 모든 편집은 최대 30단계의 undo/redo 이력에 들어간다. 큰 변경 전후에 `edit_history`를 본다.
- `list_feedback`는 GUI에서 남긴 열린 메모를 돌려준다. 실제로 반영한 뒤에만 `resolve_feedback`을 부른다.

## 프리셋과 트랙

- 새 곡을 만들거나 악기를 추가·교체·선택할 때 `list_presets`를 호출한다. 인자 없이 부르면 거대한 전체 목록 대신 출처·악기군 요약이 돌아오므로, 곡의 필요를 정한 뒤 `query`, `family`, `source`와 보통 `available_only:true`로 실제 ID·주법·드럼 피스를 검색한다. Aria는 자체 파형 합성 프리셋 없이 외부 SF2/SFZ 샘플만 재생한다.
- GeneralUser, VSCO, Philharmonia, Salamander처럼 이름이 비슷한 악기의 서로 다른 출처·주법은 별도 음색 선택지다. 자동 대체하지 않으며 어느 쪽이 더 좋은지는 곡 안에서 같은 구간을 A/B해 정한다. 필요한 팩·파일·bank/program·key/velocity sample이 없거나 손상됐으면 오류를 표시한다.
- 템플릿은 현재 구현자가 정한 **하나의 선택적 스케치**로 편성과 BPM만 준비한다. 이름이 요청 장르와 같다는 이유만으로 선택하지 말고 exact palette를 먼저 확인한다. 학술적 장르 정의가 아니며, 넓거나 혼합된 장르는 blank song이 더 안전하다. 곡의 필요에 따라 프리셋·트랙·템포를 자유롭게 바꾼다.
- 현재 SF2 백엔드는 `spessasynth_core@4.3.16`이다. 비압축 PCM SF2/DLS의 스테레오 링크, 필터, LFO(저주파 진동기), 엔벌로프, 모듈레이터, bank/program과 벨로시티 레이어를 원래 SoundFont 규칙으로 해석한다. SF3는 지원하지 않는다. [S69][S70]
- SFZ 백엔드는 commit이 고정된 sfizz 로컬 사이드카다. 샘플 매핑, key/velocity 범위, 라운드로빈(Round robin, 같은 음의 반복 샘플 순환), 기본 pitch bend, keyswitch/CC와 드럼 초크를 앱의 재생·WAV·스템 경로에서 처리한다. 현재 동기식 호출이므로 별도 worker/process 격리는 남은 성능 최적화다. [S69][S70]
- 현재 검증된 로컬 상태에서 세 managed SFZ 팩은 모두 설치됐다. VSCO 2 CE는 카탈로그 462개(공식 정의 75개 보존 + 보강·중복 alias 회계, WAV 3,168/3,168), Philharmonia는 1,565개(음정 악기 184 + 무음정 one-shot 74 + Recorded Clip 1,307), Salamander Drumkit v4는 10개(킷·모듈 9 + 미편집 원본 클립 1, WAV 536/536)다. Philharmonia 공식 archive의 정상 원본 13,681개는 모두 재생 가능하고, 원본부터 0 byte인 파일 2개는 결함으로 명시된다. [S69][S70]
- 로컬 SF2 선택지까지 합친 현재 레지스트리는 2,114/2,114개 사용 가능이다: instrument 333, percussion 90, 사용자·MCP에 공개된 clip 1,691. percussion과 clip을 합치면 1,781개다. 설치 상태는 이후 달라질 수 있으므로 이 수치를 프리셋 ID 목록으로 외우지 말고 항상 `list_presets` 결과를 우선한다. [S69][S70]
- VSCO 키스위치 프리셋 8개는 `list_presets`에 실제 `articulation` ID와 쉬운 설명을 함께 노출한다. `add_track` 또는 `set_track`에 정확한 ID를 주면 sfizz가 해당 키스위치를 전송하므로 화면용 이름만 바뀌는 것이 아니다. 번역된 label을 ID 대신 보내지 않는다.
- Salamander의 권장 전체 킷은 `salamander-all-full`이다. MIDI key 42에는 `hi-hat-closed`와 `hi-hat-semi-open-1`부터 `hi-hat-semi-open-7`까지가 함께 매핑되며, 피스 ID를 고르면 필요한 CC64 값이 자동으로 붙는다. 숫자 key 42나 임의 CC를 직접 쓰지 말고 `list_presets`가 돌려준 피스 ID를 note의 `pitch`로 사용한다.
- `set_track`은 이름, 프리셋, 음량, 팬(Pan, 원본 스테레오의 좌우 균형), mute/solo와 아래 음색 파라미터를 바꾼다.
  - `velRange`: 벨로시티 범위(Velocity range, 악보의 강약 전달 폭). `0`이면 모든 노트를 MIDI velocity 64로 보내고, `1`이면 악보 값을 그대로 샘플 엔진에 보낸다. 후단 음량 배율이 아니라 엔진 입력을 다시 매핑하므로 원본 프리셋의 강약 레이어와 음색 반응이 함께 달라진다.
  - `reverb`: 리버브(Reverb, 공간에서 되돌아오는 잔향)의 트랙별 센드.
  - `eqLow`, `eqMid`, `eqHigh`: 저역·중역·고역을 각각 보정하는 제한된 3밴드 EQ.
- `null`은 `velRange`, `reverb`, 3밴드 EQ 덮어쓰기를 프리셋 기본값에 되돌린다.
- 어택(Attack, 소리가 시작되는 성질), 릴리스(Release, 음을 놓은 뒤 남는 여운), 비브라토(Vibrato, 음높이의 주기적인 떨림), 앙상블(Ensemble, 여러 연주자가 함께 내는 편성)은 트랙 조절값이 아니다. 필요한 성질·주법이 실제로 녹음되거나 프로그램된 샘플 프리셋을 골라야 한다. 단순 효과로 근사하거나 존재하지 않는 조절값을 호출하지 않는다.
- Recorded Clip(녹음 클립)은 phrase·glissando·effect·rhythm 같은 원형 녹음을 한 번 재생하는 항목이다. 음계 악기처럼 사용하지 않는다. 레가토(Legato, 음 사이를 이어 연주하는 주법)는 release를 늘려 만들 수 없고, true legato(실제 전이 레가토)는 음 사이의 전이 녹음과 전용 매핑이 있어야 한다.
- 트랙 volume과 note velocity는 다른 축이다. volume은 파트 밸런스, velocity는 음·프레이즈의 강세와 음색 반응에 우선 사용한다.
- UI·MCP 응답에서 전문 음악·오디오 용어를 먼저 쓰고 바로 쉬운 한국어 감각 설명을 붙인다. 음악을 제작하지 않는 사람을 낮춰 부르지 말고 `비음악인`이라고 표현한다.

## 좌표와 노트

- `bar`는 1부터, 마디 안 `beat`는 0부터 센다.
- `beat`와 `dur`의 단위는 4분음표다. 16분=`0.25`, 8분=`0.5`, 4분=`1`, 온음=`4`.
- 화음은 같은 `bar`와 `beat`에 여러 pitch를 둔다.
- 드럼 pitch는 현재 킷이 제공하는 피스 이름을 쓴다.
- `add_notes`는 덮어쓰지 않고 추가한다. 교체할 때 `clear_notes`의 범위를 좁혀 기존 자료를 보존한다.
- 하나를 고칠 때는 `delete_note`, `move_note`, `resize_note`, `split_note`; 묶음을 고칠 때는 `move_notes`, `delete_notes`, `set_velocity`, `set_bend`를 쓴다.
- `set_bend`와 note의 `bend`는 지속 시간 동안 목표 반음 수로 미끄러진다. 드럼에는 적용할 수 없다.
- `check_key`는 확신이 있을 때만 조성 밖 음을 표시하며 반복되는 바깥음은 의도로 취급하려고 한다. 그래도 미학적 판정기가 아니다.

## 시간, 구조, 반복

- `set_tempo`의 `ramp:true`는 **직전 템포 변화점부터** 목표 마디까지 선형 변화한다. 끝부분만 ritardando하려면 같은 BPM의 앵커를 먼저 둔 뒤 목표 BPM 램프를 둔다.
- `set_section`은 소리를 바꾸지 않는 이름표다. 사람과 AI가 같은 구간을 가리키고 구조 편집을 추적하게 해 준다.
- `insert_bars`, `delete_bars`, `copy_bars`는 모든 트랙의 시간축과 관련 구간 데이터를 함께 이동한다.
- `copy_bars` 기본 `insert`는 뒤를 밀고 넣는다. 기존 길이를 유지해야 하면 `overwrite`와 대상 트랙을 명시한다.

## 타이밍과 그루브

- `humanize`는 트랙·마디 범위의 각 음에 독립적인 난수 timing/velocity 편차를 기록한다. 재생 효과가 아니며 같은 구간에 다시 부르면 누적된다. 같은 입력 상태·범위·seed에서만 결과가 재현된다.
- 한 드럼 트랙에 kick/snare/hat가 섞여 있으면 `humanize`로 pulse를 고정한 채 hat만 고를 수 없다. 그런 경우 note 목록을 받는 `set_velocity`와 `move_note`/`move_notes`를 사용하거나 `humanize`를 생략한다.
- `swing`은 기존 결과를 기준 격자에서 다시 계산하므로 amount를 바꿔도 계속 밀려나지 않는다.
- `quantize`의 strength를 낮추면 일부 어긋남을 남길 수 있다.
- 무작위 편차는 사람다움의 필요조건이 아니다. 먼저 정렬된 버전을 만들고 장르·파트 관계에 근거가 있을 때만 타이밍을 바꾼다. [S20][S23][S24][S25]

## 강약과 구간 믹스

- `set_velocity`는 절대값, 증감, 배율, 시작→끝 점층을 지원한다.
- `set_region_gain`은 특정 트랙의 특정 마디 구간을 dB로 바꾸고 `to_db`로 램프를 만든다. 겹친 구간은 곱으로 누적되므로 이력을 확인한다.
- `to_db` 램프는 지정 구간 뒤에도 끝값이 계속 적용된다. 뒤 구간을 원래 gain으로 돌리려면 다음 변화점을 명시적으로 설계하고 최종 `get_song`으로 남은 automation을 확인한다.
- 크레셴도는 velocity, 구간 gain, 트랙 추가, 음역 상승, 음가 밀도, 음색 밝기, 템포 중 하나 이상으로 만들 수 있다. `velRange`는 악보 velocity를 MIDI 64와 원래 값 사이에서 샘플 엔진에 전달하는 정도를 정하는 선택지이지 유일한 정답이 아니다.

## 재생과 진단

- `play`는 전곡 또는 구간을 재생하고 peak, RMS, LUFS, 클리핑, 리미터 작동 정보를 돌려준다.
- 현재 MCP의 `play`는 사용자 스피커 재생과 텍스트 진단을 시작할 뿐 모델에 오디오 파일을 반환하지 않는다. 모델이 실제 오디오를 받지 못하는 환경에서는 음악적 A/B 선택을 사용자에게 묻고, 숫자만으로 groove나 감정의 성공을 선언하지 않는다.
- **[사실]** 현재 렌더 경로에는 기본 마스터 리미터가 있고 기본 ceiling은 -0.3 dBFS다. 이전 초안에서 리미터가 없다고 한 설명은 폐기한다. [S69]
- Aria의 LUFS는 BS.1770-4 계열 K-weighting/gating을 구현한 내부 진단값이지만 공식 적합성 시험을 거친 납품 미터라고 가정하지 않는다. 리미터 ceiling과 peak 보고도 sample peak 기준이며 dBTP true-peak 보증이 아니다. 방송·플랫폼 납품 적합성은 검증된 외부 미터로 따로 확인한다. [S51][S69]
- 리미터가 있다는 이유로 과도한 입력을 방치하지 않는다. 지속적이거나 큰 gain reduction은 편곡·트랙 밸런스를 먼저 손볼 신호다.
- LUFS는 비교와 진단에 사용한다. 방송/배포 표준의 목표값을 모든 곡에 강제하지 않는다. [S51][S52][S53]
- 렌더는 한 번에 최대 600초다. 긴 재생·WAV 내보내기는 `from_bar`/`to_bar`로 나눈다.

## A/B, 저장, 내보내기

- 주관적인 결정을 하기 전 현재 곡을 A에 저장하고 수정본을 B에 저장한다. 같은 구간과 같은 시작점을 번갈아 듣는다.
- A/B는 전역 두 슬롯이며 기존 슬롯을 덮어쓴다. 질문·범위·가설 metadata는 저장하지 않는다. 원본 보존이 중요하면 먼저 `list_songs`로 충돌을 피한 고유 이름에 저장한다.
- MCP에서는 `ab_load`가 재생을 멈춘다. A load → 같은 범위 play 완료 → B load → 같은 범위 play 완료 순서로 비교하고, 승자 슬롯을 다시 불러온 뒤 최종 저장한다. GUI의 즉시 믹스만 재생 위치를 이어 갈 수 있다.
- `save_song`은 Aria 라이브러리에 보관한다. 이름이 같으면 덮어쓰므로 의미 있는 버전 이름을 쓴다.
- `export`의 MIDI는 전곡이고 WAV는 구간을 지정할 수 있다.
- **[사실]** 현재 Aria exporter는 한 melodic track에 한 MIDI channel을 배정하므로 melodic track을 최대 15개까지 쓴다. 이는 SMF 전체의 보편 track 한계가 아니라 현재 구현 한계다. 드럼은 전용 channel을 쓴다. [S54][S55][S69]
- 실제 노트가 있는 트랙에 `articulation`이 명시돼 있으면 portable MIDI 내보내기는 실패한다. 표준 MIDI의 GM 근사로는 녹음된 주법·키스위치를 안전하게 보존할 수 없으므로 조용히 버리지 않는다. 현재 음색이 중요하면 WAV를 내보내고, GM 근사가 목적이면 사용자 의도를 확인한 뒤 `set_track({track:"트랙 이름", articulation:null})`로 기본 주법에 되돌린 다음 MIDI를 내보낸다. `articulation`이 생략됐거나 `null`인 implicit default는 기존 MIDI 근사를 허용한다. [S69][S70]
- 드럼 피스에 선언된 MIDI CC는 별도 계약이다. Salamander의 같은 key 하이햇처럼 피스 ID가 CC64를 요구하면 exporter가 CC를 note-on보다 먼저 기록하므로 보존된다. 이를 트랙 아티큘레이션 차단과 혼동하지 않는다. [S69][S70]

| Aria → MIDI | 현재 동작 |
|---|---|
| 보존 | note pitch/onset/duration/velocity, track name, tempo, time signature, 기본 track volume/pan, 드럼 피스에 선언된 MIDI CC |
| 근사 | Aria preset → GM program, drum piece → GM note, 연속 tempo ramp → 계단식 tempo events |
| 엄격히 거부 | 실제 노트가 있는 트랙의 명시적 `articulation`; WAV로 보존하거나 `articulation:null`로 기본 주법에 되돌린 뒤 MIDI export |
| 손실 | note bend, region gain/ramp, reverb/EQ/velRange, section/feedback, mute/solo, A/B metadata, 선택한 SF2/SFZ 프리셋의 정확한 매핑·스테레오·엔벌로프·필터/LFO/모듈레이터, 렌더 음색·공간·limiter·master sound |

`humanize`로 실제 바뀐 note onset/velocity는 MIDI에 남지만 seed, 원래 grid, “humanize 의도”는 남지 않는다. 따라서 편집 가능성은 Aria 곡 저장으로, 최종 소리는 WAV로 함께 보존한다. [S54][S55][S69]

`import_midi`는 현재 곡을 교체하지만 undo할 수 있다. Note, tempo, time signature, track/channel, 첫 program, 첫 channel volume/pan을 중심으로 가져오며 GM program과 drum note를 외부 샘플 preset/piece로 추정한다. Pitch bend, sustain/pedal, aftertouch, 대부분의 controller automation, lyric/marker 등은 현재 Aria 표현으로 왕복 보존되지 않으므로 원본 MIDI를 유지하고 가져온 뒤 표현과 음색을 다시 확인한다. [S54][S55][S69]

## 작업별 도구 묶음

| 목적 | 우선 도구 |
|---|---|
| 새 곡의 안전한 시작 | `get_song` → `list_feedback` → 의미 있는 현재 작업만 고유 이름으로 `save_song`/`ab_save` → `list_presets` → `new_song` |
| 짧은 작곡 루프 | `add_notes` → `play` → 국소 편집 → `play` |
| 구조 확장 | `set_section`, `copy_bars`, `insert_bars`, `delete_bars` |
| 박자감 교정 | `quantize`, `swing`, `move_notes`, 선택적 `humanize` |
| 프레이즈 표현 | `set_velocity`, `set_bend`, `resize_note`, 실제 주법·음색이 든 프리셋 선택 |
| 구간 밸런스 | mute/solo, `set_region_gain`, track volume, EQ |
| 주관적 대안 | `ab_save`, `ab_load`, 같은 범위 `play` |
| 사용자 피드백 | `list_feedback` → 수정·청취 → `resolve_feedback` |
| 복구 | `edit_history`, `undo_edit`, `redo_edit` |

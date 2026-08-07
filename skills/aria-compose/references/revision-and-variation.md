# 수정, 대안, 반복 작업

수정은 “더 좋게”라는 추상 목표를 직접 수행하지 않는다. 듣는 사람이 지적한 현상을 작고 검증 가능한 원인 후보로 바꾼다.

## 사용자의 말을 편집 축으로 번역한다

| 사용자 표현 | 먼저 확인할 축 | 바로 하지 말 것 |
|---|---|---|
| 후렴이 약하다 | focal register, bass/backbeat arrival, density 대비, lead-in | 모든 track volume 올리기 |
| 악기가 튄다 | 몇 음/한 구간/전곡인지, attack/brightness/velocity | master limiter로 덮기 |
| 답답하다 | low-mid overlap, sustained tail, root/doubling, reverb | EQ를 크게 깎기 |
| 밋밋하다 | anchor와 contrast 거리, phrase ending, section function | 새 track 계속 추가 |
| 기계적이다 | accent, phrase, note duration, articulation, interlock | random humanize 전체 적용 |
| 박자가 이상하다 | 기준 pulse, kick–bass, focal–support 관계 | 모든 트랙 quantize/humanize |
| 감정이 안 온다 | perceived/felt 목표, cue 조합, arc, focal phrasing | major/minor만 뒤집기 |
| 너무 복잡하다 | focal role, 동시 성부, subdivision, harmonic rate | 전곡 단순화 |
| 상용 느낌이 없다 | hierarchy, transitions, articulation, balance, ending | loudness만 키우기 |

## 국소화

1. 문제가 시작되기 1–2마디 전부터 끝 1–2마디 뒤까지 범위를 잡는다.
2. 전체 mix를 듣는다.
3. 의심 트랙을 mute/solo하기 전에 모든 트랙의 현재 flag를 기록하고, 진단 뒤 정확히 복구한다.
4. note, timing, dynamics, tone, arrangement 중 한 편집 층을 고른다.
5. 같은 범위를 다시 듣는다.

구간 문제가 아닌 전곡 문제일 때만 전체 트랙 parameter를 바꾼다.

## A/B 절차

1. 영구 원본 보존이 필요하면 `list_songs`로 충돌을 확인한 고유 이름에 먼저 `save_song`하고, 현재 곡을 A에 `ab_save`한다. A/B 슬롯은 전역이며 덮어쓴다.
2. 질문을 하나 쓴다: “B의 후렴 focal이 더 선명한가?”
3. 한 원인 계층만 수정한다.
4. B에 저장한다.
5. 비교 질문·시작점·범위를 별도로 기록한다. MCP에서는 A를 load→play 완료한 뒤 B를 load→같은 범위 play한다. `ab_load`는 현재 MCP 재생을 멈춘다.
6. 체감 음량 차이가 판단을 지배하지 않는지 확인한다.
7. 승자를 다시 불러와 남기거나 제3안을 만든다.

A/B는 많은 차이를 한꺼번에 넣는 showcase가 아니라 가설 검사다.

## variation menu

반복을 바꿔야 할 때 다음 중 하나만 먼저 선택한다.

- ending note/ending rhythm.
- octave/register.
- chord inversion/top note.
- bass pickup/approach.
- kick/hat omission 또는 fill.
- note duration/articulation.
- focal timbre/doubling.
- support track entry/exit.
- dynamics/region gain.
- one surprise chord or delayed arrival.

anchor motif의 rhythm·contour·timbre 중 최소 하나를 지켜 관계를 보존한다.

## history와 복구

- 큰 수정 전 `edit_history`를 본다.
- `undo_edit`은 여러 단계가 가능하지만 어떤 편집을 되돌리는지 확인한다.
- undo 뒤 새 편집을 하면 redo 이력이 사라진다.
- 구조 편집 후 sections, tempo map, region gain이 의도대로 이동했는지 `get_song`으로 확인한다.
- `set_region_gain`의 `to_db` 램프는 구간 뒤에도 끝값이 남으므로 다음 구간까지 확인한다.
- 기존 곡에 `set_song`을 쓸 때는 반드시 보존본을 만든다.

## feedback queue

1. `list_feedback`를 읽는다.
2. 여러 피드백이 같은 범위를 가리키면 원인 관계를 정리한다.
3. 가장 근본적이고 작은 수정부터 한다.
4. 관련 구간을 재생한다.
5. 반영된 항목만 `resolve_feedback`으로 닫는다.
6. 충돌하는 피드백은 임의로 한쪽을 완료 처리하지 말고 A/B 또는 사용자 선택을 남긴다.

## 수정의 종료 조건

- 사용자가 말한 현상이 같은 범위에서 줄었다.
- 새 문제가 더 크지 않다.
- focal·groove·arc 중 원래 좋았던 핵심은 유지됐다.
- A/B에서 선택 이유를 감각 언어로 설명할 수 있다.
- 진단에 쓴 mute/solo와 보존하기로 한 bars, tempo map, sections, tracks/presets, 범위 밖 notes가 원래대로다.
- 열린 feedback을 임의로 닫지 않았다.
- 곡을 저장했고, 필요할 때만 export했다.

완벽해질 때까지 무한 반복하지 않는다. 한 라운드에서 해결한 것과 남긴 선택을 사용자에게 짧게 보고한다.

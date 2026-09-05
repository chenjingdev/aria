// aria — MCP 서버(stdio): LLM이 곡을 만들고 듣는 도구 표면
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runOp } from "./core.js";
import { APP_VERSION } from "./version.js";

const noteSchema = z.object({
  bar: z.number().int().min(1).max(999).describe("마디 번호(1부터)"),
  beat: z.number().min(0).optional().describe("마디 안 위치, 4분음표 단위(0=마디 시작, 4/4에서 0~3.999)"),
  pitch: z.string().describe('음이름 "C4"·"F#3"·"Bb2" — 드럼 트랙이면 피스 이름 "kick"·"snare"·"hhc" 등'),
  dur: z.number().gt(0).max(64).describe("길이, 박 단위(0.25=16분음표, 1=4분음표, 4=온음표)"),
  vel: z.number().int().min(1).max(127).optional().describe("세기 1~127 (기본 96)"),
  bend: z.number().min(-12).max(12).optional().describe("휘어 오르내림 — 음이 울리는 동안 이 반음 수만큼 미끄러진다. 2면 반음 두 개 올라가고, -12면 한 옥타브 떨어진다(기타·색소폰의 '떨어지는' 마무리). 드럼에는 못 쓴다")
});

// 트랙이 프리셋 상수를 덮어쓰는 음색 파라미터 — add_track/set_track이 공유한다
const toneShape = {
  velRange: z.number().min(0).max(1).optional()
    .describe("벨로시티 범위(Velocity range) 0~1 — 0이면 모든 노트를 중간 세기로 보내고, 1이면 악보의 velocity를 그대로 SoundFont 엔진에 보낸다. 음량뿐 아니라 원본 음원의 강약 레이어와 음색도 달라질 수 있다"),
  reverb: z.number().min(0).max(1).optional()
    .describe("리버브(Reverb) 센드 양 0~1 — 원음을 가상의 공간 잔향으로 얼마나 보낼지 정한다"),
  eqLow: z.number().min(-12).max(12).optional()
    .describe("저역 EQ(Low EQ) dB, 200Hz 셸빙 — 답답하고 웅웅거리면 내리고, 얇으면 올린다"),
  eqMid: z.number().min(-12).max(12).optional()
    .describe("중역 EQ(Mid EQ) dB, 1kHz 피킹 — 박스톤·비음을 깎거나 존재감을 앞으로 낸다"),
  eqHigh: z.number().min(-12).max(12).optional()
    .describe("고역 EQ(High EQ) dB, 4kHz 셸빙 — 쨍하면 내리고, 답답하거나 공기감이 필요하면 올린다")
};

// [이름, 설명, 입력 스키마 shape]
const TOOLS = [
  ["new_song", "새 곡을 만든다. template은 편성·bpm 출발점만 준비한다(장르의 정의나 완성곡이 아니다). 노트가 있는 현재 곡은 자동으로 라이브러리에 보존된 뒤 교체된다.", {
    title: z.string().max(120).optional().describe("곡 제목"),
    bpm: z.number().min(20).max(300).optional().describe("템포(템플릿 기본값을 덮어씀)"),
    template: z.string().optional().describe("템플릿 id: citypop, lofi, ballad, bossa, edm, chiptune"),
    time_sig: z.tuple([z.number().int().min(1).max(16), z.number().int()]).optional()
      .describe("박자표 [박자수, 박자단위] — 기본 [4,4]. 변박 지원: [3,4] [6,8] [5,4] [7,8] [13,16]. 단위는 2·4·8·16만")
  }],
  ["get_song", "현재 곡의 요약·재생 상태·미처리 피드백 수·GUI 주소와 곡 전체 JSON을 돌려준다.", {}],
  ["set_song", "곡 전체를 JSON으로 통째로 교체한다. 대규모 수정(조옮김, 구조 재배치)은 get_song으로 받아 고친 뒤 이걸로 되돌려 넣는 게 빠르다.", {
    song_json: z.string().describe("곡 전체 JSON 문자열 — get_song이 돌려주는 형식과 동일")
  }],
  ["list_presets", "외부 샘플 악기·주법·타악·녹음 클립을 계층으로 찾는다. 인자 없이 호출하면 그룹→악기 트리 요약(ID 없음)을, instruments를 주면 악기별 독주/섹션 × 주법 × 출처 → 실제 프리셋 ID 표(★가 기본값)를, group을 주면 한 그룹의 악기·주법 이름을 돌려준다. query·family·source·kind는 기존 검색이며 녹음 클립은 kind:'clip'을 줄 때만 나온다. add_track/set_track의 preset에는 실제 ID 대신 계층 ID(예: violin/section/sustain)를 바로 줄 수 있다.", {
    instruments: z.array(z.string().min(1)).min(1).max(12).optional()
      .describe('악기 이름 1~12개 — 예: ["Violin","Flute","Timpani"]. 한국어·복수형·별칭(horn, sax, 콘트라베이스)도 받는다. 각 악기의 독주/섹션 × 주법 × 출처 → 실제 ID 표와 계층 ID를 돌려준다'),
    group: z.string().optional().describe("그룹 이름 — 요약에 나온 것 그대로(예: 현악, 목관, 드럼 세트·타악 킷). 그 그룹의 악기와 주법 이름만"),
    query: z.string().optional().describe("이름·ID·설명·주법에서 찾을 말. 예: violin, 레가토, timpani"),
    family: z.string().optional().describe("정확한 악기군 필터. 예: Violin, Cello. 타악 전체는 family가 아니라 kind:'percussion'을 사용"),
    source: z.string().optional().describe("음원 출처 필터. 예: VSCO 2 CE, Philharmonia, GM"),
    kind: z.enum(["instrument", "percussion", "clip"]).optional()
      .describe("종류 필터: 선율 악기 instrument, 드럼·타악 percussion, 원래 연주 전체를 재생하는 녹음 클립 clip"),
    available_only: z.boolean().optional().describe("true면 현재 설치되어 실제 재생 가능한 항목만"),
    limit: z.number().int().min(1).max(100).optional()
      .describe("상세 결과 최대 개수. 기본 30, 최대 100. 결과가 많으면 query/family/source/kind를 먼저 좁힌다")
  }],
  ["add_track", "트랙을 추가한다.", {
    name: z.string().describe("트랙 이름(고유)"),
    preset: z.string().describe("실제 프리셋 ID 또는 계층 ID(악기/독주|섹션/주법 — 예: violin/section/sustain, flute, cello/pizzicato, drum kit). 계층 ID는 설치된 대표 음원으로 해석되어 실제 ID가 저장된다. 표는 list_presets({instruments:[…]})"),
    volume: z.number().min(0).max(2).optional().describe("볼륨 0~2 (기본 0.8). 1.0이 원래 크기(0dB), 2.0이 약 +6dB. 음량에 선형으로 작용하는 축이다"),
    pan: z.number().min(-1).max(1).optional().describe("팬 -1(왼쪽)~1(오른쪽)"),
    articulation: z.string().optional().describe("아티큘레이션(Articulation, 연주법) ID — 이 프리셋에 list_presets가 표시한 정확한 ID. 생략하면 음원의 기본 연주법"),
    ...toneShape
  }],
  ["remove_track", "트랙을 삭제한다.", { track: z.string().describe("트랙 이름") }],
  ["set_track", "트랙의 프리셋·볼륨·팬·이름과 음색 파라미터를 바꾼다. 음색 항목에 null을 주면 프리셋 기본값으로 되돌린다.", {
    track: z.string().describe("대상 트랙 이름"),
    preset: z.string().optional().describe("실제 프리셋 ID 또는 계층 ID(예: cello/section/pizzicato). 계층 ID는 설치된 대표 음원으로 해석되어 실제 ID가 저장된다"),
    volume: z.number().min(0).max(2).optional(),
    pan: z.number().min(-1).max(1).optional(), new_name: z.string().optional(),
    articulation: z.string().nullable().optional().describe("아티큘레이션(Articulation, 연주법) ID. null이면 프리셋 기본 연주법으로 되돌림"),
    mute: z.boolean().optional().describe("true면 재생·WAV 완성본에서 이 트랙을 제외(노트는 유지). 현재 MIDI 내보내기는 mute/solo와 무관하게 모든 트랙을 기록한다"),
    solo: z.boolean().optional().describe("true면 이 트랙만 들린다. 솔로가 하나라도 켜져 있으면 켜진 트랙들만 재생되며 음소거보다 우선한다"),
    velRange: z.number().min(0).max(1).nullable().optional().describe(toneShape.velRange.description),
    reverb: z.number().min(0).max(1).nullable().optional().describe(toneShape.reverb.description),
    eqLow: z.number().min(-12).max(12).nullable().optional().describe(toneShape.eqLow.description),
    eqMid: z.number().min(-12).max(12).nullable().optional().describe(toneShape.eqMid.description),
    eqHigh: z.number().min(-12).max(12).nullable().optional().describe(toneShape.eqHigh.description)
  }],
  ["set_tempo", "템포를 바꾼다. from_bar 없이 부르면 곡의 기준 템포를 바꾸고, from_bar를 주면 그 마디부터 템포가 바뀐다. ramp:true면 직전 템포에서 그 마디까지 서서히 변한다(rit./accel.).", {
    bpm: z.number().min(20).max(300).describe("목표 템포"),
    from_bar: z.number().int().min(1).max(999).optional().describe("템포가 바뀔 마디. 생략하면 곡 기준 템포를 바꾼다"),
    ramp: z.boolean().optional().describe("true면 '직전 템포 변화점'부터 이 마디까지 선형으로 변화(리타르단도·아첼레란도). 앞에 변화점이 없으면 곡 처음부터 걸리므로, 마지막 4마디만 늘어지게 하려면 앵커를 먼저 두어라 — set_tempo({bpm:같은값, from_bar:13}) 후 set_tempo({bpm:58, from_bar:16, ramp:true})")
  }],
  ["clear_tempo", "템포 변화를 삭제한다. from_bar를 주면 그 마디 것만, 안 주면 전부. 기준 템포는 남는다.", {
    from_bar: z.number().int().min(1).max(999).optional().describe("삭제할 템포 변화의 마디")
  }],
  ["humanize", "선택한 트랙·구간의 각 음에 독립적인 난수 timing/velocity 편차를 기록한다. 재생 효과가 아니라 노트 데이터를 바꾸며, 다시 부르면 편차가 누적된다.", {
    track: z.string().describe("대상 트랙 이름"),
    from_bar: z.number().int().min(1).max(999).optional().describe("시작 마디(생략하면 트랙 전체)"),
    to_bar: z.number().int().min(1).max(999).optional().describe("끝 마디"),
    timing: z.number().min(0).max(0.25).optional().describe("타이밍을 흔들 최대 폭(박). 기본 0.02는 아주 살짝, 0.06이면 확실히 느슨하다. 0이면 타이밍은 안 건드린다"),
    velocity: z.number().int().min(0).max(40).optional().describe("세기를 흔들 최대 폭. 기본 8. 0이면 세기는 안 건드린다"),
    seed: z.number().int().optional().describe("결과를 고정하는 값. 같은 입력 상태·범위·seed에서 같은 편차가 나온다. 이미 바뀐 상태에 다시 부르면 편차가 누적된다")
  }],
  ["swing", "선택한 8분 또는 16분 subdivision의 뒷박을 체계적으로 늦춘다. 기존 swing 기준에서 다시 계산하므로 amount 변경이 누적되지는 않는다.", {
    track: z.string().describe("대상 트랙 이름"),
    amount: z.number().min(0).max(1).optional().describe("0=정박(스윙 없음), 0.5=적당한 셔플, 1=완전한 셋잇단 느낌. 기본 0.5"),
    unit: z.number().optional().describe("스윙을 걸 단위 — 0.5면 8분음표(재즈·스윙), 0.25면 16분음표(힙합·네오소울). 기본 0.5"),
    from_bar: z.number().int().min(1).max(999).optional(),
    to_bar: z.number().int().min(1).max(999).optional()
  }],
  ["quantize", "어긋난 노트를 격자에 맞춰 정리한다. strength로 얼마나 당길지 정할 수 있어, 사람 연주의 흔들림을 살리면서 심하게 어긋난 것만 잡을 수도 있다.", {
    track: z.string().describe("대상 트랙 이름"),
    grid: z.number().optional().describe("맞출 격자(박) — 1=4분음표, 0.5=8분음표, 0.25=16분음표(기본), 0.125=32분음표"),
    strength: z.number().min(0).max(1).optional().describe("1=격자에 완전히 맞춤(기본), 0.5=어긋난 거리의 절반만 이동. 부분 보정이 더 음악적인지는 원본과 비교해 판단"),
    from_bar: z.number().int().min(1).max(999).optional(),
    to_bar: z.number().int().min(1).max(999).optional()
  }],
  ["set_section", "곡의 한 마디에 구간 이름표를 붙인다(1절·후렴·간주 등). 소리에는 영향이 없고, 사람과 AI가 같은 말로 위치를 가리키기 위한 것이다. 같은 마디에 다시 부르면 이름이 바뀐다. 이름표는 마디 삽입·잘라내기·복제를 따라 함께 움직인다.", {
    bar: z.number().int().min(1).max(999).describe("이름표를 붙일 마디(그 구간이 시작하는 마디)"),
    label: z.string().min(1).max(24).describe('구간 이름 (예: "인트로", "1절", "후렴", "간주", "브릿지", "아웃트로")')
  }],
  ["remove_section", "구간 이름표를 지운다. bar를 주면 그 마디 것만, 안 주면 전부.", {
    bar: z.number().int().min(1).max(999).optional().describe("지울 이름표의 마디")
  }],
  ["check_key", "곡의 조성을 추정하고 조성에서 벗어난 음을 트랙별로 알려준다. 노트를 넣은 뒤 자기 점검용으로 부르면 실수로 섞인 음을 찾을 수 있다. 확신이 없으면 판정을 내놓지 않는다(근거 없는 지적이 더 해롭기 때문). 되풀이해서 나오는 조성 밖 음은 의도로 보고 표시하지 않는다.", {}],
  ["add_notes", "트랙에 노트를 추가한다. 코드는 구성음을 같은 bar/beat에 여러 노트로 넣는다. 기존 노트는 유지된다(교체하려면 먼저 clear_notes).", {
    track: z.string().describe("대상 트랙 이름"),
    notes: z.array(noteSchema).min(1).max(2000)
  }],
  ["clear_notes", "트랙의 노트를 삭제한다. 구간을 안 주면 전부 삭제. 삭제 직후 undo_edit으로 되돌릴 수 있다.", {
    track: z.string(), from_bar: z.number().int().min(1).optional(), to_bar: z.number().int().min(1).optional()
  }],
  ["delete_note", "노트 하나만 정확히 지운다(clear_notes는 구간 전체). bar+pitch로 찾고, 같은 마디에 같은 음이 여럿이면 beat로 특정한다. undo_edit으로 되돌릴 수 있다.", {
    track: z.string().describe("대상 트랙 이름"),
    bar: z.number().int().min(1).max(999).describe("노트가 있는 마디"),
    beat: z.number().min(0).optional().describe("마디 안 위치(4분음표 단위) — 같은 마디에 같은 음이 여럿일 때 특정용"),
    pitch: z.string().describe('음이름("E5") 또는 드럼 피스("kick")'),
    dur: z.number().gt(0).max(64).optional().describe("길이 — 같은 자리에 겹친 노트를 길이로 구분할 때")
  }],
  ["move_note", "노트 하나의 타이밍을 옮긴다 — 엇박 교정, 리듬 미세 조정. bar+pitch(+beat)로 찾아 to_bar/to_beat로 이동. undo_edit으로 되돌릴 수 있다.", {
    track: z.string().describe("대상 트랙 이름"),
    bar: z.number().int().min(1).max(999).describe("현재 마디"),
    beat: z.number().min(0).optional().describe("현재 beat — 같은 마디에 같은 음이 여럿일 때 특정용"),
    pitch: z.string().describe('음이름 또는 드럼 피스'),
    dur: z.number().gt(0).max(64).optional().describe("길이 — 같은 자리에 겹친 노트를 구분할 때"),
    to_bar: z.number().int().min(1).max(999).optional().describe("이동할 마디(생략 시 그대로)"),
    to_beat: z.number().min(0).optional().describe("이동할 beat(생략 시 그대로)")
  }],
  ["resize_note", "노트 하나의 길이(dur)를 바꾼다. bar+pitch(+beat)로 찾는다. undo_edit으로 되돌릴 수 있다.", {
    track: z.string().describe("대상 트랙 이름"),
    bar: z.number().int().min(1).max(999), beat: z.number().min(0).optional(),
    pitch: z.string().describe('음이름 또는 드럼 피스'),
    dur: z.number().gt(0).max(64).describe("새 길이, 박 단위(1=4분음표)"),
    from_dur: z.number().gt(0).max(64).optional().describe("현재 길이 — 같은 자리에 겹친 노트를 구분할 때")
  }],
  ["split_note", "노트 하나를 지정 위치에서 둘로 자른다(가위) — 긴 노트를 나눠 뒷부분만 지우거나 옮길 때. bar+pitch(+beat·dur)로 찾고 at_bar/at_beat에서 나눈다. undo_edit으로 되돌릴 수 있다.", {
    track: z.string().describe("대상 트랙 이름"),
    bar: z.number().int().min(1).max(999).describe("노트가 있는 마디"),
    beat: z.number().min(0).optional().describe("노트의 beat — 같은 마디에 같은 음이 여럿일 때 특정용"),
    pitch: z.string().describe('음이름 또는 드럼 피스'),
    dur: z.number().gt(0).max(64).optional().describe("길이 — 같은 자리에 겹친 노트를 구분할 때"),
    at_bar: z.number().int().min(1).max(999).describe("자를 위치의 마디"),
    at_beat: z.number().min(0).optional().describe("자를 위치의 beat(4분음표 단위, 기본 0) — 노트 시작과 끝 사이여야 한다")
  }],
  ["insert_bars", "빈 마디를 끼워 넣는다(DAW의 insert time) — at_bar 앞에 count개, 전 트랙의 노트·구간 게인·구간 주법·템포 변화가 함께 뒤로 밀린다. undo_edit으로 되돌릴 수 있다.", {
    at_bar: z.number().int().min(1).max(999).describe("이 마디 앞에 빈 마디가 들어간다"),
    count: z.number().int().min(1).max(64).optional().describe("넣을 마디 수 (기본 1)")
  }],
  ["set_bend", "노트를 휘게 한다 — 음이 울리는 동안 정해진 반음 수만큼 미끄러진다. 기타의 초킹, 색소폰·트럼펫의 떨어지는 마무리, 신스 리드의 슬라이드 같은 표현. 대상은 notes 목록·마디 구간·(둘 다 없으면) 트랙 전체. 드럼에는 못 쓴다.", {
    track: z.string().describe("대상 트랙 이름"),
    notes: z.array(z.object({ bar: z.number().int(), beat: z.number().optional(), pitch: z.string(), dur: z.number().optional() })).max(500).optional()
      .describe("바꿀 노트들을 콕 집을 때"),
    from_bar: z.number().int().min(1).max(999).optional(),
    to_bar: z.number().int().min(1).max(999).optional(),
    bend: z.number().min(-12).max(12).describe("휠 반음 수 — 2면 반음 두 개 올라가고, -12면 한 옥타브 떨어진다. 0이면 곧게 편다")
  }],
  ["set_velocity", "노트의 세기(벨로시티)를 바꾼다 — 다이내믹 조절의 기본 도구. 대상은 notes 목록·마디 구간·(둘 다 없으면) 트랙 전체. vel(절대값)·by(증감)·scale(배율) 중 하나를 주고, vel과 to_vel을 같이 주면 구간에 걸쳐 점점 커지거나 작아지는 점층이 된다(크레셴도/디미누엔도).", {
    track: z.string().describe("대상 트랙 이름"),
    notes: z.array(z.object({ bar: z.number().int(), beat: z.number().optional(), pitch: z.string(), dur: z.number().optional() })).max(500).optional().describe("특정 노트만 지정(최대 500개)"),
    from_bar: z.number().int().min(1).optional().describe("구간 시작 마디"),
    to_bar: z.number().int().min(1).optional().describe("구간 끝 마디"),
    vel: z.number().int().min(1).max(127).optional().describe("이 값으로 설정"),
    to_vel: z.number().int().min(1).max(127).optional().describe("vel과 함께 주면 vel→to_vel로 점층(크레셴도)"),
    by: z.number().int().min(-126).max(126).optional().describe("현재 값에서 증감"),
    scale: z.number().min(0.1).max(5).optional().describe("현재 값에 곱할 배율(0.5=절반, 1.5=1.5배)")
  }],
  ["copy_bars", "마디 구간을 다른 자리에 통째로 복제한다 — 1절을 2절 자리에, 후렴을 뒤에 한 번 더. mode=insert(기본)면 붙일 자리에 빈 마디를 밀어 넣고 끼우고, overwrite면 그 자리의 노트를 지우고 덮어쓴다. tracks로 일부 악기만 복제할 수 있다.", {
    from_bar: z.number().int().min(1).max(999).describe("복사할 구간의 시작 마디"),
    to_bar: z.number().int().min(1).max(999).optional().describe("복사할 구간의 끝 마디(생략하면 한 마디)"),
    at_bar: z.number().int().min(1).max(999).describe("복사본이 시작될 마디"),
    times: z.number().int().min(1).max(32).optional().describe("몇 번 이어 붙일지(기본 1)"),
    mode: z.enum(["insert", "overwrite"]).optional().describe("insert=뒤를 밀고 끼워 넣기(기본), overwrite=그 자리를 덮어쓰기"),
    tracks: z.array(z.string()).optional().describe("복제할 트랙 이름 목록(생략하면 전체 트랙)")
  }],
  ["delete_bars", "마디 구간을 전 트랙에서 통째로 들어내고 뒤를 당겨 붙인다(DAW의 delete time — 구간의 노트만 지우는 clear_notes와 다르다). 구간에 걸친 긴 노트는 그만큼 짧아진다. undo_edit으로 되돌릴 수 있다.", {
    from_bar: z.number().int().min(1).max(999).describe("잘라낼 구간 시작 마디"),
    to_bar: z.number().int().min(1).max(999).optional().describe("잘라낼 구간 끝 마디(포함, 기본 from_bar)")
  }],
  ["move_notes", "여러 노트를 한 번에 같은 박수만큼 옮긴다(그루브 전체 밀기, 후렴 반 박 당기기). 대상은 notes 목록 또는 from_bar~to_bar 구간. undo_edit 한 번으로 전체 복구.", {
    track: z.string().describe("대상 트랙 이름"),
    by_beats: z.number().min(-64).max(64).describe("이동량, 4분음표 단위 — -0.5면 반 박 앞으로, +1이면 한 박 뒤로"),
    notes: z.array(z.object({
      bar: z.number().int().min(1).max(999), beat: z.number().min(0).optional(), pitch: z.string(),
      dur: z.number().gt(0).max(64).optional()
    })).max(500).optional().describe("옮길 노트 목록(생략 시 from_bar/to_bar 구간 전체)"),
    from_bar: z.number().int().min(1).optional(), to_bar: z.number().int().min(1).optional()
  }],
  ["delete_notes", "여러 노트를 한 번에 지운다(목록 지정 — 마디 구간 전체는 clear_notes). undo_edit 한 번으로 전체 복구.", {
    track: z.string().describe("대상 트랙 이름"),
    notes: z.array(z.object({
      bar: z.number().int().min(1).max(999), beat: z.number().min(0).optional(), pitch: z.string(),
      dur: z.number().gt(0).max(64).optional()
    })).min(1).max(500).describe("지울 노트 목록 [{bar,beat,pitch}...]")
  }],
  ["set_region_gain", "특정 트랙의 특정 마디 구간만 음량을 dB로 조절한다. 같은 구간을 다시 부르면 값이 교체되고, db 0을 주면 정확히 그 구간의 게인만 제거된다(겹치기만 하는 항목은 안 건드림). 다른 구간과 겹치면 곱으로 누적.", {
    track: z.string().describe("대상 트랙 이름"),
    from_bar: z.number().int().min(1).max(999).describe("구간 시작 마디"),
    to_bar: z.number().int().min(1).max(999).optional().describe("구간 끝 마디(포함, 기본 from_bar)"),
    db: z.number().min(-60).max(12).describe("데시벨 — -6이면 약 절반 크기, +6이면 약 두 배, 0이면 제거. to_db와 같이 주면 이 값이 시작점이 된다"),
    to_db: z.number().min(-60).max(12).optional().describe("주면 구간에 걸쳐 db에서 이 값으로 서서히 변한다 — 페이드아웃은 {db:0, to_db:-60}, 페이드인은 {db:-60, to_db:0}. 노트 단위가 아니라 샘플 단위라 길게 끄는 화음 하나짜리 엔딩도 실제로 사그라든다. 구간 앞에는 db가, 구간 뒤에는 to_db가 계속 걸린다")
  }],
  ["set_region_articulation", "키스위치·CC 주법이 선언된 트랙의 특정 마디 구간에 실제 녹음 연주법을 설정한다. list_presets가 돌려준 정확한 articulation ID를 쓴다. 새 값은 겹친 기존 구간을 필요한 만큼 나눠 덮어쓰며, null이면 선택 구간의 override만 지워 트랙 전체 또는 프리셋 기본 주법으로 돌아간다. 주법은 각 노트가 시작되는 마디에서 결정되며 이미 울리는 긴 음의 중간 샘플을 바꾸지 않는다.", {
    track: z.string().describe("대상 트랙 이름 — articulation 목록이 있는 키스위치/CC 프리셋이어야 함"),
    from_bar: z.number().int().min(1).max(999).describe("구간 시작 마디"),
    to_bar: z.number().int().min(1).max(999).optional().describe("구간 끝 마디(포함, 기본 from_bar)"),
    articulation: z.string().min(1).nullable().describe("list_presets가 표시한 정확한 articulation ID. null이면 이 구간의 override를 제거")
  }],
  ["undo_edit", "편집을 되돌린다. 곡을 바꾸는 모든 연산(노트·트랙·템포·게인·마디·곡 교체까지)이 최대 30단계까지 쌓이며, steps로 여러 단계를 한 번에 되돌릴 수 있다. 되돌린 것은 redo_edit으로 다시 적용된다.", {
    steps: z.number().int().min(1).max(30).optional().describe("되돌릴 단계 수(기본 1)")
  }],
  ["redo_edit", "undo_edit으로 되돌린 편집을 다시 적용한다. 새 편집을 하면 다시하기 이력은 사라진다.", {
    steps: z.number().int().min(1).max(30).optional().describe("다시 적용할 단계 수(기본 1)")
  }],
  ["edit_history", "지금 되돌릴 수 있는 단계 수와 최근 편집 목록을 본다.", {}],
  ["play", "곡(또는 구간)을 즉시 소리로 재생한다. GUI가 없어도 스피커로 재생된다. loop=true면 stop할 때까지 반복. 반환값에 피크·RMS 레벨과 클리핑 경고가 함께 오므로 소리를 듣지 않고도 음량 문제를 알 수 있다.", {
    from_bar: z.number().int().min(1).optional().describe("시작 마디(기본 1)"),
    to_bar: z.number().int().min(1).optional().describe("끝 마디 포함(기본 곡 끝)"),
    loop: z.boolean().optional().describe("구간 반복 여부")
  }],
  ["stop", "재생을 멈춘다.", {}],
  ["export", "곡을 MIDI/WAV/MP3 파일로 내보낸다. path를 안 주면 ~/Music/aria/<제목> 에 저장. WAV·MP3는 한 번에 10분까지라 긴 곡은 from_bar/to_bar로 나눈다. MP3는 FFmpeg로 320kbps 인코딩한다. MIDI는 항상 곡 전체이며 현재 bend, region gain, 음색 덮어쓰기, mute/solo, 렌더 공간·마스터 처리를 보존하지 않는다.", {
    format: z.enum(["midi", "wav", "mp3", "both"]).optional().describe("기본 both(MIDI+WAV), mp3는 MP3만 저장"),
    path: z.string().optional().describe("확장자 없는 저장 경로 (예: ~/Desktop/mysong)"),
    from_bar: z.number().int().min(1).optional().describe("WAV·MP3로 뽑을 시작 마디(기본 1)"),
    to_bar: z.number().int().min(1).optional().describe("WAV·MP3로 뽑을 끝 마디 포함(기본 곡 끝)"),
    stems: z.boolean().optional().describe("true면 완성본 대신 악기별 WAV를 폴더에 하나씩 내보낸다(다른 DAW에서 다시 믹싱할 때). 스템에는 트랙 볼륨·음소거와 마스터 처리가 빠지고 팬·리버브·구간 게인은 담긴다. format은 무시된다")
  }],
  ["import_midi", "다른 도구에서 만든 표준 MIDI 파일(.mid)을 읽어 현재 곡으로 가져온다. 트랙 이름·템포 변화·박자표·드럼 채널을 살리고, 악기(program change)는 가장 가까운 aria 프리셋으로 추정한다. 기존 곡은 교체되지만 undo_edit으로 되돌아간다. 참고: 480PPQ 격자 위 음은 그대로 보존되지만 셋잇단은 왕복에서 길이가 1/1000박쯤 밀린다.", {
    path: z.string().describe("가져올 .mid 파일 경로 (예: ~/Downloads/song.mid)"),
    quantize: z.number().optional().describe("격자에 맞춰 정리할 단위(박) — 0.25면 16분음표. 생략하면 원본 타이밍 그대로"),
    title: z.string().max(120).optional().describe("곡 제목(생략하면 파일 이름)")
  }],
  ["ab_save", "지금 곡 전체를 전역 A안 또는 B안에 담아 둔다. 기존 슬롯은 덮어쓰므로 영구 원본 보존에는 고유 이름의 save_song을 함께 쓴다. 비교 질문과 재생 범위는 별도로 기록한다.", {
    slot: z.enum(["A", "B"]).describe("담을 칸")
  }],
  ["ab_load", "담아 둔 A안·B안을 불러온다. MCP로 불러오면 현재 재생이 멈추므로 load → 같은 범위 play를 각 안에 반복한다. GUI에서 ⚡ 즉시 믹스로 재생 중일 때만 듣던 자리에서 이어질 수 있다.", {
    slot: z.enum(["A", "B"]).describe("들을 칸")
  }],
  ["save_song", "현재 곡을 라이브러리에 보관한다(같은 이름이면 덮어씀). GUI의 곡 목록에도 나타난다.", {
    name: z.string().max(120).optional().describe("보관 이름(기본: 곡 제목)")
  }],
  ["load_song", "라이브러리의 곡을 불러와 현재 곡으로 연다. 지금 열려 있던 곡은 자동으로 라이브러리에 보존된다.", {
    name: z.string().describe("list_songs에 나온 곡 이름")
  }],
  ["list_songs", "라이브러리에 보관된 곡 목록(오래된 순)을 돌려준다.", {}],
  ["list_feedback", "사용자가 GUI 피아노롤에서 구간을 잡아 남긴 피드백 중 처리 안 된 것을 돌려준다. get_song 요약의 피드백 표시는 여기서 읽을 항목이 있다는 뜻이다.", {}],
  ["resolve_feedback", "피드백을 곡에 반영한 뒤 완료로 표시한다. 반영 없이 임의로 완료 처리하지 마라.", {
    id: z.number().int().min(1).describe("list_feedback에 나온 피드백 번호")
  }],
  ["add_feedback", "현재 곡의 구간에 메모를 남긴다(주 용도는 GUI지만, LLM이 나중에 손볼 지점을 스스로 메모할 때도 쓴다).", {
    from_bar: z.number().int().min(1).max(999).describe("구간 시작 마디"),
    to_bar: z.number().int().min(1).max(999).optional().describe("구간 끝 마디(포함, 기본 from_bar)"),
    track: z.string().optional().describe("특정 트랙에 대한 피드백이면 트랙 이름"),
    text: z.string().max(500).describe("피드백 내용")
  }]
];

const INSTRUCTIONS = `aria는 작곡 앱이다. 곡은 실행 중인 앱 안에 하나 살아 있고, 이 도구들은 그 곡을 읽고 편집하고 소리로 재생한다. 사람은 같은 곡을 브라우저 피아노롤에서 보고 듣고 직접 고칠 수 있다(GUI 주소는 get_song 결과에 포함).
이 문서는 도구와 데이터의 동작만 설명한다.

곡 데이터:
- 노트는 {bar, beat, pitch, dur, vel}. bar는 1부터, beat·dur는 4분음표 단위(4/4에서 beat 0~3.999, dur 0.25 = 16분음표), vel은 1~127.
- 화음은 같은 bar/beat에 노트를 여러 개 넣어 표현한다.
- 드럼 트랙의 pitch는 피스 이름이다: kick snare rim clap hhc hho tom-l tom-m tom-h crash ride shaker. 프리셋마다 실제 제공되는 피스는 list_presets가 알려준다.
- 박자표는 new_song의 time_sig로 정한다(예: [7,8], [5,4]).

프리셋·음원:
- 모든 프리셋은 외부 SF2/SFZ 샘플이다. list_presets는 프리셋별 설치 여부를 함께 돌려주며, 미설치 프리셋은 소리가 나지 않고 다른 악기로 자동 대체되지 않는다.
- 레가토·스타카토·피치카토 같은 주법은 그 주법이 녹음된 키스위치·CC 프리셋에서만 선택할 수 있다. 트랙 전체는 set_track의 articulation, 마디 구간은 set_region_articulation으로 설정하며, ID는 list_presets가 돌려준 값을 그대로 쓴다.
- list_presets는 인자 없이 그룹→악기 트리를, instruments를 주면 악기별 독주/섹션 × 주법 × 출처 → 실제 ID 표(★ 기본값)를 돌려준다. add_track/set_track의 preset에는 실제 ID 대신 계층 ID("violin/section/sustain", "flute", "cello/pizzicato")를 줄 수 있고, 서버가 설치된 대표 음원의 실제 ID로 바꿔 저장한다. 녹음 클립은 kind:"clip"을 줄 때만 검색된다.

트랙 파라미터:
- volume 0~2, 음량에 선형(1.0 = 0dB, 2.0 ≈ +6dB).
- velRange 0~1: 악보 velocity를 샘플의 강약 레이어·변조에 얼마나 반영할지. 0이면 모두 중간 세기, 1이면 악보 값 그대로.
- reverb 0~1, 트랙별.
- set_region_gain은 한 트랙의 마디 구간에만 dB 게인을 건다. 겹치는 구간은 곱으로 누적된다.

템포:
- set_tempo(bpm)은 기준 템포를, from_bar를 주면 그 마디부터의 템포를 바꾼다. ramp:true는 "직전 템포 변화점"에서 from_bar까지 서서히 변한다. 따라서 특정 구간만 램프하려면 그 시작 마디에 앵커를 먼저 둔다:
  set_tempo({bpm:92, from_bar:13}) → set_tempo({bpm:58, from_bar:16, ramp:true})  (13마디까지 92, 13→16마디에서 58로)

편집·되돌리기:
- add_notes는 기존 노트를 유지한 채 추가한다. clear_notes는 구간 삭제, set_song은 곡 전체 교체.
- insert_bars/delete_bars/copy_bars는 전 트랙의 노트·구간 게인·구간 주법·템포 변화·구간 이름표·피드백을 함께 밀거나 당긴다.
- 곡을 바꾸는 모든 연산은 undo_edit으로 최대 30단계 되돌릴 수 있다.

재생·출력:
- play(from_bar, to_bar, loop)는 사용자 스피커로 즉시 재생한다. 반환값에 peak·RMS·LUFS·클리핑 경고와 마스터 리미터(-0.3dBFS ceiling) 감쇄 보고가 들어 있다.
- export는 MIDI/WAV를 저장한다. WAV는 한 번에 10분까지.

곡 관리:
- new_song/load_song은 노트가 있는 현재 곡을 자동으로 라이브러리에 보존한 뒤 교체한다. save_song은 이름을 붙여 라이브러리에 보관한다. list_songs는 보관된 곡 목록을 돌려준다. ab_save/ab_load는 전역 A/B 슬롯이다.

피드백:
- 사용자가 GUI에서 구간을 드래그해 남긴 피드백은 list_feedback으로 읽고, 곡에 반영한 뒤 resolve_feedback으로 닫는다.`;

export const TOOL_NAMES = TOOLS.map(([name]) => name);
const TOOL_NAME_SET = new Set(TOOL_NAMES);
const mentions = (text, name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);

// 숨긴 도구는 안내문에서도 사라져야 한다 — 없는 도구를 가리키는 문장은 모델을 헛걸음시킨다.
// 규칙: "a/b/c"로 묶인 이름에서는 숨긴 것만 빼고, 그래도 숨긴 도구가 남는 문장(묶음이 통째로 빈 문장 포함)은 빼고,
// 문장이 다 빠진 항목과 항목이 다 빠진 절 제목도 뺀다. 숨긴 도구를 말하지 않는 줄은 글자 하나 바뀌지 않는다.
export function buildInstructions(hide = []) {
  const hidden = new Set(hide);
  if (!hidden.size) return INSTRUCTIONS;
  const touched = text => [...hidden].some(name => mentions(text, name));
  const lines = [];
  for (const line of INSTRUCTIONS.split("\n")) {
    if (!touched(line)) { lines.push(line); continue; }
    const [, prefix, body] = line.match(/^(\s*(?:-\s+)?)(.*)$/);
    const kept = body.split(/(?<=\.)\s+/).map(sentence => {
      let emptied = false;
      const pruned = sentence.replace(/[a-z_]+(?:\/[a-z_]+)+/g, group => {
        const names = group.split("/");
        if (!names.every(name => TOOL_NAME_SET.has(name))) return group;
        const left = names.filter(name => !hidden.has(name));
        if (!left.length) emptied = true;
        return left.join("/");
      });
      return emptied || touched(pruned) ? null : pruned;
    }).filter(Boolean);
    if (kept.length) lines.push(prefix + kept.join(" "));
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const isHeader = /^[^\s-].*:$/.test(lines[i]);
    if (isHeader && !(lines[i + 1] ?? "").startsWith("-")) {
      while (i + 1 < lines.length && lines[i + 1] === "") i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

// hide: 이 서버가 노출하지 않을 도구 이름. 목록·안내문에서 함께 빠지며 앱 쪽 능력은 그대로다.
export async function startMcp(execute = (name, args) => runOp(name, args, "mcp"), { hide = [] } = {}) {
  const unknown = hide.filter(name => !TOOL_NAME_SET.has(name));
  if (unknown.length) throw new Error(`숨길 수 없는 도구 이름: ${unknown.join(", ")}`);
  const hidden = new Set(hide);
  const server = new McpServer({ name: "aria", version: APP_VERSION }, { instructions: buildInstructions(hide) });
  for (const [name, description, shape] of TOOLS) {
    if (hidden.has(name)) continue;
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
      try {
        const result = await execute(name, args ?? {});
        const text = typeof result === "string" ? result : JSON.stringify(result);
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { content: [{ type: "text", text: `오류: ${e.message}` }], isError: true };
      }
    });
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}

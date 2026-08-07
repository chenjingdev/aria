// aria — MCP 서버(stdio): LLM이 곡을 만들고 듣는 도구 표면
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runOp } from "./core.js";

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
    .describe("velocity가 음량에 미치는 폭. 기본 0.65는 vel 1~127이 약 9dB라 악센트용이고, 1로 올리면 약 42dB가 되어 크레셴도를 velocity만으로 만들 수 있다"),
  attack: z.number().min(0).max(2).optional()
    .describe("음이 최대 음량에 닿기까지의 초. 프리셋 기본은 대개 0.002~0.4. 0.1 이상이면 부드럽게 부풀어 오른다"),
  release: z.number().min(0).max(8).optional()
    .describe("음을 뗀 뒤 남는 여운의 초. 프리셋 기본은 0.06~1.3. 아르페지오가 뚝뚝 끊기면 여기를 0.8~2로 올려 음끼리 겹치게 한다"),
  reverb: z.number().min(0).max(1).optional()
    .describe("리버브 센드 양 0~1. 프리셋 기본(0.03~0.5)을 덮어쓴다. 공간을 넓히려면 0.5~0.8"),
  ensemble: z.number().min(1).max(4).optional()
    .describe("합주 스태킹 1~4 — 독주 샘플(sf-바이올린 등)을 미세 디튠·지연으로 겹쳐 그 인원이 함께 켜는 것처럼. 오케스트라 파트를 두껍게 할 때. 합성 프리셋·드럼에는 효과 없음"),
  eqLow: z.number().min(-12).max(12).optional()
    .describe("저역 EQ dB (200Hz 셸빙) — 답답하고 웅웅거리면 내리고(-3~-6), 얇으면 올린다"),
  eqMid: z.number().min(-12).max(12).optional()
    .describe("중역 EQ dB (1kHz 피킹) — 박스톤·비음을 깎거나(-3) 존재감을 앞으로 낸다(+3)"),
  eqHigh: z.number().min(-12).max(12).optional()
    .describe("고역 EQ dB (4kHz 셸빙) — 쨍하면 내리고, 답답하거나 공기감이 필요하면 올린다"),
  vibrato: z.number().min(0).max(1).optional()
    .describe("지연되어 시작하는 비브라토 깊이 0~1. 지속 가능한 현·관·목소리 계열에서 작은 값부터 듣고 정하며, 피아노·타악기처럼 음높이를 지속 제어하지 않는 소리에는 보통 쓰지 않는다")
};

// [이름, 설명, 입력 스키마 shape]
const TOOLS = [
  ["new_song", "새 곡을 만든다. template은 현재 구현의 편성·bpm 출발점을 준비할 뿐 장르의 정의나 완성곡이 아니다(list_presets에서 확인). 현재 라이브 곡은 교체되므로 먼저 고유 이름으로 보존한다.", {
    title: z.string().max(120).optional().describe("곡 제목"),
    bpm: z.number().min(20).max(300).optional().describe("템포(템플릿 기본값을 덮어씀)"),
    template: z.string().optional().describe("템플릿 id: citypop, lofi, ballad, bossa, edm, chiptune"),
    time_sig: z.tuple([z.number().int().min(1).max(16), z.number().int()]).optional()
      .describe("박자표 [박자수, 박자단위] — 기본 [4,4]. 변박 지원: [3,4] [6,8] [5,4] [7,8] [13,16]. 단위는 2·4·8·16만")
  }],
  ["get_song", "현재 곡의 요약·재생 상태·GUI 주소와 곡 전체 JSON을 돌려준다. 작곡 전 현재 상태 파악에 사용.", {}],
  ["set_song", "곡 전체를 JSON으로 통째로 교체한다. 대규모 수정(조옮김, 구조 재배치)은 get_song으로 받아 고친 뒤 이걸로 되돌려 넣는 게 빠르다.", {
    song_json: z.string().describe("곡 전체 JSON 문자열 — get_song이 돌려주는 형식과 동일")
  }],
  ["list_presets", "사용 가능한 멜로디 프리셋·드럼 킷(과 피스 이름)·new_song 템플릿 목록을 설명과 함께 돌려준다.", {}],
  ["add_track", "트랙을 추가한다.", {
    name: z.string().describe("트랙 이름(고유)"),
    preset: z.string().describe("프리셋 id — list_presets 참고"),
    volume: z.number().min(0).max(2).optional().describe("볼륨 0~2 (기본 0.8). 1.0이 원래 크기(0dB), 2.0이 약 +6dB. 음량에 선형으로 작용하는 축이다"),
    pan: z.number().min(-1).max(1).optional().describe("팬 -1(왼쪽)~1(오른쪽)"),
    ...toneShape
  }],
  ["remove_track", "트랙을 삭제한다.", { track: z.string().describe("트랙 이름") }],
  ["set_track", "트랙의 프리셋·볼륨·팬·이름과 음색 파라미터를 바꾼다. 음색 항목에 null을 주면 프리셋 기본값으로 되돌린다.", {
    track: z.string().describe("대상 트랙 이름"),
    preset: z.string().optional(), volume: z.number().min(0).max(2).optional(),
    pan: z.number().min(-1).max(1).optional(), new_name: z.string().optional(),
    mute: z.boolean().optional().describe("true면 재생·WAV 완성본에서 이 트랙을 제외(노트는 유지). 현재 MIDI 내보내기는 mute/solo와 무관하게 모든 트랙을 기록한다"),
    solo: z.boolean().optional().describe("true면 이 트랙만 들린다. 솔로가 하나라도 켜져 있으면 켜진 트랙들만 재생되며 음소거보다 우선한다"),
    velRange: z.number().min(0).max(1).nullable().optional().describe(toneShape.velRange.description),
    attack: z.number().min(0).max(2).nullable().optional().describe(toneShape.attack.description),
    release: z.number().min(0).max(8).nullable().optional().describe(toneShape.release.description),
    reverb: z.number().min(0).max(1).nullable().optional().describe(toneShape.reverb.description),
    ensemble: z.number().min(1).max(4).nullable().optional().describe(toneShape.ensemble.description),
    eqLow: z.number().min(-12).max(12).nullable().optional().describe(toneShape.eqLow.description),
    eqMid: z.number().min(-12).max(12).nullable().optional().describe(toneShape.eqMid.description),
    eqHigh: z.number().min(-12).max(12).nullable().optional().describe(toneShape.eqHigh.description),
    vibrato: z.number().min(0).max(1).nullable().optional().describe(toneShape.vibrato.description)
  }],
  ["set_tempo", "템포를 바꾼다. from_bar 없이 부르면 곡의 기준 템포를 바꾸고, from_bar를 주면 그 마디부터 템포가 바뀐다. ramp:true면 직전 템포에서 그 마디까지 서서히 변한다(rit./accel.).", {
    bpm: z.number().min(20).max(300).describe("목표 템포"),
    from_bar: z.number().int().min(1).max(999).optional().describe("템포가 바뀔 마디. 생략하면 곡 기준 템포를 바꾼다"),
    ramp: z.boolean().optional().describe("true면 '직전 템포 변화점'부터 이 마디까지 선형으로 변화(리타르단도·아첼레란도). 앞에 변화점이 없으면 곡 처음부터 걸리므로, 마지막 4마디만 늘어지게 하려면 앵커를 먼저 두어라 — set_tempo({bpm:같은값, from_bar:13}) 후 set_tempo({bpm:58, from_bar:16, ramp:true})")
  }],
  ["clear_tempo", "템포 변화를 삭제한다. from_bar를 주면 그 마디 것만, 안 주면 전부. 기준 템포는 남는다.", {
    from_bar: z.number().int().min(1).max(999).optional().describe("삭제할 템포 변화의 마디")
  }],
  ["humanize", "선택한 트랙·구간의 각 음에 독립적인 난수 timing/velocity 편차를 기록한다. 사람다움이나 groove를 보장하지 않고 pulse 악기에는 오히려 나쁠 수 있으므로, 원본을 보존하고 작은 범위를 정렬 버전과 A/B한다. 재생 효과가 아니라 노트 데이터를 바꾸며, 다시 부르면 편차가 누적된다.", {
    track: z.string().describe("대상 트랙 이름"),
    from_bar: z.number().int().min(1).max(999).optional().describe("시작 마디(생략하면 트랙 전체)"),
    to_bar: z.number().int().min(1).max(999).optional().describe("끝 마디"),
    timing: z.number().min(0).max(0.25).optional().describe("타이밍을 흔들 최대 폭(박). 기본 0.02는 아주 살짝, 0.06이면 확실히 느슨하다. 0이면 타이밍은 안 건드린다"),
    velocity: z.number().int().min(0).max(40).optional().describe("세기를 흔들 최대 폭. 기본 8. 0이면 세기는 안 건드린다"),
    seed: z.number().int().optional().describe("결과를 고정하는 값. 같은 입력 상태·범위·seed에서 같은 편차가 나온다. 이미 바뀐 상태에 다시 부르면 편차가 누적된다")
  }],
  ["swing", "선택한 8분 또는 16분 subdivision의 뒷박을 체계적으로 늦춘다. 장르명만으로 적용하지 말고 기준 격자와 A/B하며 정한다. 기존 swing 기준에서 다시 계산하므로 amount 변경이 누적되지는 않는다.", {
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
  ["insert_bars", "빈 마디를 끼워 넣는다(DAW의 insert time) — at_bar 앞에 count개, 전 트랙의 노트·구간 게인·템포 변화가 함께 뒤로 밀린다. undo_edit으로 되돌릴 수 있다.", {
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
  ["set_region_gain", "특정 트랙의 특정 마디 구간만 음량을 dB로 조절한다(구간 믹싱 — '여기서만 심벌 -6dB', 하이라이트 직전에 패드 낮추기 등). 같은 구간을 다시 부르면 값이 교체되고, db 0을 주면 정확히 그 구간의 게인만 제거된다(겹치기만 하는 항목은 안 건드림). 다른 구간과 겹치면 곱으로 누적.", {
    track: z.string().describe("대상 트랙 이름"),
    from_bar: z.number().int().min(1).max(999).describe("구간 시작 마디"),
    to_bar: z.number().int().min(1).max(999).optional().describe("구간 끝 마디(포함, 기본 from_bar)"),
    db: z.number().min(-60).max(12).describe("데시벨 — -6이면 약 절반 크기, +6이면 약 두 배, 0이면 제거. to_db와 같이 주면 이 값이 시작점이 된다"),
    to_db: z.number().min(-60).max(12).optional().describe("주면 구간에 걸쳐 db에서 이 값으로 서서히 변한다 — 페이드아웃은 {db:0, to_db:-60}, 페이드인은 {db:-60, to_db:0}. 노트 단위가 아니라 샘플 단위라 길게 끄는 화음 하나짜리 엔딩도 실제로 사그라든다. 구간 앞에는 db가, 구간 뒤에는 to_db가 계속 걸린다")
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
  ["export", "곡을 MIDI/WAV 파일로 내보낸다. path를 안 주면 ~/Music/aria/<제목> 에 저장. WAV는 한 번에 10분까지라 긴 곡은 from_bar/to_bar로 나눈다. MIDI는 항상 곡 전체이며 현재 bend, region gain, 음색 덮어쓰기, mute/solo, 렌더 공간·마스터 처리를 보존하지 않는다.", {
    format: z.enum(["midi", "wav", "both"]).optional().describe("기본 both"),
    path: z.string().optional().describe("확장자 없는 저장 경로 (예: ~/Desktop/mysong)"),
    from_bar: z.number().int().min(1).optional().describe("WAV로 뽑을 시작 마디(기본 1)"),
    to_bar: z.number().int().min(1).optional().describe("WAV로 뽑을 끝 마디 포함(기본 곡 끝)"),
    stems: z.boolean().optional().describe("true면 완성본 대신 악기별 WAV를 폴더에 하나씩 내보낸다(다른 DAW에서 다시 믹싱할 때). 스템에는 트랙 볼륨·음소거와 마스터 처리가 빠지고 팬·리버브·구간 게인은 담긴다. format은 무시된다")
  }],
  ["import_midi", "다른 도구에서 만든 표준 MIDI 파일(.mid)을 읽어 현재 곡으로 가져온다. 트랙 이름·템포 변화·박자표·드럼 채널을 살리고, 악기(program change)는 가장 가까운 aria 프리셋으로 추정한다. 기존 곡은 교체되지만 undo_edit으로 되돌아간다. 참고: 480PPQ 격자 위 음은 그대로 보존되지만 셋잇단은 왕복에서 길이가 1/1000박쯤 밀린다.", {
    path: z.string().describe("가져올 .mid 파일 경로 (예: ~/Downloads/song.mid)"),
    quantize: z.number().optional().describe("격자에 맞춰 정리할 단위(박) — 0.25면 16분음표. 생략하면 원본 타이밍 그대로"),
    prefer_samples: z.boolean().optional().describe("true면 합성 프리셋 대신 실제 녹음 샘플(sf-*) 프리셋으로 추정한다. 사운드폰트가 있어야 소리가 난다"),
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
  ["list_feedback", "사용자가 GUI 피아노롤에서 구간을 잡아 남긴 피드백 중 처리 안 된 것을 돌려준다. 사용자가 곡 수정을 요청하거나 get_song 요약에 피드백 표시가 있으면 가장 먼저 확인하라.", {}],
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

const INSTRUCTIONS = `aria는 작곡 앱이다. 사용자가 곡을 만들어 달라고 하면 이 도구들로 실제로 작곡하고 소리로 들려줄 수 있다.

본격적으로 곡을 만들 때는 aria-compose 스킬을 먼저 불러라. 장르를 고정 공식으로 만들지 않는 근거 기반 경향,
감정·형식·그루브·화성·편곡·진단 reference와 완성 전 자기점검 목록이 들어 있다.
아래는 스킬 없이도 알아야 할 최소한이다.

기본 워크플로:
1. get_song/list_feedback로 현재 상태 확인 → 의미 있는 현재 작업은 고유 이름으로 보존 → list_presets로 실제 프리셋 확인 → 필요할 때만 new_song/template으로 시작
2. 트랙별로 add_notes — 8마디 스케치를 먼저 완성하라 (드럼 그루브 → 베이스 → 코드 → 멜로디 순이 안정적)
3. play(from_bar, to_bar)로 방금 만든 구간만 바로 들려주기. loop:true면 반복 재생
4. 사용자 피드백 → clear_notes로 구간을 지우고 다시 쓰거나, set_song으로 통째로 교체. 구조 편집(간주 추가·후렴 줄이기)은 insert_bars/delete_bars가 전 트랙을 한 번에 민다
5. 완성되면 export로 MIDI/WAV 저장. 여러 곡을 오갈 땐 save_song/load_song/list_songs로 라이브러리를 쓴다
6. 사용자는 GUI 피아노롤에서 구간을 드래그해 피드백을 남길 수 있다 — 수정 요청을 받으면 list_feedback부터 확인하고, 반영한 항목은 resolve_feedback으로 닫는다

작곡 요령:
- 프리셋은 두 계열: 내장 신스(전자음·개성)와 샘플 sf-*(실제 악기 녹음 — 피아노·현악·기타 등 어쿠스틱 리얼리즘). list_presets에서 sf 프리셋이 "사용 가능"인지 확인하고, 발라드·재즈·클래식 무드면 sf-piano/sf-strings/sf-kit부터 고려하라
- 코드(화음)는 구성음을 같은 bar/beat에 여러 노트로 쌓는다 (Fmaj7 = F3+A3+C4+E4)
- beat·dur는 4분음표 단위: beat 0~3.999(4/4), dur 0.25=16분음표. 오프비트(2.5, 3.5)와 vel 변화(60~110)를 쓰면 리듬이 살아난다
- 드럼 트랙은 pitch에 피스 이름: kick snare rim clap hhc hho tom-l/m/h crash ride shaker
- 재생은 사용자 스피커로 즉시 나온다. 만들면 꼭 들려주고, 피아노롤 GUI 주소(get_song에 포함)를 알려줘라

다이내믹·표현 (여기를 모르면 곡이 밋밋해진다):
- velocity의 기본 폭은 좁다(vel 1~127이 약 9dB). 더 넓은 표현 폭이 실제 음색에 맞을 때만 velRange를 늘리고, 크레셴도는 velocity·구간 gain·편성·음역·음색 중 필요한 축을 나눠 쓴다
- 트랙 volume은 음량에 선형이라 파트 간 밸런스용으로 쓴다. 1.0이 0dB이고 2.0까지 올릴 수 있다
- 특정 구간만 음량을 바꾸려면 set_region_gain — "하이라이트 전까지 심벌 -8dB", "브리지에서 패드 -4dB"처럼 구간 믹싱에 쓴다. 사용자도 GUI에서 구간을 드래그해 직접 조절할 수 있다
- 아르페지오·패드가 뚝뚝 끊겨 들리면 release를 0.8~2로 올려 음끼리 겹치게 하라. 어택이 딱딱하면 attack을 0.1~0.3으로
- 리버브는 트랙마다 reverb로 조절한다(0.5~0.8이면 넓은 공간)
- rit./accel.은 set_tempo(bpm, from_bar, ramp:true). 램프는 "직전 변화점부터" 걸리므로 끝 4마디만 늘어지게 하려면 앵커를 먼저 둔다:
  set_tempo({bpm:92, from_bar:13}) → set_tempo({bpm:58, from_bar:16, ramp:true})  (13마디까지는 92, 13→16마디에서 58로)
- 현재 렌더에는 기본 마스터 리미터(-0.3dBFS ceiling)가 있다. play의 peak·RMS·LUFS·리미터 보고를 진단으로 읽되, 지속적인 큰 감쇄를 리미터에 맡기지 말고 겹치는 노트·저역·vel·트랙 balance를 먼저 고쳐라
- 변박은 new_song의 time_sig로 (예: [7,8], [5,4], [13,16])`;

export async function startMcp(execute = (name, args) => runOp(name, args, "mcp")) {
  const server = new McpServer({ name: "aria", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  for (const [name, description, shape] of TOOLS) {
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

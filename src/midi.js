// aria — 표준 MIDI 파일(SMF type 1) 내보내기, 순수 JS
import { isDrumPreset, presetGm, drumPieces } from "./presets.js";
import { noteToMidi, beatsPerBar, noteStartBeat, tempoSegments, beatToSec, bpmAtBeat, totalBars } from "./song.js";

const PPQ = 480;
// 램프 한 구간을 몇 개의 계단 템포 이벤트로 근사할지 — SMF에는 연속 템포 변화가 없다
const RAMP_STEPS_PER_BEAT = 2;
const MAX_TEMPO_EVENTS = 2000;

const tempoBytes = bpm => {
  const us = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / bpm)));
  return [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
};

// 템포 맵을 SMF 템포 이벤트 목록으로 — 램프는 계단으로 근사한다
function tempoEvents(song) {
  const segs = tempoSegments(song);
  const endBeat = totalBars(song) * beatsPerBar(song);

  // 램프 총 길이를 먼저 재서 계단 밀도를 예산에 맞춘다.
  // 상한에 걸렸다고 뒤쪽 구간을 버리면 MIDI가 WAV와 다른 템포로 끝나므로, 구간이 아니라 해상도를 줄인다.
  let rampBeats = 0, plainCount = 0;
  for (const seg of segs) {
    if (seg.startBeat > endBeat) break;
    const segEnd = Math.min(seg.endBeat, endBeat);
    if (seg.bpm1 !== seg.bpm0 && Number.isFinite(seg.endBeat) && segEnd > seg.startBeat) rampBeats += segEnd - seg.startBeat;
    else plainCount++;
  }
  // 구간마다 램프 종료 이벤트 1개 + ceil 반올림 1개가 더 붙으므로 세그먼트 수의 2배를 빼 둔다
  const budget = Math.max(1, MAX_TEMPO_EVENTS - plainCount - 2 * segs.length);
  const density = rampBeats > 0 ? Math.min(RAMP_STEPS_PER_BEAT, budget / rampBeats) : RAMP_STEPS_PER_BEAT;

  const events = [];
  let order = 0;
  for (const seg of segs) {
    if (seg.startBeat > endBeat) break; // 곡 범위 밖 구간은 내보내지 않는다(빈 마디가 붙는 것 방지)
    const segEnd = Math.min(seg.endBeat, endBeat);
    const ramping = seg.bpm1 !== seg.bpm0 && Number.isFinite(seg.endBeat);
    if (!ramping || segEnd <= seg.startBeat) {
      events.push({ tick: Math.round(seg.startBeat * PPQ), order: order++, bytes: tempoBytes(seg.bpm0) });
      continue;
    }
    const span = segEnd - seg.startBeat;
    const steps = Math.max(1, Math.ceil(span * density));
    const h = span / steps;
    for (let k = 0; k < steps; k++) {
      const beat = seg.startBeat + h * k;
      // 계단의 상수 템포는 그 계단의 '실제 소요 시간'을 재현하는 값이어야 한다(구간 조화평균).
      // 시작 시점의 순간 bpm을 쓰면 좌단점 리만합이 되어 램프 끝에서 오디오와 시간이 어긋나고,
      // 그 오프셋이 곡 끝까지 그대로 남는다.
      const dt = beatToSec(segs, beat + h) - beatToSec(segs, beat);
      events.push({ tick: Math.round(beat * PPQ), order: order++, bytes: tempoBytes(dt > 0 ? (60 * h) / dt : bpmAtBeat(segs, beat)) });
    }
    // 램프가 끝나는 지점의 실제 템포 — 곡 길이로 잘렸다면 목표값이 아니라 보간값이다
    events.push({ tick: Math.round(segEnd * PPQ), order: order++, bytes: tempoBytes(bpmAtBeat(segs, segEnd)) });
  }
  return events;
}

function vlq(n) {
  // 가변 길이 수량 인코딩
  const bytes = [n & 0x7f];
  while ((n >>= 7) > 0) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

function trackChunk(events) {
  // events: [{tick, bytes:[...]}] — tick 오름차순 정렬 후 델타 인코딩
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out = [];
  let last = 0;
  for (const e of events) {
    out.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  out.push(...vlq(0), 0xff, 0x2f, 0x00); // end of track
  const buf = Buffer.alloc(8 + out.length);
  buf.write("MTrk", 0);
  buf.writeUInt32BE(out.length, 4);
  Buffer.from(out).copy(buf, 8);
  return buf;
}

export function midiBuffer(song) {
  const melodicCount = song.tracks.filter(t => !isDrumPreset(t.preset)).length;
  if (melodicCount > 15)
    throw new Error(`멜로디 트랙이 ${melodicCount}개 — MIDI는 멜로디 트랙 15개(채널 한계)까지만 내보낼 수 있습니다`);
  const chunks = [];
  // 트랙 0: 박자 + 템포(맵 전체)
  const [num, den] = song.timeSig;
  chunks.push(trackChunk([
    { tick: 0, order: -1, bytes: [0xff, 0x58, 0x04, num, Math.log2(den), 24, 8] },
    ...tempoEvents(song)
  ]));

  let melodicCh = 0;
  for (const track of song.tracks) {
    const drum = isDrumPreset(track.preset);
    let ch;
    if (drum) ch = 9;
    else { ch = melodicCh++; if (melodicCh === 9) melodicCh++; }
    const events = [];
    let order = 0;
    // 트랙 이름 + 프로그램
    const nameBytes = [...Buffer.from(track.name, "utf8")];
    events.push({ tick: 0, order: order++, bytes: [0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes] });
    if (!drum) events.push({ tick: 0, order: order++, bytes: [0xc0 | ch, presetGm(track.preset) & 0x7f] });
    const vol7 = Math.round(track.volume * 127);
    events.push({ tick: 0, order: order++, bytes: [0xb0 | ch, 7, vol7] });
    events.push({ tick: 0, order: order++, bytes: [0xb0 | ch, 10, Math.round((track.pan + 1) * 63.5)] });
    for (const n of track.notes) {
      const key = drum ? (drumPieces(track.preset)[n.pitch] ?? 38) : noteToMidi(n.pitch);
      const on = Math.round(noteStartBeat(song, n) * PPQ);
      const off = Math.round((noteStartBeat(song, n) + n.dur) * PPQ);
      events.push({ tick: on, order: order++, bytes: [0x90 | ch, key, n.vel] });
      events.push({ tick: Math.max(on + 1, off), order: order++, bytes: [0x80 | ch, key, 0] });
    }
    chunks.push(trackChunk(events));
  }

  const header = Buffer.alloc(14);
  header.write("MThd", 0);
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(1, 8); // format 1
  header.writeUInt16BE(chunks.length, 10);
  header.writeUInt16BE(PPQ, 12);
  return Buffer.concat([header, ...chunks]);
}

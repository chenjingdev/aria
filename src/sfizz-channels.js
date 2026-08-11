// sfizz MIDI channel planner shared by the renderer and edits that can create
// per-note pitch-bend lanes. It only plans channels; callers decide how to
// report an over-capacity result and whether a candidate state may be stored.

export const MAX_SFIZZ_MIDI_CHANNELS = 16;

export function assignSfizzChannels(notes) {
  const ordered = notes.map((note, index) => ({ note, index }))
    .sort((a, b) => a.note.startSample - b.note.startSample ||
      a.note.endSample - b.note.endSample || a.index - b.index);
  const lanes = [];

  // MIDI pitch wheel is channel-wide. A bent note owns one channel for its
  // whole gate/release. Straight notes may share a lane unless the same key
  // overlaps under the same per-note CC state.
  for (const { note } of ordered) {
    const controls = Array.isArray(note.controls) ? note.controls : [];
    const controlsKey = controls.map(control => `${control.controller}:${control.value}`).join(",");
    let lane;
    if (note.bend !== 0) {
      lane = { permanent:true, controlsKey, controls, endsByKey:new Map() };
      lanes.push(lane);
    } else {
      lane = lanes.find(item => !item.permanent && item.controlsKey === controlsKey &&
        (item.endsByKey.get(note.key) ?? -1) <= note.startSample);
      if (!lane) {
        lane = { permanent:false, controlsKey, controls, endsByKey:new Map() };
        lanes.push(lane);
      }
    }
    note.channel = lanes.indexOf(lane);
    lane.endsByKey.set(note.key, note.endSample);
  }

  return {
    requiredChannels: lanes.length,
    channelCount: Math.max(1, lanes.length),
    channelControls: lanes.length ? lanes.map(lane => lane.controls) : [[]]
  };
}

// 빌드한 SF2를 Aria의 실제 오픈소스 재생 엔진으로 확인하는 작은 도우미.
import { openSpessaSession } from "../src/spessa-engine.js";

export function openSf2Checker(filePath, sampleRate = 44100) {
  const session = openSpessaSession(filePath, sampleRate, []);
  return {
    info: session.engine,
    render({ bank = 0, program, drum = bank === 128, key, velocity, gateSec = 0.4, lengthSec = 8 }) {
      const length = Math.max(1, Math.ceil(lengthSec * sampleRate));
      const result = session.renderTrack({
        preset: { bank, program, drum },
        track: {},
        notes: [{
          startSample: 0,
          endSample: Math.max(1, Math.min(length, Math.round(gateSec * sampleRate))),
          key,
          velocity: Math.max(1, Math.min(127, Math.round(velocity * 127))),
          gain: 1,
          bend: 0
        }],
        length
      });
      return result.left;
    },
    close() { session.close(); }
  };
}

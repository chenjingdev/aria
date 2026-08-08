// aria — sampler 종류와 무관한 음원 상태 경계.
// SoundFont는 SpessaSynth, SFZ는 sfizz가 검사하며 누락 시 다른 음원으로 대체하지 않는다.
import path from "node:path";
import { fontStatus } from "./sf2.js";
import { sfzStatus, SFIZZ_ENGINE_ID } from "./sfizz-engine.js";

export function samplerAssetStatus(spec, options = {}) {
  const engine = spec?.engine ?? "spessa-sf2";
  if (engine === SFIZZ_ENGINE_ID) return sfzStatus(spec, options);
  if (engine === "spessa-sf2") return { engine, ...fontStatus(spec) };
  return {
    engine,
    available: false,
    state: "unsupported",
    file: null,
    name: spec?.pack ?? spec?.font ?? "알 수 없는 음원",
    pack: spec?.pack ?? null,
    reason: `지원하지 않는 sampler engine입니다: ${engine}`
  };
}

export function samplerAssetName(spec, status = samplerAssetStatus(spec)) {
  if (spec?.engine === SFIZZ_ENGINE_ID) {
    const file = typeof spec.sfz === "string" ? path.basename(spec.sfz) : status.name;
    return spec.pack ? `${spec.pack}/${file}` : file;
  }
  return status.name;
}

export function samplerEngineLabel(spec) {
  return spec?.engine === SFIZZ_ENGINE_ID ? "sfizz · SFZ" : "SpessaSynth · SoundFont";
}

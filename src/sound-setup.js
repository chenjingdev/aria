// First-run sound setup. Only the native picker supplies source paths; destinations
// are fixed by Aria. Importing a file never replaces an existing sound library.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SF2_PATH, fontStatus } from "./sf2.js";
import { SF_PRESETS, SF_DRUM_KITS } from "./presets.js";
import { resolveSfizzBinary } from "./sfizz-engine.js";
import { renderRange } from "./sampler-renderer.js";
import { wavBuffer } from "./renderer.js";
import { openSpessaSession } from "./spessa-engine.js";

const execFileAsync = promisify(execFile);
const basicSpecs = [...Object.values(SF_PRESETS), ...Object.values(SF_DRUM_KITS)]
  .filter(spec => !spec.engine && (!spec.font || spec.font === "default.sf2"));

export function soundSetupStatus() {
  const available = basicSpecs.filter(spec => fontStatus(spec).available).length;
  let sfizz = { ready: true };
  try { resolveSfizzBinary(); }
  catch { sfizz = { ready: false, message: "추가 오케스트라·드럼 팩을 재생하려면 SFZ 엔진을 먼저 설치하세요. 기본 악기에는 필요하지 않습니다." }; }
  return {
    basic: { ready: available === basicSpecs.length && available > 0, available,
      total: basicSpecs.length, exists: fs.existsSync(SF2_PATH),
      sourceUrl: "https://www.schristiancollins.com/generaluser",
      licenseUrl: "https://github.com/mrbumpy409/GeneralUser-GS/blob/main/documentation/LICENSE.txt" },
    sfizz
  };
}

export async function chooseSoundFile({ signal, archive = false } = {}) {
  if (process.platform !== "darwin") throw new Error("음원 파일 선택은 macOS에서 지원합니다");
  const prompt = archive ? "공식 사이트에서 받은 음원 압축파일을 선택하세요 (압축을 풀지 마세요)"
    : "GeneralUser GS 다운로드의 압축을 푼 뒤 .sf2 파일을 선택하세요";
  const script = `with timeout of 3600 seconds
    try
      activate
      set selectedFile to choose file with prompt "${prompt}" default location (path to downloads folder)
      return POSIX path of selectedFile
    on error number -128
      return ""
    end try
  end timeout`;
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8", maxBuffer: 64 * 1024, signal
  });
  const file = stdout.replace(/\r?\n$/, "");
  if (!file) return null;
  if (!path.isAbsolute(file)) throw new Error("선택한 음원 파일 경로를 읽지 못했습니다");
  return file;
}

export function importBasicSoundfont(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".sf2")
    throw new Error("받은 ZIP의 압축을 풀고, 그 안의 .sf2 파일을 선택해 주세요.");
  if (fs.existsSync(SF2_PATH)) throw new Error("기본 음원 파일이 이미 있습니다. 기존 곡의 소리를 보존하기 위해 덮어쓰지 않았습니다.");
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 512 * 1024 * 1024)
    throw new Error("기본 악기용 512MB 이하의 SF2 파일을 선택해 주세요.");
  fs.mkdirSync(path.dirname(SF2_PATH), { recursive: true });
  const staged = path.join(path.dirname(SF2_PATH), `.import-${crypto.randomUUID()}.sf2`);
  try {
    fs.copyFileSync(file, staged, fs.constants.COPYFILE_EXCL);
    for (const spec of basicSpecs) {
      const status = fontStatus({ ...spec, font: staged });
      if (!status.available) throw new Error(`기본 악기를 모두 읽을 수 없습니다: ${status.reason}. GeneralUser GS의 SF2 파일을 선택해 주세요.`);
    }
    const session = openSpessaSession(staged);
    session.close();
    // link is atomic and refuses to overwrite even if another process installed
    // the destination while this file was being checked.
    fs.linkSync(staged, SF2_PATH);
    return { fileName: path.basename(file), ...soundSetupStatus() };
  } finally { fs.rmSync(staged, { force: true }); }
}

export function basicSoundPreview() {
  if (!soundSetupStatus().basic.ready) throw new Error("기본 악기를 먼저 설치해 주세요.");
  const song = { title: "음원 확인", bpm: 120, timeSig: [4, 4], tempoMap: [], tracks: [
    { name: "Piano", preset: "sf-piano-gm", volume: 0.65, pan: 0,
      notes: ["C4", "E4", "G4", "C5"].map((pitch, beat) => ({ bar: 1, beat, pitch, dur: 0.6, vel: 80 })) }
  ] };
  const { left, right, sr } = renderRange(song, 1, 1);
  return wavBuffer(left, right, sr);
}

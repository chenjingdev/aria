import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FFMPEG_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin"];

function findFfmpeg() {
  const override = process.env.ARIA_FFMPEG;
  const command = override || "ffmpeg";
  const directories = [...(process.env.PATH || "").split(path.delimiter).filter(Boolean), ...FFMPEG_DIRECTORIES];
  const candidates = command.includes(path.sep)
    ? [path.resolve(command)]
    : directories.map(directory => path.resolve(directory, command));
  for (const candidate of new Set(candidates)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* Try the next installed location. */ }
  }
  throw new Error("MP3 저장에 필요한 FFmpeg를 찾지 못했습니다. FFmpeg를 설치하거나 ARIA_FFMPEG에 실행 파일 경로를 지정하세요.");
}

// Keep conversion failures from replacing an existing export with partial audio.
export function writeMp3(wavBuffer, outputPath) {
  const ffmpeg = findFfmpeg();
  const temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(outputPath), ".aria-mp3-"));
  const temporaryFile = path.join(temporaryDirectory, "audio.mp3");
  try {
    try {
      execFileSync(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
        "-f", "wav", "-i", "pipe:0", "-map", "0:a:0",
        "-codec:a", "libmp3lame", "-b:a", "320k", "-f", "mp3", temporaryFile
      ], { input: wavBuffer, stdio: ["pipe", "ignore", "pipe"], maxBuffer: 1024 * 1024 });
    } catch (error) {
      const detail = String(error.stderr || error.message || "").trim().slice(0, 600);
      if (/unknown encoder.*libmp3lame|encoder.*libmp3lame.*not found/i.test(detail))
        throw new Error("설치된 FFmpeg에 MP3 인코더(libmp3lame)가 없습니다. libmp3lame을 포함한 FFmpeg를 설치하세요.");
      throw new Error(`MP3 변환에 실패했습니다${detail ? `: ${detail}` : "."}`);
    }
    if (!fs.existsSync(temporaryFile) || fs.statSync(temporaryFile).size === 0)
      throw new Error("MP3 변환에 실패했습니다: 오디오 파일이 생성되지 않았습니다.");
    fs.renameSync(temporaryFile, outputPath);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

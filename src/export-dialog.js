// 로컬 GUI 내보내기용 macOS 폴더 선택창. 경로는 브라우저 입력이 아닌 시스템 창에서 받는다.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CHOOSE_FOLDER = `
with timeout of 3600 seconds
  try
    activate
    set destination to choose folder with prompt "Aria 파일을 저장할 폴더를 선택하세요" default location (path to music folder)
    return POSIX path of destination
  on error number -128
    return ""
  end try
end timeout
`;

export async function chooseExportDirectory({ signal } = {}) {
  if (process.platform !== "darwin")
    throw new Error("저장 폴더 선택은 macOS에서 지원합니다");
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", CHOOSE_FOLDER], {
    encoding: "utf8", maxBuffer: 64 * 1024, signal
  });
  // osascript가 붙인 마지막 줄바꿈만 제거한다. 폴더 이름의 공백은 그대로 보존한다.
  const directory = stdout.replace(/\r?\n$/, "");
  if (!directory) return null;
  if (!path.isAbsolute(directory)) throw new Error("선택한 저장 폴더 경로를 읽지 못했습니다");
  return directory;
}

// ARIA_DATA_DIR_PER_SESSION=1: 이 브리지 프로세스와 그것이 자동 시작하는 앱이 자기만의 데이터 디렉터리를 쓴다.
// 같은 프로필의 브리지가 여럿 동시에 떠도(벤치에서 같은 하네스를 두 번 돌릴 때) 곡·라이브러리·인스턴스를 공유하지 않게.
// <ARIA_DATA_DIR>/sessions/<시각>-<pid> 로 갈라지며, 음원·팩·엔진은 ~/.aria 의 것을 그대로 쓴다.
// runtime.js·core.js 가 import 시점에 ARIA_DATA_DIR 를 읽으므로 mcp-bridge.js 의 첫 import 여야 한다.
import os from "node:os";
import path from "node:path";

if (process.env.ARIA_DATA_DIR_PER_SESSION === "1") {
  const base = process.env.ARIA_DATA_DIR || path.join(os.homedir(), ".aria");
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
  process.env.ARIA_DATA_DIR = path.join(base, "sessions", `${stamp}-${process.pid}`);
  delete process.env.ARIA_RUNTIME_FILE; // 실행 정보도 세션 디렉터리 안에 — 고정 경로가 남아 있으면 남의 앱에 붙는다
  process.env.ARIA_DATA_DIR_PER_SESSION = "0"; // 자동 시작되는 앱이 한 번 더 갈라 들지 않게
}

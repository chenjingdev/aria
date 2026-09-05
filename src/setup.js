import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { soundSetupStatus } from "./sound-setup.js";
import { APP_VERSION } from "./version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const onboardingFile = path.join(process.env.ARIA_DATA_DIR || path.join(os.homedir(), ".aria"), "onboarding.json");
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function onboardingStatus() {
  try {
    const value = JSON.parse(fs.readFileSync(onboardingFile, "utf8"));
    if (value.schema === 1 && typeof value.completedAt === "string" && Number.isFinite(Date.parse(value.completedAt)))
      return { completed: true, completedAt: value.completedAt };
  } catch { /* First run or an unreadable completion record: show the guide. */ }
  return { completed: false, completedAt: null };
}

export function completeOnboarding() {
  const current = onboardingStatus();
  if (current.completed) return current;
  fs.mkdirSync(path.dirname(onboardingFile), { recursive: true });
  const value = { schema: 1, completedAt: new Date().toISOString() };
  const temporary = `${onboardingFile}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, onboardingFile);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { completed: true, completedAt: value.completedAt };
}

function nodeCommand() {
  // Homebrew's versioned Cellar path disappears after an upgrade. Prefer a
  // stable executable link only after verifying it resolves to this same Node.
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node",
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
      .map(directory => path.join(directory, process.platform === "win32" ? "node.exe" : "node"))];
  const actual = fs.realpathSync(process.execPath);
  for (const file of candidates) {
    try {
      if (path.isAbsolute(file) && fs.realpathSync(file) === actual) return file;
    } catch { /* Not installed at this location. */ }
  }
  return process.execPath;
}

export function setupInfo(ai = { lastSeenAt: null }) {
  const command = nodeCommand();
  const args = [path.join(root, "src", "mcp-bridge.js")];
  const launch = [command, ...args].map(shellQuote).join(" ");
  const commands = {
    claude: `claude mcp add --scope user aria -- ${launch}`,
    codex: `codex mcp add aria -- ${launch}`
  };
  const mcpConfig = { mcpServers: { aria: { command, args } } };
  const verificationPrompt = "Aria의 get_song 도구를 호출해서 연결 상태와 현재 곡을 확인해 줘. 곡은 수정하지 마.";
  const agentPrompt = `이 Mac에 설치된 Aria를 지금 내가 사용하는 AI 앱에 MCP로 연결하고, 실제 도구 호출까지 확인해 줘.

Aria 폴더: ${JSON.stringify(root)}
Node 실행 파일: ${JSON.stringify(command)}
MCP 브리지: ${JSON.stringify(args[0])}

1. 이 경로에 접근할 수 있는 같은 Mac의 로컬 에이전트인지 확인해 줘. 원격·클라우드 환경이거나 경로가 없다면 다른 컴퓨터를 설정하지 말고, 이 Mac의 로컬 AI에서 요청해야 한다고 알려줘.
2. 지금 사용하는 AI 클라이언트와 기존 aria MCP 등록을 확인해 줘. 같은 실행 파일·브리지가 이미 등록됐다면 중복 추가하지 마. 다른 등록이 있다면 해당 설정을 백업하고 aria 항목만 수정해 줘. 다른 MCP 서버, 계정, 권한 설정은 유지해 줘.
3. 클라이언트에 맞는 아래 명령 하나 또는 해당 앱의 MCP 설정을 사용해 등록을 직접 진행해 줘. 두 클라이언트를 모두 설정할 필요는 없어.

Codex:
${commands.codex}

Claude Code:
${commands.claude}

다른 MCP 지원 앱의 stdio 설정:
${JSON.stringify(mcpConfig, null, 2)}

4. 새 도구를 사용할 수 있으면 반드시 aria의 get_song을 실제 MCP 도구로 호출해 줘. 곡이 없는 정상 응답도 연결 성공이야. HTTP 직접 요청이나 설정 파일 확인만으로 연결됐다고 말하지 마. 기존 곡과 음원은 변경하지 마.
5. 현재 세션에 새 도구가 나타나지 않으면 등록 완료와 연결 미확인을 구분해서 알려줘. 새 작업·대화를 열어야 한다면 다음 확인 요청을 반환해 줘:
${verificationPrompt}

로그인이나 앱 재시작처럼 내가 직접 해야 하는 단계가 생기면 필요한 행동만 구체적으로 알려줘.`;
  return {
    version: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    ...soundSetupStatus(),
    ai: { lastSeenAt: ai.lastSeenAt ?? null },
    onboarding: onboardingStatus(),
    commands,
    mcpConfig,
    agentPrompt,
    verificationPrompt,
    firstPrompt: "Aria에 설치된 기본 악기만 사용해서 차분한 8마디 곡을 만들고 들려줘."
  };
}

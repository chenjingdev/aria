import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { soundSetupStatus } from "./sound-setup.js";
import { APP_VERSION } from "./version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

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
  return {
    version: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    ...soundSetupStatus(),
    ai: { lastSeenAt: ai.lastSeenAt ?? null },
    commands: {
      claude: `claude mcp add --scope user aria -- ${launch}`,
      codex: `codex mcp add aria -- ${launch}`
    },
    mcpConfig: { mcpServers: { aria: { command, args } } },
    verificationPrompt: "Aria의 get_song 도구를 호출해서 연결 상태와 현재 곡을 확인해 줘. 곡은 수정하지 마.",
    firstPrompt: "Aria에 설치된 기본 악기만 사용해서 차분한 8마디 곡을 만들고 들려줘."
  };
}

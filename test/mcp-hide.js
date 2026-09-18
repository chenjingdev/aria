// aria — ARIA_HIDE_TOOLS로 숨긴 도구가 안내문에서도 함께 사라지는지 검증(브리지 실행은 test/mcp-bridge.js)
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aria-hide-"));
process.env.ARIA_DATA_DIR = dataDir;
process.env.ARIA_RUNTIME_FILE = path.join(dataDir, "runtime.json");
process.env.ARIA_SCAN = "0";

const { buildInstructions, TOOL_NAMES } = await import("../src/mcp.js");

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed++; console.log(`  ✓ ${message}`); };
const mentions = (text, name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);
const isHeader = line => /^[^\s-].*:$/.test(line);
const ONESHOT_HIDE = ["list_feedback", "resolve_feedback", "add_feedback", "ab_save", "ab_load", "list_songs", "load_song", "import_midi"];

console.log("aria 도구 숨김 테스트");
try {
  ok(TOOL_NAMES.length === 47 && new Set(TOOL_NAMES).size === 47 && ONESHOT_HIDE.every(n => TOOL_NAMES.includes(n)),
    "도구 이름 47개가 고유하고 숨길 후보가 전부 실제 도구");

  const full = buildInstructions();
  // add_feedback·import_midi는 원문 안내문에 등장하지 않는다 — 원문에 있는 여섯 이름만 확인한다.
  const mentionedInFull = ["list_feedback", "resolve_feedback", "ab_save", "ab_load", "list_songs", "load_song"];
  ok(full === buildInstructions([]) && mentionedInFull.every(n => mentions(full, n)),
    "숨긴 도구가 없으면 안내문이 원문 그대로");

  const oneshot = buildInstructions(ONESHOT_HIDE);
  ok(ONESHOT_HIDE.every(n => !mentions(oneshot, n)), "숨긴 도구 이름이 안내문에서 모두 사라짐");
  ok(oneshot.includes("- new_song은 노트가 있는 현재 곡을 자동으로 라이브러리에 보존한 뒤 교체한다. save_song은 이름을 붙여 라이브러리에 보관한다."),
    "묶인 이름에서 숨긴 것만 빼고 남은 도구의 문장은 유지");
  ok(!oneshot.includes("피드백:") && oneshot.includes("곡 관리:") && oneshot.includes("GUI 주소는 get_song 결과에 포함"),
    "항목이 다 빠진 절 제목은 사라지고 다른 절은 유지");
  ok(!/\n{3,}/.test(oneshot) && !/^\s*-\s*$/m.test(oneshot) && !/(^|\n)[^\s-][^\n]*:\n(\n|$)/.test(oneshot),
    "빈 항목·연속 빈 줄·빈 절이 남지 않음");

  const oneshotLines = new Set(oneshot.split("\n"));
  const untouched = full.split("\n").filter(l => l && !isHeader(l) && !ONESHOT_HIDE.some(n => mentions(l, n)));
  ok(untouched.every(l => oneshotLines.has(l)), "숨긴 도구를 말하지 않는 줄은 글자 하나 바뀌지 않음");

  const copyHidden = buildInstructions(["copy_bars"]);
  ok(copyHidden.includes("- insert_bars/delete_bars는 전 트랙의") && !mentions(copyHidden, "copy_bars")
    && copyHidden.split("\n").length === full.split("\n").length,
    "묶음 가운데 도구 하나만 숨겨도 줄 구조는 유지");
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`통과 ${passed}건 — 도구 숨김 문제 없음`);

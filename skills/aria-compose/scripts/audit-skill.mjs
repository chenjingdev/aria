#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const ariaRoot = path.resolve(skillRoot, "../..");
const referencesDir = path.join(skillRoot, "references");
const sourcesPath = path.join(referencesDir, "sources.md");
const capabilitiesPath = path.join(referencesDir, "aria-capabilities.md");
const mcpPath = path.join(ariaRoot, "src", "mcp.js");
const presetsPath = path.join(ariaRoot, "src", "presets.js");

const errors = [];
const markdownFiles = [
  path.join(skillRoot, "SKILL.md"),
  ...fs.readdirSync(referencesDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => path.join(referencesDir, name)),
];

function fail(message) {
  errors.push(message);
}

function rel(filePath) {
  return path.relative(skillRoot, filePath) || ".";
}

for (const filePath of markdownFiles) {
  const body = fs.readFileSync(filePath, "utf8");
  const links = body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    const target = rawTarget.split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
    const resolved = path.resolve(path.dirname(filePath), decodeURIComponent(target));
    if (!fs.existsSync(resolved)) {
      fail(`${rel(filePath)}: 존재하지 않는 로컬 링크 ${rawTarget}`);
    }
  }
}

const sourcesBody = fs.readFileSync(sourcesPath, "utf8");
const definitions = [...sourcesBody.matchAll(/^- \*\*\[(S\d+)\][^\n]*$/gm)];
const definedIds = new Set();
for (const match of definitions) {
  const id = match[1];
  if (definedIds.has(id)) fail(`references/sources.md: 중복 출처 ${id}`);
  definedIds.add(id);
  if (!/https:\/\//.test(match[0]) && !["S69", "S70"].includes(id)) {
    fail(`references/sources.md: 외부 출처 ${id}에 HTTPS 링크가 없음`);
  }
}

for (const filePath of markdownFiles.filter((candidate) => candidate !== sourcesPath)) {
  const body = fs.readFileSync(filePath, "utf8");
  for (const match of body.matchAll(/\[(S\d+)\]/g)) {
    if (!definedIds.has(match[1])) {
      fail(`${rel(filePath)}: 정의되지 않은 출처 ${match[1]}`);
    }
  }
}

const numericIds = [...definedIds]
  .map((id) => Number(id.slice(1)))
  .sort((a, b) => a - b);
for (let expected = 1; expected <= (numericIds.at(-1) ?? 0); expected += 1) {
  if (!numericIds.includes(expected)) fail(`references/sources.md: S${String(expected).padStart(2, "0")} 누락`);
}

const mcpBody = fs.readFileSync(mcpPath, "utf8");
const toolsStart = mcpBody.indexOf("const TOOLS = [");
const toolsEnd = mcpBody.indexOf("\n];", toolsStart);
if (toolsStart < 0 || toolsEnd < 0) {
  fail("src/mcp.js: TOOLS 배열을 찾지 못함");
} else {
  const toolsBlock = mcpBody.slice(toolsStart, toolsEnd);
  const actualTools = [...toolsBlock.matchAll(/^\s*\["([a-z0-9_]+)"/gm)].map((match) => match[1]);
  const capabilitiesBody = fs.readFileSync(capabilitiesPath, "utf8");
  const marker = capabilitiesBody.match(/<!--\s*aria-tools:\s*([^>]+?)\s*-->/);
  if (!marker) {
    fail("references/aria-capabilities.md: aria-tools 표식을 찾지 못함");
  } else {
    const documentedTools = marker[1].split(",").map((name) => name.trim()).filter(Boolean);
    if (new Set(documentedTools).size !== documentedTools.length) {
      fail("references/aria-capabilities.md: 도구 목록에 중복이 있음");
    }
    if (actualTools.length !== 44) {
      fail(`src/mcp.js: 예상한 44개가 아니라 ${actualTools.length}개 도구가 감지됨`);
    }
    if (actualTools.join(",") !== documentedTools.join(",")) {
      const missing = actualTools.filter((name) => !documentedTools.includes(name));
      const stale = documentedTools.filter((name) => !actualTools.includes(name));
      fail(`Aria 도구 목록 불일치 (문서 누락: ${missing.join(",") || "없음"}; 문서에만 존재: ${stale.join(",") || "없음"})`);
    }
  }
}

const combinedSkillText = markdownFiles.map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");
const staleClaims = [
  "마스터에 리미터가 없다",
  "리미터 없음",
  "피치벤드·비브라토 없음",
  "크레셴도의 유일한 정답",
];
for (const claim of staleClaims) {
  if (combinedSkillText.includes(claim)) fail(`폐기한 설명이 남아 있음: ${claim}`);
}

const staleMcpClaims = [
  "마스터에 리미터가 없다",
  "기계적인 느낌을 없앤다",
  "같은 seed면 늘 같은 흔들림이 나온다",
  "장르에 맞는 트랙 편성과 bpm",
  "사람 냄새를 남기려면",
];
for (const claim of staleMcpClaims) {
  if (mcpBody.includes(claim)) fail(`src/mcp.js에 폐기한 설명이 남아 있음: ${claim}`);
}

const { TEMPLATES, SF_PRESETS, SF_DRUM_KITS } = await import(pathToFileURL(presetsPath).href);
const soundFontPresetIds = new Set([
  ...Object.keys(SF_PRESETS),
  ...Object.keys(SF_DRUM_KITS),
]);
for (const [id, template] of Object.entries(TEMPLATES)) {
  if (!template.name.includes("출발 스케치")) {
    fail(`src/presets.js: ${id} 템플릿이 선택적 출발 스케치로 표시되지 않음`);
  }
  for (const track of template.tracks) {
    if (!soundFontPresetIds.has(track.preset) || !track.preset.startsWith("sf-")) {
      fail(`src/presets.js: ${id} 템플릿의 ${track.preset}은 현재 외부 SoundFont 프리셋이 아님`);
    }
  }
}

if (errors.length) {
  console.error(`aria-compose 감사 실패 (${errors.length}건)`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `aria-compose 구조 감사 통과: ${markdownFiles.length}개 문서, ${definedIds.size}개 출처 ID, 44개 Aria 도구`,
);
console.log("주의: 이 검사는 링크·ID·도구 표면·폐기 문구를 확인하며, source-to-claim 의미 적합성은 별도 수동 검토 대상입니다.");

// 자체 SoundFont renderer 전용 트랙 필드를 제거하고 원본 JSON을 체크섬과 함께 보관한다.
// 기본은 읽기 전용 점검이며, 앱을 정상 종료한 뒤 --apply로 실행한다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { validateSong } from "../src/song.js";

const DATA_DIR = process.env.ARIA_DATA_DIR || path.join(os.homedir(), ".aria");
const APPLY = process.argv.includes("--apply");
const REMOVED = ["attack", "release", "vibrato", "ensemble"];
const files = [path.join(DATA_DIR, "song.json")];
const library = path.join(DATA_DIR, "songs");
if (fs.existsSync(library)) {
  for (const name of fs.readdirSync(library).filter(name => name.endsWith(".json")).sort())
    files.push(path.join(library, name));
}

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const plan = [];
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const original = fs.readFileSync(file);
  const raw = JSON.parse(original.toString("utf8"));
  let removed = 0;
  const perKey = Object.fromEntries(REMOVED.map(key => [key, 0]));
  for (const track of raw.tracks ?? []) {
    for (const key of REMOVED) {
      if (!Object.hasOwn(track, key)) continue;
      delete track[key];
      perKey[key]++;
      removed++;
    }
  }
  const validated = validateSong(raw);
  const output = Buffer.from(JSON.stringify(validated));
  plan.push({ file, original, output, removed, perKey, title: validated.title,
    tracks: validated.tracks.length,
    notes: validated.tracks.reduce((sum, track) => sum + track.notes.length, 0) });
}

const changed = plan.filter(item => item.removed > 0);
console.log(`점검 ${plan.length}개 · 변경 대상 ${changed.length}개 · 제거 필드 ${changed.reduce((sum, item) => sum + item.removed, 0)}개`);
for (const item of changed)
  console.log(`  ${path.relative(DATA_DIR, item.file)} — ${item.title}: ${JSON.stringify(item.perKey)}`);

if (!APPLY) {
  console.log("읽기 전용 점검만 했습니다. 앱을 종료한 뒤 --apply를 붙여 실행하세요.");
  process.exit(0);
}

const backupRoot = path.join(DATA_DIR, "backups");
fs.mkdirSync(backupRoot, { recursive: true });
const backupDir = fs.mkdtempSync(path.join(backupRoot, "open-sampler-migration-"));
const manifest = {
  schema: 1,
  createdAt: new Date().toISOString(),
  dataDir: DATA_DIR,
  removedFields: REMOVED,
  files: []
};

for (const item of plan) {
  const relative = path.relative(DATA_DIR, item.file);
  const backup = path.join(backupDir, relative);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(item.file, backup);
  manifest.files.push({
    relative,
    title: item.title,
    tracks: item.tracks,
    notes: item.notes,
    removed: item.perKey,
    originalSha256: sha256(item.original),
    migratedSha256: sha256(item.output)
  });
}

for (const item of changed) {
  const temp = `${item.file}.open-sampler-${process.pid}.tmp`;
  fs.writeFileSync(temp, item.output, { mode: 0o600 });
  fs.renameSync(temp, item.file);
}

fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });

// 마지막 검증: 원본 백업과 현재 파일의 체크섬, 트랙·노트 수, 새 스키마를 모두 다시 확인한다.
for (const entry of manifest.files) {
  const backup = fs.readFileSync(path.join(backupDir, entry.relative));
  if (sha256(backup) !== entry.originalSha256) throw new Error(`${entry.relative} 백업 체크섬 불일치`);
  const current = fs.readFileSync(path.join(DATA_DIR, entry.relative));
  if (sha256(current) !== entry.migratedSha256) throw new Error(`${entry.relative} 변환 체크섬 불일치`);
  const song = validateSong(JSON.parse(current));
  const notes = song.tracks.reduce((sum, track) => sum + track.notes.length, 0);
  if (song.tracks.length !== entry.tracks || notes !== entry.notes)
    throw new Error(`${entry.relative} 트랙·노트 수가 변했습니다`);
  for (const track of song.tracks)
    for (const key of REMOVED)
      if (Object.hasOwn(track, key)) throw new Error(`${entry.relative}에 ${key}가 남았습니다`);
}

console.log(`변환 완료 · 백업: ${backupDir}`);

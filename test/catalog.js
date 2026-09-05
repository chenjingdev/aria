// aria — 음원 카탈로그 계층 뷰·계층 ID 해석 테스트 (곡 상태·렌더·앱과 무관, 결정적)
import assert from "node:assert";
const {
  catalogNodes, catalogIndex, catalogTreeText, catalogGroupText, catalogInstrumentText, catalogInstrumentsText,
  parsePresetAlias, resolvePresetAlias, findInstrument, canonVariant, OTHER_GROUP
} = await import("../src/catalog.js");

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const all = () => true;
console.log("aria 카탈로그 테스트");

ok("클립을 뺀 모든 프리셋이 그룹에 배정됨", () => {
  const unassigned = catalogNodes().filter(n => n.kind !== "clip" && n.group === OTHER_GROUP);
  assert.deepEqual(unassigned.map(n => `${n.family}:${n.id}`), []);
  const entries = [...catalogIndex().values()];
  assert.ok(entries.filter(e => e.kind === "instrument").length >= 40);
  assert.ok(entries.every(e => e.nodes.every(n => n.kind !== "clip")), "카탈로그 항목에 클립이 섞임");
});

ok("트리 요약은 이름만 싣고 짧다", () => {
  const text = catalogTreeText(all);
  assert.match(text, /연주용 악기 — 그룹 8개/);
  assert.match(text, /드럼·타악 — 그룹 6개/);
  assert.match(text, /현악: Violin\(solo·section\) · Viola/);
  for (const id of ["vsco-solo-violin-vibrato", "sf-piano", "salamander-all-full"]) assert.ok(!text.includes(id), `요약에 ID ${id}`);
  assert.ok(text.split("\n").length <= 20);
  assert.match(catalogTreeText(() => false), /Grand Piano\(미설치\)/);
});

ok("악기 표는 독주/섹션 × 주법 × 출처로 접히고 ★가 기본값", () => {
  const violin = catalogInstrumentText("Violin", all);
  assert.match(violin, /^Violin — 현악 · 프리셋 \d+개 · 출처 VSCO 2 CE·Philharmonia·GM/);
  assert.match(violin, /\n  solo\n\s+sustain: ★vsco-solo-violin-vibrato · sf-violin-phil\(\+\d+ Philharmonia\) · sf-violin/);
  assert.match(violin, /\n  section\n\s+sustain: ★vsco-violin-ensemble-sustain-vibrato/);
  assert.match(violin, /그 밖의 주법: .*col-legno-battuto/);
  assert.match(violin, /계층 ID\(add_track preset에 그대로\): violin\/solo\/sustain/);
  assert.ok(violin.split("\n").length < 30);
  const kit = catalogInstrumentText("Salamander Drumkit", all);
  assert.match(kit, /complete-mapped-kit: ★salamander-all-full · pitch: kick-1, kick-2/);
  const missing = catalogInstrumentText("Grand Piano", id => id === "sf-piano-gm");
  assert.match(missing, /sustain: ★sf-piano-gm · sf-piano\(미설치\)/, "미설치 음원은 ★를 받지 않는다");
  assert.match(catalogInstrumentsText(["Flute", "없음"], all), /Flute — 목관[\s\S]*✗ 없음: 악기 "없음"/);
});

ok("그룹 뷰는 핵심 주법 이름과 나머지 개수만", () => {
  const winds = catalogGroupText("목관", all);
  assert.match(winds, /^목관 — 악기 9개/);
  assert.match(winds, /Flute: solo — sustain, expressive-vibrato, sustain-non-vibrato, staccato, tremolo, keyswitch \(\+그 밖의 주법 \d+\)/);
  assert.ok(!winds.includes("vsco-"));
  assert.throws(() => catalogGroupText("없는 그룹"), /그룹: 건반·오르간/);
});

ok("악기 이름은 정확한 이름·별칭·복수형·한국어·유일한 부분 일치로 찾음", () => {
  assert.equal(findInstrument("Violin").entry.name, "Violin");
  assert.equal(findInstrument("double-bass").entry.name, "Double Bass");
  assert.equal(findInstrument("contrabass").entry.name, "Double Bass");
  assert.equal(findInstrument("horn").entry.name, "French Horn");
  assert.equal(findInstrument("호른").entry.name, "French Horn");
  assert.equal(findInstrument("cellos").plural, true);
  assert.equal(findInstrument("Glockenspiel").entry.group, "음정 타악");
  assert.throws(() => findInstrument("bass"), /후보: /);
  assert.throws(() => findInstrument("zither"), /찾을 수 없습니다/);
});

ok("계층 ID 문법", () => {
  assert.deepEqual(parsePresetAlias("violin/section/sustain"), { instrument: "violin", unit: "section", variant: "sustain" });
  assert.deepEqual(parsePresetAlias("cello/pizz"), { instrument: "cello", unit: null, variant: "pizz" });
  assert.deepEqual(parsePresetAlias(" Double Bass / Solo "), { instrument: "Double Bass", unit: "solo", variant: null });
  assert.equal(parsePresetAlias("a/b/c/d"), null);
  assert.equal(parsePresetAlias("violin/solo/section"), null);
  assert.equal(parsePresetAlias(42), null);
  assert.equal(canonVariant("Arco-Normal"), "sustain");
  assert.equal(canonVariant("con-sord"), "sordino");
});

ok("해석 규칙: 주법 등급 → 출처 순서 → 권장 → 녹음 길이, 미설치는 건너뜀", () => {
  const r = resolvePresetAlias("violin/section/sustain", all);
  assert.equal(r.id, "vsco-violin-ensemble-sustain-vibrato");
  assert.deepEqual([r.instrument, r.unit, r.variant, r.source], ["Violin", "section", "sustain-vibrato", "VSCO 2 CE"]);
  assert.equal(resolvePresetAlias("violin", all).id, "vsco-solo-violin-vibrato");
  assert.equal(resolvePresetAlias("violins", all).id, "vsco-violin-ensemble-sustain-vibrato");
  assert.equal(resolvePresetAlias("flute", all).id, "vsco-flute-sustain-vibrato");
  assert.equal(resolvePresetAlias("flute/staccato", all).id, "vsco-flute-staccato");
  assert.equal(resolvePresetAlias("bass clarinet/staccato", all).id, "philharmonia-bass-clarinet-staccato-025-02a5644518");
  assert.equal(resolvePresetAlias("trumpet/muted", all).id, "vsco-trumpet-harmon-mute-sustain");
  assert.equal(resolvePresetAlias("harp", all).id, "vsco-harp-natural");
  assert.equal(resolvePresetAlias("piano", all).id, "sf-piano");
  assert.equal(resolvePresetAlias("drum kit", all).id, "salamander-all-full", "권장 표시가 있는 전체 킷");
  assert.equal(resolvePresetAlias("orchestral percussion", all).id, "sf-orch-kit-phil", "같은 kit 변형이면 Philharmonia가 GM보다 앞");
  assert.equal(resolvePresetAlias("violin/harmonic", all).id, "philharmonia-violin-natural-harmonic-1-2ae4542bfc");
  assert.equal(resolvePresetAlias("clarinet", id => id.startsWith("sf-")).id, "sf-clarinet-phil");
  assert.equal(resolvePresetAlias("clarinet", id => id === "sf-clarinet").id, "sf-clarinet");
  assert.throws(() => resolvePresetAlias("clarinet", () => false), /설치되지 않았습니다/);
  assert.throws(() => resolvePresetAlias("flute/section", all), /section 음원이 없습니다 — 있는 편성: solo/);
  assert.throws(() => resolvePresetAlias("violin/solo/roll", all), /"roll" 주법 음원이 없습니다 — 있는 주법: /);
  assert.throws(() => resolvePresetAlias("sf-violn", all), /list_presets/);
  assert.throws(() => resolvePresetAlias("organ", all), /후보: Drawbar Organ, Pipe Organ/);
  assert.deepEqual(resolvePresetAlias("piano", all).alternatives, ["sf-piano-gm"]);
});

console.log(`\n${passed}개 통과`);

// aria — 음원 카탈로그의 계층 뷰와 계층 ID 해석.
//
// 프리셋 정의는 presets.js가 소유한다. 이 모듈은 그 위에
//   그룹 → 악기 → 독주/섹션 → 주법·변형 → 출처 → 실제 프리셋 ID
// 탐색 구조와 "violin/section/sustain" 같은 계층 ID를 실제 ID로 푸는 규칙만 얹는다.
// 곡에는 언제나 해석된 실제 ID가 저장되므로, 음원을 새로 설치해도 기존 곡의 소리는 바뀌지 않는다.
import { SF_PRESETS, SF_DRUM_KITS, DRUM_PIECES } from "./presets.js";

// 같은 주법의 음원이 여럿일 때 기본으로 고르는 순서 — 벨로시티 다층 SFZ를 앞에 둔다.
const SOURCE_RANK = { "VSCO 2 CE": 0, Salamander: 1, Philharmonia: 2, VSCO: 3, GM: 4 };
const sourceRank = source => SOURCE_RANK[source] ?? 9;

// family 이름이 악기와 주법·변형을 함께 담고 있는 경우 → [악기, 변형]
const FAMILY_TO_INSTRUMENT = {
  "Violin Pizzicato": ["Violin", "pizzicato"],
  "Viola Pizzicato": ["Viola", "pizzicato"],
  "Cello Pizz": ["Cello", "pizzicato"],
  "Double Bass Pizzicato": ["Double Bass", "pizzicato"],
  "Violin Sordino": ["Violin", "sordino"],
  "Orchestral Harp": ["Harp"],
  "Piano": ["Upright Piano"],
  "Alto Sax": ["Saxophone"],
  "Tine E.Piano": ["Electric Piano", "tine"],
  "Electric Piano 2": ["Electric Piano", "fm"],
  "New Age Pad": ["Synth Pad", "new-age"],
  "Warm Pad": ["Synth Pad", "warm"],
  "Square Lead": ["Synth Lead", "square"],
  "Saw Lead": ["Synth Lead", "saw"],
  "Synth Bass 1": ["Synth Bass"],
  "Pizzicato Pluck": ["Pluck"],
  "Organ": ["Pipe Organ"]
};

// 첫 화면에 보이는 그룹. 이름은 용도 힌트 없는 중립 명사만 쓴다.
export const INSTRUMENT_GROUPS = [
  ["건반·오르간", ["Grand Piano", "Upright Piano", "Electric Piano", "Drawbar Organ", "Pipe Organ", "Tango Accordion", "Music Box"]],
  ["기타·베이스·하프", ["Nylon Guitar", "Steel Guitar", "Guitar", "Finger Bass", "Harp", "Banjo", "Mandolin"]],
  ["현악", ["Violin", "Viola", "Cello", "Double Bass", "String Ensemble"]],
  ["목관", ["Flute", "Piccolo", "Oboe", "English Horn", "Clarinet", "Bass Clarinet", "Bassoon", "Contrabassoon", "Saxophone"]],
  ["금관", ["Trumpet", "French Horn", "Trombone", "Tuba", "Brass Section"]],
  ["음정 타악", ["Glockenspiel", "Marimba", "Xylophone", "Vibraphone", "Tubular Bells", "Timpani"]],
  ["신스·패드", ["Synth Pad", "Synth Lead", "Synth Bass", "Pluck"]],
  ["합창", ["Choir Aahs"]]
];
export const PERCUSSION_GROUPS = [
  ["드럼 세트·타악 킷", ["Studio Kit", "Electronic Kit", "Brush Kit", "Band Kit", "Salamander Drumkit", "Orchestral Percussion", "Percussion"]],
  ["개별 드럼", ["Bass Drum", "Snare Drum", "Tenor Drum", "Tom-toms", "Djembe", "Djundjun", "Surdo"]],
  ["심벌·공", ["Clash Cymbals", "Suspended Cymbal", "Sizzle Cymbal", "Chinese Cymbal", "Chinese Hand Cymbals", "Tam-tam", "Thai Gong"]],
  ["벨·금속", ["Agogo Bells", "Bell Tree", "Cowbell", "Triangle", "Wind Chimes", "Sleigh Bells"]],
  ["셰이커·소형 타악", ["Banana Shaker", "Lemon Shaker", "Strawberry Shaker", "Sheep's Toenails", "Tambourine", "Castanets", "Woodblock", "Guiro", "Ratchet", "Vibraslap", "Washboard"]],
  ["효과", ["Flexatone", "Spring Coil", "Whip", "Motor Horn", "Squeaker", "Train Whistle"]]
];
export const OTHER_GROUP = "기타";

// 주법 이름 정규화 — 출처마다 다른 표기를 한 이름으로. 원래 ID는 그대로 남는다.
const VARIANT_CANON = {
  normal: "sustain", natural: "sustain", mute: "muted", stac: "staccato", short: "staccato",
  "con-sord": "sordino", "pizz-normal": "pizzicato", "non-vibrato": "sustain-non-vibrato"
};
export function canonVariant(raw) {
  const v = String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/^arco-/, "");
  return VARIANT_CANON[v] ?? v;
}
// 요청한 주법 이름에 허용되는 실제 주법 — 앞에 있을수록 우선
// 요청한 주법 이름에 허용되는 실제 주법을 등급별로 — 같은 등급 안에서는 출처 순서가 결정한다.
// 독주 바이올린의 "vibrato"와 섹션의 "sustain-vibrato"는 그 음원의 기본 지속음이므로 sustain과 같은 등급이다.
const VARIANT_ALIASES = {
  sustain: [["sustain", "sustain-vibrato", "vibrato", "hit"], ["expressive-vibrato", "sustain-non-vibrato", "loud"], ["sustain-vibrato-quiet", "vibrato-quiet", "quiet"]],
  vibrato: [["vibrato", "sustain-vibrato"], ["expressive-vibrato", "molto-vibrato"], ["vibrato-quiet", "sustain-vibrato-quiet"]],
  "sustain-non-vibrato": [["sustain-non-vibrato"], ["sustain"]],
  quiet: [["sustain-vibrato-quiet", "vibrato-quiet", "quiet"]],
  pizzicato: [["pizzicato"]],
  staccato: [["staccato"], ["spiccato"]],
  spiccato: [["spiccato"], ["staccato"]],
  tremolo: [["tremolo"]],
  sordino: [["sordino", "muted"], ["straight-mute-sustain", "harmon-mute-sustain"]],
  muted: [["muted", "sordino"], ["straight-mute-sustain", "harmon-mute-sustain"]],
  roll: [["roll"]],
  hit: [["hit", "struck-singly"], ["sustain"]],
  keyswitch: [["keyswitch"]],
  harmonic: [["harmonic", "harmonics", "natural-harmonic"], ["artificial-harmonic"]],
  trill: [["major-trill", "minor-trill"]],
  pedal: [["loud-pedal", "quiet-pedal"]]
};
// 표에서 한 줄로 합쳐 보이는 주법 — 그 음원의 기본 지속음들
const DISPLAY_VARIANT = { "sustain-vibrato": "sustain", vibrato: "sustain" };
const displayVariant = v => DISPLAY_VARIANT[v] ?? v;
const VARIANT_SYNONYMS = {
  legato: "sustain", long: "sustain", normale: "sustain", "non-vibrato": "sustain-non-vibrato", senza: "sustain-non-vibrato", "senza-vibrato": "sustain-non-vibrato",
  soft: "quiet", pizz: "pizzicato", trem: "tremolo", mute: "muted", "con-sordino": "sordino", struck: "hit",
  ks: "keyswitch", harmonics: "harmonic", "major-trill": "major-trill", "minor-trill": "minor-trill"
};
// 악기 표에 한 줄씩 보이는 주법. 그 밖의 Philharmonia 전용 특수 주법은 한 줄로 접는다.
const CORE_VARIANTS = new Set([
  "sustain", "sustain-vibrato", "vibrato", "expressive-vibrato", "sustain-non-vibrato", "sustain-vibrato-quiet", "vibrato-quiet",
  "pizzicato", "staccato", "spiccato", "tremolo", "sordino", "muted", "roll", "hit", "keyswitch"
]);
const VARIANT_ORDER = ["sustain", "sustain-vibrato", "vibrato", "expressive-vibrato", "sustain-non-vibrato", "sustain-vibrato-quiet",
  "vibrato-quiet", "pizzicato", "staccato", "spiccato", "tremolo", "sordino", "muted", "roll", "hit"];
const UNIT_WORDS = { solo: "solo", section: "section", ensemble: "section", tutti: "section", ens: "section", 독주: "solo", 섹션: "section", 합주: "section" };

// Philharmonia 원본은 같은 주법을 녹음 길이별로 여러 프리셋으로 둔다 — 긴 것을 기본으로.
const LENGTH_ORDER = { "025": 0, "05": 1, "1": 2, "15": 3, long: 4, "very-long": 5 };
function lengthRankOf(id) {
  const m = /-(025|05|1|15|long|very-long)-[0-9a-f]{8,}$/.exec(id);
  return m ? LENGTH_ORDER[m[1]] : 6;
}

export function normalizeName(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
const slug = text => normalizeName(text).replace(/ /g, "-");

// 이름 별칭 — 정규화된 표기 기준. 한국어 악기 이름도 받는다.
const SYNONYMS = {
  contrabass: "double bass", "contra bass": "double bass", "upright bass": "double bass", "string bass": "double bass",
  horn: "french horn", "cor anglais": "english horn",
  sax: "saxophone", "alto sax": "saxophone", "alto saxophone": "saxophone",
  strings: "string ensemble", "string section": "string ensemble",
  piano: "grand piano", "acoustic piano": "grand piano",
  "e piano": "electric piano", epiano: "electric piano", rhodes: "electric piano",
  timp: "timpani", glock: "glockenspiel", vibes: "vibraphone", brass: "brass section", choir: "choir aahs",
  pad: "synth pad", lead: "synth lead", "drum kit": "salamander drumkit", drumkit: "salamander drumkit", "acoustic drums": "salamander drumkit",
  "808": "electronic kit", "electronic drums": "electronic kit",
  바이올린: "violin", 비올라: "viola", 첼로: "cello", 콘트라베이스: "double bass", 더블베이스: "double bass",
  플루트: "flute", 피콜로: "piccolo", 오보에: "oboe", 잉글리시호른: "english horn", 클라리넷: "clarinet",
  베이스클라리넷: "bass clarinet", 바순: "bassoon", 콘트라바순: "contrabassoon", 색소폰: "saxophone",
  트럼펫: "trumpet", 호른: "french horn", 프렌치호른: "french horn", 트롬본: "trombone", 튜바: "tuba",
  하프: "harp", 팀파니: "timpani", 피아노: "grand piano", 그랜드피아노: "grand piano", 업라이트피아노: "upright piano",
  현악: "string ensemble", 현악합주: "string ensemble", 금관: "brass section", 합창: "choir aahs",
  글로켄슈필: "glockenspiel", 마림바: "marimba", 실로폰: "xylophone", 비브라폰: "vibraphone", 튜블러벨: "tubular bells",
  기타: "guitar", 나일론기타: "nylon guitar", 만돌린: "mandolin", 밴조: "banjo", 아코디언: "tango accordion", 오르골: "music box",
  드럼: "salamander drumkit", 드럼킷: "salamander drumkit", 스네어: "snare drum", 베이스드럼: "bass drum", 심벌: "clash cymbals",
  트라이앵글: "triangle", 탬버린: "tambourine", 캐스터네츠: "castanets", 우드블록: "woodblock", 탐탐: "tam-tam"
};

let CATALOG = null;
function build() {
  const nodes = [];
  const add = (id, spec, kit) => {
    const kind = spec.kind === "clip" ? "clip" : kit ? "percussion" : "instrument";
    let instrument = spec.family ?? "Other", familyVariant = null;
    if (!kit && FAMILY_TO_INSTRUMENT[instrument]) [instrument, familyVariant = null] = FAMILY_TO_INSTRUMENT[instrument];
    const rawVariant = spec.articulation ?? familyVariant ?? (kit && !spec.articulation ? "kit" : "sustain");
    const text = `${spec.name ?? ""} ${spec.family ?? ""}`;
    const unit = kind !== "instrument" ? null
      : (/-ensemble-/.test(id) || /\b(section|ensemble|strings|choir|aahs)\b/i.test(text)) ? "section" : "solo";
    const groups = kit ? PERCUSSION_GROUPS : INSTRUMENT_GROUPS;
    const group = kind === "clip" ? "녹음 클립" : (groups.find(([, names]) => names.includes(instrument))?.[0] ?? OTHER_GROUP);
    nodes.push({
      id, spec, kit, kind, family: spec.family, instrument, group, unit,
      variant: canonVariant(rawVariant), source: spec.source ?? "기타", sourceRank: sourceRank(spec.source),
      lengthRank: lengthRankOf(id), recommended: spec.recommended === true,
      keyswitch: canonVariant(rawVariant) === "keyswitch" || Boolean(spec.articulations && Object.keys(spec.articulations).length > 1),
      pieces: kit && kind !== "clip" ? Object.keys(spec.pieces ?? DRUM_PIECES) : null
    });
  };
  for (const [id, spec] of Object.entries(SF_PRESETS)) add(id, spec, false);
  for (const [id, spec] of Object.entries(SF_DRUM_KITS)) add(id, spec, true);
  const index = new Map();
  for (const node of nodes) {
    if (node.kind === "clip") continue;
    const key = normalizeName(node.instrument);
    if (!index.has(key)) index.set(key, { key, name: node.instrument, kind: node.kind, group: node.group, nodes: [], units: new Set() });
    const entry = index.get(key);
    entry.nodes.push(node);
    if (node.unit) entry.units.add(node.unit);
  }
  return { nodes, index };
}
export function catalogNodes() { return (CATALOG ??= build()).nodes; }
export function catalogIndex() { return (CATALOG ??= build()).index; }

// 악기 이름 → 카탈로그 항목. 정확한 이름·별칭·복수형·유일한 부분 일치 순으로 찾고, 애매하면 후보를 알려준다.
export function findInstrument(name) {
  const norm = normalizeName(name);
  if (!norm) throw new Error("악기 이름이 비어 있습니다");
  const index = catalogIndex();
  const lookup = key => index.get(key) ?? index.get(SYNONYMS[key] ?? "") ?? null;
  const direct = lookup(norm) ?? lookup(norm.replace(/ /g, ""));
  if (direct) return { entry: direct, plural: false };
  if (norm.endsWith("s")) {
    const singular = lookup(norm.slice(0, -1)) ?? lookup(norm.replace(/(e?s)\b/g, ""));
    if (singular) return { entry: singular, plural: true };
  }
  const partial = [...index.values()].filter(e => e.key.includes(norm) || norm.includes(e.key));
  if (partial.length === 1) return { entry: partial[0], plural: false };
  const hint = partial.length
    ? `후보: ${partial.map(e => e.name).join(", ")}`
    : "list_presets()의 악기 목록에서 이름을 확인하세요";
  throw new Error(`악기 "${name}"을(를) 찾을 수 없습니다 — ${hint}`);
}

// "violin/section/sustain" · "flute" · "cello/pizzicato" · "violins" → {instrument, unit, variant}
export function parsePresetAlias(ref) {
  if (typeof ref !== "string") return null;
  const parts = ref.split("/").map(s => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > 3) return null;
  const [instrument, ...rest] = parts;
  let unit = null, variant = null;
  for (const part of rest) {
    const key = slug(part);
    if (UNIT_WORDS[key]) { if (unit) return null; unit = UNIT_WORDS[key]; }
    else { if (variant) return null; variant = key; }
  }
  return { instrument, unit, variant };
}

function wantedVariants(variantKey) {
  const canon = canonVariant(VARIANT_SYNONYMS[variantKey] ?? variantKey);
  return VARIANT_ALIASES[canon] ?? [[canon]];
}
const flatWanted = tiers => tiers.flat();
// 후보 정렬 — 요청 주법과의 등급 거리, 키스위치 여부, 출처, 권장 표시, 녹음 길이 순
const variantScore = (node, tiers) => {
  const tier = tiers.findIndex(t => t.includes(node.variant));
  if (tier >= 0) return tier;
  return flatWanted(tiers).some(w => node.variant.includes(w)) ? tiers.length : -1;
};
const compareNodes = (a, b) => a.score - b.score || a.node.sourceRank - b.node.sourceRank
  || Number(b.node.recommended) - Number(a.node.recommended) || b.node.lengthRank - a.node.lengthRank || a.node.id.localeCompare(b.node.id);
function rank(nodes, wanted, { allowKeyswitch = false } = {}) {
  return nodes.map(node => {
    const score = wanted ? variantScore(node, wanted) : 0;
    return { node, score: score < 0 ? -1 : score + (node.keyswitch && !allowKeyswitch ? 0.5 : 0) };
  }).filter(x => x.score >= 0).sort(compareNodes).map(x => x.node);
}

// 계층 ID → 실제 프리셋 ID. isAvailable(id)가 false인 음원은 고르지 않고, 없으면 설치 안내로 실패한다.
export function resolvePresetAlias(ref, isAvailable = () => true) {
  const parsed = parsePresetAlias(ref);
  if (!parsed) throw new Error(`preset "${ref}"이 없습니다 — 실제 ID는 list_presets로, 계층 ID는 "악기/독주|섹션/주법" 형식(예: violin/section/sustain)으로 지정하세요`);
  const { entry, plural } = findInstrument(parsed.instrument);
  let unit = parsed.unit;
  if (unit && entry.units.size && !entry.units.has(unit))
    throw new Error(`"${entry.name}"에는 ${unit} 음원이 없습니다 — 있는 편성: ${[...entry.units].join(", ")}. 다른 편성으로 바꾸지 않았습니다`);
  if (!unit && entry.units.size > 1) unit = plural ? "section" : "solo";
  const variantKey = parsed.variant ?? null;
  const allowKeyswitch = variantKey ? flatWanted(wantedVariants(variantKey)).includes("keyswitch") : false;
  const pool = entry.nodes.filter(n => !unit || !n.unit || n.unit === unit);
  let ranked;
  if (variantKey) {
    ranked = rank(pool, wantedVariants(variantKey), { allowKeyswitch });
    if (!ranked.length) {
      const have = [...new Set(pool.map(n => n.variant))].sort().join(", ");
      throw new Error(`"${entry.name}${unit ? "/" + unit : ""}"에 "${parsed.variant}" 주법 음원이 없습니다 — 있는 주법: ${have}. list_presets({instruments:["${entry.name}"]})로 확인하세요`);
    }
  } else {
    // 주법을 안 주면 sustain 계열을 우선하고, 없는 악기(킷·타악)는 전체에서 고른다
    ranked = rank(pool, VARIANT_ALIASES.sustain, { allowKeyswitch });
    if (!ranked.length) ranked = rank(pool, null, { allowKeyswitch });
  }
  const available = ranked.filter(n => isAvailable(n.id));
  if (!available.length)
    throw new Error(`"${ref}"에 맞는 음원 ${ranked[0].id}${ranked.length > 1 ? ` 등 ${ranked.length}개` : ""}가 설치되지 않았습니다 — 음원 관리에서 설치하거나 다른 음원을 고르세요. 자동으로 대체하지 않습니다`);
  const best = available[0];
  const alias = `${slug(entry.name)}${best.unit ? "/" + best.unit : ""}/${variantKey ? canonVariant(VARIANT_SYNONYMS[variantKey] ?? variantKey) : displayVariant(best.variant)}`;
  return {
    id: best.id, alias, instrument: entry.name, unit: best.unit, variant: best.variant, source: best.source,
    alternatives: available.slice(1, 4).map(n => n.id)
  };
}

// ---------- 텍스트 뷰 ----------
// 표에 한 줄로 실을 주법: 기본 주법이거나, Philharmonia 원본 길이 변형만이 아닌 음원이 하나라도 있는 것
const isCoreRow = (variant, nodes) => CORE_VARIANTS.has(variant)
  || nodes.some(n => !n.keyswitch && !(n.source === "Philharmonia" && n.lengthRank < 6));
const variantOrder = v => { const i = VARIANT_ORDER.indexOf(v); return i < 0 ? VARIANT_ORDER.length : i; };
const unitOrder = { solo: 0, section: 1, null: 2 };
const sortVariants = variants => [...variants].sort((a, b) => variantOrder(a) - variantOrder(b) || a.localeCompare(b));

function instrumentUnitsLabel(entry) {
  if (!entry.units.size) return "";
  return entry.units.size > 1 ? "(solo·section)" : entry.units.has("section") ? "(section)" : "";
}
function entryAvailable(entry, isAvailable) { return entry.nodes.some(n => isAvailable(n.id)); }

// 인자 없는 요약 — 그룹과 악기 이름만. 프리셋 ID는 한 개도 싣지 않는다.
export function catalogTreeText(isAvailable = () => true) {
  const index = catalogIndex();
  const byGroup = new Map();
  for (const entry of index.values()) {
    if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
    byGroup.get(entry.group).push(entry);
  }
  const lines = [];
  const render = (groups, kind) => {
    for (const [group, names] of groups) {
      const entries = (byGroup.get(group) ?? []).filter(e => e.kind === kind);
      if (!entries.length) continue;
      entries.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
      lines.push(`  ${group}: ${entries.map(e => {
        const count = e.kind === "percussion" && e.nodes.length > 1 ? `(${e.nodes.length})` : instrumentUnitsLabel(e);
        return `${e.name}${count}${entryAvailable(e, isAvailable) ? "" : "(미설치)"}`;
      }).join(" · ")}`);
    }
    const others = (byGroup.get(OTHER_GROUP) ?? []).filter(e => e.kind === kind);
    if (others.length) lines.push(`  ${OTHER_GROUP}: ${others.map(e => e.name).join(" · ")}`);
  };
  const instrumentCount = [...index.values()].filter(e => e.kind === "instrument").length;
  const percussionCount = [...index.values()].filter(e => e.kind === "percussion").length;
  lines.push(`연주용 악기 — 그룹 ${INSTRUMENT_GROUPS.length}개 · 악기 ${instrumentCount}개:`);
  render(INSTRUMENT_GROUPS, "instrument");
  lines.push(`드럼·타악 — 그룹 ${PERCUSSION_GROUPS.length}개 · ${percussionCount}종:`);
  render(PERCUSSION_GROUPS, "percussion");
  return lines.join("\n");
}

// 한 그룹의 악기와 주법 이름 — 중간 단계
export function catalogGroupText(groupName, isAvailable = () => true) {
  const norm = normalizeName(groupName);
  const all = [...INSTRUMENT_GROUPS, ...PERCUSSION_GROUPS].map(([g]) => g);
  const group = all.find(g => normalizeName(g) === norm) ?? all.filter(g => normalizeName(g).includes(norm));
  const chosen = Array.isArray(group) ? (group.length === 1 ? group[0] : null) : group;
  if (!chosen) throw new Error(`그룹 "${groupName}"을(를) 찾을 수 없습니다 — 그룹: ${all.join(", ")}`);
  const entries = [...catalogIndex().values()].filter(e => e.group === chosen);
  const lines = [`${chosen} — 악기 ${entries.length}개`];
  for (const entry of entries) {
    const byUnit = new Map();
    for (const node of entry.nodes) {
      const key = node.unit ?? "";
      if (!byUnit.has(key)) byUnit.set(key, new Map());
      const variant = displayVariant(node.variant);
      if (!byUnit.get(key).has(variant)) byUnit.get(key).set(variant, []);
      byUnit.get(key).get(variant).push(node);
    }
    const parts = [...byUnit].sort((a, b) => unitOrder[a[0] || null] - unitOrder[b[0] || null])
      .map(([unit, variants]) => {
        const core = sortVariants([...variants].filter(([v, nodes]) => isCoreRow(v, nodes)).map(([v]) => v));
        const rest = variants.size - core.length;
        return `${unit ? unit + " — " : ""}${core.join(", ")}${rest ? ` (+그 밖의 주법 ${rest})` : ""}`;
      });
    lines.push(`  ${entry.name}${entryAvailable(entry, isAvailable) ? "" : "(미설치)"}: ${parts.join(" · ")}`);
  }
  lines.push(`다음: list_presets({instruments:[${entries.slice(0, 2).map(e => JSON.stringify(e.name)).join(", ")}]}) 또는 add_track의 preset에 "${slug(entries[0]?.name ?? "violin")}/sustain" 같은 계층 ID`);
  return lines.join("\n");
}

// 악기 하나의 표 — 독주/섹션 × 주법 × 출처 → 실제 ID. ★가 계층 ID 해석 결과다.
export function catalogInstrumentText(name, isAvailable = () => true) {
  const { entry } = findInstrument(name);
  const mark = id => `${id}${isAvailable(id) ? "" : "(미설치)"}`;
  const rows = new Map(); // `${unit}|${displayVariant}` → nodes
  for (const node of entry.nodes) {
    const key = `${node.unit ?? ""}|${displayVariant(node.variant)}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(node);
  }
  const sources = [...new Set(entry.nodes.map(n => n.source))].sort((a, b) => sourceRank(a) - sourceRank(b));
  const lines = [`${entry.name} — ${entry.group} · 프리셋 ${entry.nodes.length}개 · 출처 ${sources.join("·")}`];
  const units = [...new Set(entry.nodes.map(n => n.unit ?? ""))].sort((a, b) => unitOrder[a || null] - unitOrder[b || null]);
  const aliases = [];
  for (const unit of units) {
    const unitRows = [...rows].filter(([key]) => key.startsWith(`${unit}|`));
    const variants = sortVariants(unitRows.map(([key]) => key.split("|")[1]));
    if (unit) lines.push(`  ${unit}`);
    const special = [];
    for (const variant of variants) {
      const nodes = rows.get(`${unit}|${variant}`);
      const keyswitchNodes = nodes.filter(n => n.keyswitch);
      const plain = nodes.filter(n => !n.keyswitch);
      if (!isCoreRow(variant, plain) && !keyswitchNodes.length) { special.push(`${variant}(${nodes.length})`); continue; }
      const indent = unit ? "    " : "  ";
      if (plain.length) {
        const ranked = rank(plain, VARIANT_ALIASES[variant] ?? null);
        const best = ranked.find(n => isAvailable(n.id)) ?? ranked[0];
        const bySource = new Map();
        for (const n of ranked) { if (n === best) continue; if (!bySource.has(n.source)) bySource.set(n.source, []); bySource.get(n.source).push(n); }
        const extraSame = ranked.filter(n => n !== best && n.source === best.source).length;
        const alternates = [...bySource].filter(([source]) => source !== best.source)
          .map(([source, list]) => `${mark(list[0].id)}${list.length > 1 ? `(+${list.length - 1} ${source})` : ""}`);
        const pieces = best.pieces ? ` · pitch: ${best.pieces.slice(0, 24).join(", ")}${best.pieces.length > 24 ? ` … 외 ${best.pieces.length - 24}개` : ""}` : "";
        lines.push(`${indent}${variant}: ★${mark(best.id)}${extraSame ? `(+${extraSame} ${best.source})` : ""}${alternates.length ? ` · ${alternates.join(" · ")}` : ""}${pieces}`);
        aliases.push(`${slug(entry.name)}${unit ? "/" + unit : ""}/${variant}`);
      }
      for (const n of keyswitchNodes) {
        const arts = Object.entries(n.spec.articulations ?? {})
          .map(([k, v]) => `${k}=${v.label ?? k}${k === n.spec.defaultArticulation ? "(기본)" : ""}`).join(" · ");
        lines.push(`${indent}keyswitch: ${mark(n.id)} → ${arts}`);
      }
    }
    if (special.length) lines.push(`${unit ? "    " : "  "}그 밖의 주법: ${special.join(", ")} — query로 검색`);
  }
  if (aliases.length) lines.push(`  계층 ID(add_track preset에 그대로): ${aliases.slice(0, 8).join(", ")}${aliases.length > 8 ? ` 외 ${aliases.length - 8}개` : ""} — ★가 해석 결과`);
  return lines.join("\n");
}

export function catalogInstrumentsText(names, isAvailable = () => true) {
  return names.map(name => {
    try { return catalogInstrumentText(name, isAvailable); }
    catch (e) { return `✗ ${name}: ${e.message}`; }
  }).join("\n\n");
}

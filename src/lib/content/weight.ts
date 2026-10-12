// Reading an item's weight from the words a source wrote for it (issue #205).
//
// One reader for every door a weight comes in by: the Open5e importer
// (scripts/lib/open5e-normalize.mjs), the server reading a pack row
// (src/lib/content/item-weights.ts, the item search), and a workshop copy of
// a catalog item (src/app/workshop/homebrew/draft.ts). It is pure, with no
// "@/" imports, so the plain Node scripts can load it directly.
//
// The reader it replaces kept only digits and dots, so "1/4 lb." became 14 lb
// and ten darts weighed 140 lb. A text it cannot read is now UNKNOWN, with
// the reason, never a number made from whatever digits it held.

export type WeightReading = {
  // Pounds; null when the source states none or states one this cannot read.
  pounds: number | null;
  // Why a stated weight could not be read; null when it was read or absent.
  problem: string | null;
};

const POUNDS_PER: Record<string, number> = {
  lb: 1,
  lbs: 1,
  pound: 1,
  pounds: 1,
  oz: 1 / 16,
  ounce: 1 / 16,
  ounces: 1 / 16,
  kg: 2.20462,
  kgs: 2.20462,
  kilogram: 2.20462,
  kilograms: 2.20462,
  g: 0.00220462,
  gram: 0.00220462,
  grams: 0.00220462,
};

const VULGAR: Record<string, string> = {
  "¼": "1/4",
  "½": "1/2",
  "¾": "3/4",
  "⅓": "1/3",
  "⅔": "2/3",
  "⅕": "1/5",
  "⅖": "2/5",
  "⅗": "3/5",
  "⅘": "4/5",
  "⅙": "1/6",
  "⅚": "5/6",
  "⅛": "1/8",
  "⅜": "3/8",
  "⅝": "5/8",
  "⅞": "7/8",
};

// "8", "0.075", "1,000", "1/4", "1 1/2", "1-1/2", then an optional unit and
// the period a book puts after "lb".
const AMOUNT = /^(?:(\d+)[\s-]+(\d+)\s*\/\s*(\d+)|(\d+)\s*\/\s*(\d+)|(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+))\s*([a-z]+)?\.?$/i;

// Four places keep a sling bullet at 0.075 lb, where two made it 0.08.
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function unitFactor(unit: unknown): number | null {
  const word = String(unit ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!word) {
    return 1;
  }
  return POUNDS_PER[word] ?? null;
}

export function readWeightLb(raw: unknown, unit?: unknown): WeightReading {
  if (raw === null || raw === undefined) {
    return { pounds: null, problem: null };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) {
      return { pounds: null, problem: `not a weight: ${raw}` };
    }
    const factor = unitFactor(unit);
    return factor === null
      ? { pounds: null, problem: `unknown unit "${String(unit)}"` }
      : { pounds: round4(raw * factor), problem: null };
  }
  let text = String(raw).trim();
  // A dash is how the books print "no weight worth counting".
  if (!text || /^[-‐‑–—]+$/.test(text)) {
    return { pounds: null, problem: null };
  }
  for (const [glyph, fraction] of Object.entries(VULGAR)) {
    text = text.replace(new RegExp(`(\\d)${glyph}`, "g"), `$1 ${fraction}`).replace(new RegExp(glyph, "g"), fraction);
  }
  const match = AMOUNT.exec(text);
  if (!match) {
    return { pounds: null, problem: `unreadable weight "${String(raw)}"` };
  }
  let amount: number;
  if (match[1] !== undefined) {
    const denominator = Number(match[3]);
    if (!denominator) {
      return { pounds: null, problem: `unreadable weight "${String(raw)}"` };
    }
    amount = Number(match[1]) + Number(match[2]) / denominator;
  } else if (match[4] !== undefined) {
    const denominator = Number(match[5]);
    if (!denominator) {
      return { pounds: null, problem: `unreadable weight "${String(raw)}"` };
    }
    amount = Number(match[4]) / denominator;
  } else {
    amount = Number(match[6].replace(/,/g, ""));
  }
  if (!Number.isFinite(amount)) {
    return { pounds: null, problem: `unreadable weight "${String(raw)}"` };
  }
  // The text's own unit first ("2 kg"), then the field beside it (the v2
  // rows' weight_unit), then pounds.
  const factor = unitFactor(match[7] ?? unit);
  if (factor === null) {
    return { pounds: null, problem: `unknown unit in "${String(raw)}"` };
  }
  return { pounds: round4(amount * factor), problem: null };
}

// The pounds a pack row's `weight` column should hold: the source's own text
// read again when the row kept it (so a pack built by the old reader weighs
// right without a rebuild), the column otherwise (armor rows, which Open5e
// ships blank). 0 is the pack's "not stated", as the column's comment says.
export function packWeightLb(column: unknown, data: { weight?: unknown; weight_unit?: unknown } | null | undefined): number {
  const source = data?.weight;
  if (source === null || source === undefined || source === "") {
    const stored = Number(column);
    return Number.isFinite(stored) && stored > 0 ? stored : 0;
  }
  return readWeightLb(source, data?.weight_unit).pounds ?? 0;
}

// What packs built before this fix stored for the same text: every
// character but digits and dots dropped, then two places. Kept only to know
// a copied number for the old reader's mistake when it turns up on a sheet,
// a workshop copy or the party's pack (item-weights.ts repairedWeight).
export function legacyPackWeightLb(raw: unknown, unit?: unknown): number {
  if (raw === null || raw === undefined || raw === "") {
    return 0;
  }
  const value = Number.parseFloat(String(raw).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const kilograms = String(unit ?? raw).toLowerCase().includes("kg");
  return Math.round((kilograms ? value * 2.20462 : value) * 100) / 100;
}

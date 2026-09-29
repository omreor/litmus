import { expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";
const { judge } = await import("./integrity");
type Facts = Parameters<typeof judge>[0];
type Ev = NonNullable<Parameters<typeof judge>[1]>;

const SOL = "So11111111111111111111111111111111111111112";
const facts = (f: Partial<Facts> = {}): Facts => ({
  createdAt: 1000, graduatedAt: 2000, quoteMint: SOL, threshold: 85e9, decimals: 9, template: null, launchpad: null, ...f,
});
const ev = (e: Partial<Ev> = {}): Ev => ({
  pool: "p", complete: 1, partial: 0, creation_slot: 10, creation_sig: "create", creators: "[]", creator_fill: 0, creator_fill_sig: null,
  slot_fill: 0, buy_volume: 100e9, sell_volume: 20e9, creator_volume: 1e9, buyers: 40, trades: 90, completion_slot: 500, completion_sig: "done",
  source: "live", ...e,
});
const prior = { rules: ["template-prior"], reasons: ["auto-completing: 100% of 5,000 pools graduated"] };

test("independent buyers and no rule fired: contested, with receipts", () => {
  const j = judge(facts(), ev());
  expect(j.verdict).toBe("contested");
  expect(j.receipts).toEqual(["create", "done"]);
});

test("pool rules fire from transaction evidence", () => {
  expect(judge(facts(), ev({ creator_fill: 60e9 })).rules).toEqual(["creator-fill"]);
  expect(judge(facts(), ev({ slot_fill: 50e9 })).rules).toEqual(["bundle-fill"]);
  expect(judge(facts(), ev({ completion_slot: 10 })).rules).toContain("same-slot");
  expect(judge(facts(), ev({ buyers: 3 })).rules).toEqual(["few-buyers"]);
  expect(judge(facts(), ev({ creator_volume: 90e9 })).rules).toEqual(["creator-volume"]);
  expect(judge(facts({ threshold: 5e8 }), ev()).rules).toContain("sub-1-sol");
});

test("a template prior never overrides transaction evidence, but decides without it", () => {
  expect(judge(facts({ template: prior }), ev()).verdict).toBe("contested");
  expect(judge(facts({ template: prior }), null).verdict).toBe("uncontested");
  expect(judge(facts(), null).verdict).toBe("unverified");
});

test("creation-slot-only evidence judges fills but not buyers", () => {
  expect(judge(facts(), ev({ partial: 1, buyers: 1 })).verdict).toBe("unverified");
  expect(judge(facts(), ev({ partial: 1, creator_fill: 85e9 })).verdict).toBe("uncontested");
});

test("few buyers only counts once the curve completed", () => {
  expect(judge(facts({ graduatedAt: null }), ev({ buyers: 2, completion_slot: null })).verdict).toBe("unverified");
});

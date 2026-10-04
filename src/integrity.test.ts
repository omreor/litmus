import { expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";
const { judge } = await import("./integrity");
const { decodeDbcTx } = await import("./dbc");
type Facts = Parameters<typeof judge>[0];
type Ev = NonNullable<Parameters<typeof judge>[1]>;

const SOL = "So11111111111111111111111111111111111111112";
const facts = (f: Partial<Facts> = {}): Facts => ({
  createdAt: 1000, graduatedAt: 2000, quoteMint: SOL, threshold: 85e9, decimals: 9, template: null, launchpad: null, ...f,
});
const ev = (e: Partial<Ev> = {}): Ev => ({
  pool: "p", complete: 1, partial: 0, creation_slot: 10, creation_sig: "create", creators: "[]", creator_fill: 0, creator_fill_sig: null,
  slot_fill: 0, buy_volume: 100e9, sell_volume: 20e9, creator_volume: 1e9, buyers: 40, trades: 90, completion_slot: 500, completion_sig: "done",
  source: "live", version: 2, ...e,
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

test("a buyer swarm funded by one wallet is uncontested, with the funding transactions as receipts", () => {
  const funding = { sampled: 12, traced: 12, funder: "F", hops: 1, buyers: 9, share: 0.7, pool_share: 0.4, creator: 0, cosigned: 1, receipts: '["fund1","fund2"]' };
  const j = judge(facts({ funding }), ev());
  expect(j.rules).toEqual(["funded-swarm"]);
  expect(j.receipts).toContain("fund1");
  expect(judge(facts({ funding: { ...funding, share: 0.3 } }), ev()).verdict).toBe("contested");
  expect(judge(facts({ funding: { ...funding, funder: null, buyers: 0, share: 0 } }), ev()).evidence["funding source"]).toContain("no common funder");
});

// Shape of DxePvJ6D… (2026-10-04, launchpad 8TPACX…zxLc): 10 buyers filled a 10 SOL curve in 25 slots, no creator fill and no
// common funder, but the launchpad's own fee-claimer wallet bought 18.3 SOL of it after the creation slot.
test("the launchpad's own wallet buying half the curve is uncontested, with its buy as a receipt", () => {
  const launchpadBuy = { wallet: "8TPACXaKotSZ7WXktfmKDRhgoypyGXNzo1ctr2YBzxLc", volume: 18.344e9, sig: "lpbuy" };
  const shape = { threshold: 10e9, funding: { sampled: 10, traced: 10, funder: null, hops: null, buyers: 0, share: 0, pool_share: 0, creator: 0, cosigned: 0, receipts: "[]" } };
  const e = ev({ buyers: 10, trades: 22, buy_volume: 24.5e9, sell_volume: 0, creator_volume: 0, completion_slot: 35 });
  expect(judge(facts(shape), e).verdict).toBe("contested");
  const j = judge(facts({ ...shape, launchpadBuy }), e);
  expect(j.rules).toEqual(["launchpad-fill"]);
  expect(j.receipts).toContain("lpbuy");
  expect(judge(facts({ ...shape, launchpadBuy: { ...launchpadBuy, volume: 4e9 } }), e).verdict).toBe("contested");
});

// Mainnet swap (2026-09-29): one swap2 instruction emits both EvtSwap and EvtSwap2.
const SWAP_TX = {"sig":"2ypU8Fam4xbu1Tb4iC2MeS2VwL7HB34RVABRLeqz6wMYaV6FWhiA3XQfvsUEtsvGABuF856x89RhzdgixJ6YV2Mq","slot":451622025,"seen":1790679600,"keys":["5jdx3oir1YfT6w1h2oG3k8ympDgcQ7pFH1pifgVa389P","CfdX89WFJpf1hVPFJJ4RYYiEFRAKQ5QDTJiVsQTbjWnZ","G474CkX4pK1odFwtfVMteA657HvJKHUTK4Svi5NNNa6F","BfV6fjCxRoyBzMnexET9YghWZdV463cMStEb9RELS7VX","HNH29mZXKufkg7et9eMr6ZtRs4EZoxqrk7WiDfNGF1Rh","A5mQYBNd5uqTXzf7nsoztVLJ5zwnUdprV4GTwhc1y4uB","ComputeBudget111111111111111111111111111111","ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL","So11111111111111111111111111111111111111112","11111111111111111111111111111111","TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","AgXqSDdngnHVRD8E5nNvtpdyETnZB2hTaMvS8mDwD4kg","TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb","dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN","FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM","EZmnjPixJw8JHS71LrztKXfqbCzA5HnQFbYSraZzNYpk","8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF"],"ixs":[{"inner":false,"accounts":[14,15,3,1,2,4,5,11,8,0,12,10,13,16,13],"data":"QUs/TOtbW4jtuBkHAAAAAFQ/RXg6AAAAAA=="},{"inner":true,"accounts":[16],"data":"5EWlLlHLmh0bPBXViqq7k55wtc+5QnuYSh77wH2zgfTygZ+k7lwoiDPlBDTH7IaGyY0ojZPgGoqSQnVqUhZrCWFpYlzVbvYwrMVARsEx+8UBAO24GQcAAAAAVD9FeDoAAADtuBkHAAAAAA0lK/E6AAAAa4K/OTCXkQUAAAAAAAAAAFAEQR4AAAAAE0GQBwAAAAAAAAAAAAAAAO24GQcAAAAAL5q7agAAAAA="},{"inner":true,"accounts":[16],"data":"5EWlLlHLmh29QjOoJlB1mZ5wtc+5QnuYSh77wH2zgfTygZ+k7lwoiDPlBDTH7IaGyY0ojZPgGoqSQnVqUhZrCWFpYlzVbvYwrMVARsEx+8UBAO24GQcAAAAAVD9FeDoAAAAA7bgZBwAAAADtuBkHAAAAAAAAAAAAAAAADSUr8ToAAABrgr85MJeRBQAAAAAAAAAAUARBHgAAAAATQZAHAAAAAAAAAAAAAAAAxC6zdQIAAAAAgXWOAgAAAC+au2oAAAAA"}]};

test("a swap that emits EvtSwap and EvtSwap2 counts once, for the wallet that paid", () => {
  const steps = decodeDbcTx({
    sig: SWAP_TX.sig, slot: SWAP_TX.slot, blockTime: SWAP_TX.seen, accountKeys: SWAP_TX.keys,
    ixs: SWAP_TX.ixs.map((ix) => ({ accounts: ix.accounts, data: Buffer.from(ix.data, "base64") })),
  });
  expect(steps.length).toBe(1);
  expect(steps[0]).toMatchObject({ kind: "swap", buy: true, trader: "5jdx3oir1YfT6w1h2oG3k8ympDgcQ7pFH1pifgVa389P", reserve: 10564611780n });
});

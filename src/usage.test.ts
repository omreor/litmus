import { expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";
const { db } = await import("./store");
const { usage } = await import("./stats");

test("usage splits publisher requests, visitors and stream peaks from external requests", () => {
  const day = new Date().toISOString().slice(0, 10);
  const insert = db.prepare("INSERT INTO usage (day, route, count) VALUES (?, ?, ?)");
  [["overview", 3], ["publisher:overview", 96], ["visitors", 2], ["ws:peak", 1]].forEach(([route, n]) => insert.run(day, route, n));
  const u = usage({ current: 0, peak: 1 });
  expect(u.requests[day]).toEqual({ overview: 3 });
  expect(u.publisher[day]).toEqual({ overview: 96 });
  expect(u.visitors[day]).toBe(2);
  expect(u.stream.peakByDay[day]).toBe(1);
});

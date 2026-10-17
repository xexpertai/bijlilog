import { test } from "node:test";
import assert from "node:assert/strict";
import { isPincode, isPinPrefix, checkPublicText, checkBackfill } from "../src/lib/validate.js";
import { summarize, minutesByDayIST, istDate, isNightIST, toCSV } from "../src/lib/stats.js";
import { outageCreate, cutLogCreate, confirmCreate, stillDarkBatch, powerBackBatch, q, distinctConfirmers, PROJECT } from "../src/lib/schema.js";
import { render } from "@arkiv-network/sdk/query";

const K1 = "0x" + "11".repeat(32);

test("pincode validation", () => {
  assert.ok(isPincode("411001"));
  for (const bad of ["011001", "41100", "4110011", "41100a", 411001]) assert.equal(isPincode(bad), false, String(bad));
  assert.ok(isPinPrefix("41")); assert.ok(isPinPrefix("411001")); assert.equal(isPinPrefix("0"), false);
});

test("public text guard refuses personal data", () => {
  assert.ok(checkPublicText("Near the bus depot, whole lane dark").ok);
  for (const pii of ["call 9876543210", "+91 98765 43210", "me@example.com", "1234 5678 9012", "meter 12345678", "House no 4 lane 2"])
    assert.equal(checkPublicText(pii).ok, false, pii);
  assert.equal(checkPublicText("x".repeat(61)).ok, false);
});

test("backfill rules", () => {
  const now = Date.UTC(2026, 9, 12, 12);
  assert.ok(checkBackfill({ startedAtMs: now - 3 * 3600e3, endedAtMs: now - 3600e3, nowMs: now }).ok);
  assert.equal(checkBackfill({ startedAtMs: now - 3600e3, endedAtMs: now - 7200e3, nowMs: now }).ok, false);
  assert.equal(checkBackfill({ startedAtMs: now - 3600e3, endedAtMs: now + 3600e3, nowMs: now }).ok, false);
  assert.equal(checkBackfill({ startedAtMs: now - 61 * 86400e3, endedAtMs: now - 60.9 * 86400e3, nowMs: now }).ok, false);
});

test("entity builders: typed attributes, lifetimes, flags", () => {
  const o = outageCreate({ pin: "411001", startedAtMs: 1760000000000 });
  assert.equal(o.attributes.project.value ?? o.attributes.project, PROJECT);
  assert.deepEqual(o.flags, { permissionlessExtension: true });
  const c = cutLogCreate({ pin: "411001", startedAtMs: 0 + 1e12, endedAtMs: 1e12 + 95 * 60000, confirmers: 2, origin: "live", outageKey: K1 });
  assert.equal(c.attributes.duration_min.value, 95);
  assert.deepEqual(c.flags, { readonly: true, permissionlessExtension: true });
  assert.throws(() => cutLogCreate({ pin: "411001", startedAtMs: 5, endedAtMs: 5, confirmers: 0, origin: "live" }));
  assert.throws(() => confirmCreate({ outageKey: K1, pin: "411001", kind: "maybe", atMs: 1 }));
});

test("batches pair the right operations", () => {
  const sd = stillDarkBatch({ outageKey: K1, pin: "411001", atMs: 1 });
  assert.equal(sd.creates.length, 1); assert.equal(sd.extensions[0].entityKey, K1);
  const outage = { key: K1, pin: "411001", startedAtMs: 1e12, area: "", note: "" };
  assert.equal(powerBackBatch({ outage, endedAtMs: 1e12 + 6e5, confirmers: 1, callerIsOwner: true }).deletes[0].entityKey, K1);
  assert.equal(powerBackBatch({ outage, endedAtMs: 1e12 + 6e5, confirmers: 1, callerIsOwner: false }).deletes, undefined);
});

test("queries render to the expected Arkiv query language", () => {
  const s = q.history({ pinOrPrefix: "411", sinceMs: 1, minConfirmers: 2 }).map((p) => render(p)).join(" AND ");
  assert.match(s, /project = str\('bijlilog-v1'\)/);
  assert.match(s, /pin STARTSWITH str\('411'\)/);
  assert.match(s, /started_at_ms >= u64\(1\)/);
  assert.match(s, /confirmers >= i32\(2\)/);
  assert.match(q.liveOutages("411001").map((p) => render(p)).join(" "), /pin = str\('411001'\)/);
});

test("distinct confirmers ignore the reporter and repeats", () => {
  const A = "0xAa00000000000000000000000000000000000001", B = "0xbB00000000000000000000000000000000000002";
  const R = "0xCC00000000000000000000000000000000000003";
  const cs = [{ creator: A, kind: "still_out" }, { creator: A.toLowerCase(), kind: "still_out" }, { creator: B, kind: "still_out" }, { creator: R, kind: "still_out" }, { creator: "0xdd", kind: "restored" }];
  assert.equal(distinctConfirmers(cs, R.toLowerCase()), 2);
});

test("stats: counts, long cuts, night cuts, per-day strip, CSV", () => {
  const day = Date.UTC(2026, 9, 10, 0, 0); // 05:30 IST
  const cuts = [
    { startedAtMs: day, endedAtMs: day + 30 * 6e4, durationMin: 30, confirmers: 0 },
    { startedAtMs: day + 17.5 * 3600e3, endedAtMs: day + 22 * 3600e3, durationMin: 270, confirmers: 2 }, // 23:00 IST
  ];
  const s = summarize(cuts);
  assert.deepEqual([s.count, s.totalHours, s.longestMin, s.longCuts, s.confirmedCuts, s.nightCuts], [2, 5, 270, 1, 1, 2]);
  assert.equal(istDate(day), "2026-10-10");
  assert.ok(isNightIST(day)); // 05:30 IST
  const strip = minutesByDayIST(cuts, 3, day + 20 * 3600e3);
  assert.equal(strip.length, 3);
  assert.equal(strip.reduce((a, d) => a + d.minutes, 0), 300);
  const csv = toCSV([{ ...cuts[0], pin: "411001", origin: "live", source: "demo", creator: "0xabc", key: K1 }], (k) => `x/${k}`);
  assert.match(csv.split("\n")[1], /^411001,2026-10-10 05:30,2026-10-10 06:00,30,0,live,demo,0xabc,0x1111/);
});

test("demo outages produce demo records; early test-run cuts read as DEMO", async () => {
  const { powerBackBatch, decodeCutLog, TEST_RUN_KEYS } = await import("../src/lib/schema.js");
  const outage = { key: "0x" + "ab".repeat(32), pin: "411001", startedAtMs: 1, area: "", note: "", source: "demo" };
  const b = powerBackBatch({ outage, endedAtMs: 120_000, confirmers: 2, callerIsOwner: true, source: "user" });
  assert.equal(b.creates[0].attributes.source.value, "demo");
  const user = powerBackBatch({ outage: { ...outage, source: "user" }, endedAtMs: 120_000, confirmers: 2, callerIsOwner: true, source: "user" });
  assert.equal(user.creates[0].attributes.source.value, "user");
  const key = [...TEST_RUN_KEYS][0];
  const e = { key, creator: "0x1", attributes: { source: { type: "str", value: "user" }, pin: { type: "str", value: "411001" } }, toJson: () => ({}) };
  assert.equal(decodeCutLog(e).source, "demo");
});

import { buildComplaint } from "../src/lib/complaint.js";
test("complaint summary: real cuts cite the Rules and 45 days; any DEMO record gives the SAMPLE ONLY guard", () => {
  const mk = (source, d) => ({ key: "0x" + "a".repeat(63) + d, pin: "411001", startedAtMs: Date.UTC(2026, 9, 10, 20, 0) + d * 3600e3, endedAtMs: Date.UTC(2026, 9, 10, 22, 0) + d * 3600e3, durationMin: 120, confirmers: 2, source });
  const ex = (k) => `https://x/${k}`;
  const real = buildComplaint({ cuts: [mk("user", 0)], pin: "411001", lang: "en", explorerEntity: ex });
  assert.equal(real.hasDemo, false);
  assert.match(real.text, /Rights of Consumers\) Rules, 2020/); assert.match(real.text, /45 days/); assert.doesNotMatch(real.text, /SAMPLE ONLY/);
  const demo = buildComplaint({ cuts: [mk("user", 0), mk("demo", 1)], pin: "411001", lang: "en", explorerEntity: ex });
  assert.ok(demo.text.startsWith("SAMPLE ONLY: contains DEMO (synthetic) records. Do not file.")); assert.match(demo.text, /\[DEMO\]/);
  const hi = buildComplaint({ cuts: [mk("demo", 0)], pin: "411001", lang: "hi", explorerEntity: ex });
  assert.ok(hi.text.startsWith("केवल नमूना:")); assert.match(hi.text, /45 दिनों/); assert.match(hi.text, /1 पड़ोसी|2 पड़ोसियों/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createRelay } from "../server/relay.js";
import { signAction, canonicalMessage, verifySigned, parseMessage } from "../src/lib/signing.js";
import { PROJECT } from "../src/lib/schema.js";

const RELAY = privateKeyToAccount(generatePrivateKey());
const NOW = Date.UTC(2026, 9, 12, 14, 0);
const OUT = "0x" + "ab".repeat(32);

function mocks({ entity = null, liveOutage = false, confirms = [], cutLog = false } = {}) {
  const calls = [];
  const page = (entities) => ({ entities, hasNextPage: () => false });
  const builder = (pred) => {
    const s = pred.map(String).join(" ");
    const b = { where: (p) => builder(p), createdBy: () => b, limit: () => b,
      fetch: async () => page(s.includes("outage") && !s.includes("confirm") && !s.includes("cut_log") ? (liveOutage ? [{ key: OUT }] : [])
        : s.includes("cut_log") ? (cutLog ? [{ key: "0xc" }] : []) : confirms) };
    return b;
  };
  const publicClient = {
    getEntity: async () => { if (!entity) throw new Error("NoEntityFound"); return entity; },
    select: () => ({ where: (p) => builder(p.map((x) => JSON.stringify(x))) }),
  };
  const walletClient = {
    account: RELAY,
    createEntity: async (p) => { calls.push(["create", p]); return { txHash: "0xt1", entityKey: "0xk1" }; },
    extendEntity: async (p) => { calls.push(["extend", p]); return { txHash: "0xt2" }; },
    executeBatch: async (p) => { calls.push(["batch", p]); return { txHash: "0xt3", createdEntities: ["0xk2"], deletedEntities: p.deletes?.map((d) => d.entityKey) ?? [] }; },
  };
  return { publicClient, walletClient, calls };
}
const attr = (type, value) => ({ type, value });
function outageEntity({ device }) {
  return { key: OUT, creator: RELAY.address, owner: RELAY.address, expiresAt: 9n,
    attributes: { project: attr("str", PROJECT), type: attr("str", "outage"), pin: attr("str", "411001"), started_at_ms: attr("u64", BigInt(NOW - 3600e3)), source: attr("str", "user"), device: attr("addr", device) },
    toJson: () => ({ v: 1, area: "", note: "" }) };
}
async function signed(acct, fields) { const s = await signAction(acct, { ts: NOW, pin: "411001", ...fields }); return { device: s.device, msg: s.msg, sig: s.sig }; }

test("signing round-trip and tamper detection", async () => {
  const dev = privateKeyToAccount(generatePrivateKey());
  const s = await signAction(dev, { action: "report", pin: "411001", ts: NOW, note: "dark\nlane" });
  assert.ok(await verifySigned(s, dev.address));
  assert.equal(canonicalMessage(parseMessage(s.msg)), s.msg);
  assert.equal(await verifySigned({ ...s, msg: s.msg.replace("411001", "411002") }, dev.address), false);
});

test("report: creates a leased outage carrying device + signature", async () => {
  const m = mocks(); const relay = createRelay({ ...m, now: () => NOW });
  const dev = privateKeyToAccount(generatePrivateKey());
  const r = await relay.handle(await signed(dev, { action: "report", area: "Market road" }));
  assert.equal(r.created[0], "0xk1");
  const p = m.calls[0][1];
  assert.equal(p.attributes.device.value ?? p.attributes.device, dev.address);
  assert.deepEqual(p.flags, { permissionlessExtension: true });
  const body = JSON.parse(new TextDecoder().decode(p.payload));
  assert.ok(await verifySigned(body.signed, dev.address));
});

test("rejects bad signature, stale ts, replay, PII, duplicates", async () => {
  const dev = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
  let m = mocks(); let relay = createRelay({ ...m, now: () => NOW });
  const s = await signed(dev, { action: "report" });
  await assert.rejects(relay.handle({ ...s, device: other.address }), { status: 401 });
  await assert.rejects(relay.handle(await signAction(dev, { action: "report", pin: "411001", ts: NOW - 10 * 60e3 })), { status: 400 });
  await relay.handle(s);
  await assert.rejects(relay.handle(s), { status: 409 });
  await assert.rejects(relay.handle(await signed(dev, { action: "report", note: "call 9876543210" })), { status: 400 });
  m = mocks({ liveOutage: true }); relay = createRelay({ ...m, now: () => NOW });
  await assert.rejects(relay.handle(await signed(dev, { action: "report" })), (e) => e.status === 409 && e.extra.outageKey === OUT);
  assert.equal(m.calls.length, 0, "nothing paid for rejected actions");
});

test("still_dark: neighbour => atomic confirm+extend; reporter => extend only", async () => {
  const reporter = privateKeyToAccount(generatePrivateKey()), neighbour = privateKeyToAccount(generatePrivateKey());
  let m = mocks({ entity: outageEntity({ device: reporter.address }) }); let relay = createRelay({ ...m, now: () => NOW });
  const r = await relay.handle(await signed(neighbour, { action: "still_dark", outage: OUT }));
  assert.equal(r.counted, true);
  assert.equal(m.calls[0][0], "batch"); assert.equal(m.calls[0][1].creates.length, 1); assert.equal(m.calls[0][1].extensions[0].entityKey, OUT);
  m = mocks({ entity: outageEntity({ device: reporter.address }) }); relay = createRelay({ ...m, now: () => NOW });
  const r2 = await relay.handle(await signed(reporter, { action: "still_dark", outage: OUT }));
  assert.equal(r2.counted, false); assert.equal(m.calls[0][0], "extend");
});

test("power_back: counts distinct neighbours, writes cut_log and deletes the lease atomically", async () => {
  const reporter = privateKeyToAccount(generatePrivateKey());
  const A = "0x000000000000000000000000000000000000000A", B = "0x000000000000000000000000000000000000000b";
  const conf = (d) => ({ key: "0x1", creator: RELAY.address, attributes: { device: attr("addr", d), kind: attr("str", "still_out"), outage: attr("key", OUT), at_ms: attr("u64", 1n) }, toJson: () => ({}) });
  const m = mocks({ entity: outageEntity({ device: reporter.address }), confirms: [conf(A), conf(A), conf(B), conf(reporter.address)] });
  const relay = createRelay({ ...m, now: () => NOW });
  const r = await relay.handle(await signed(reporter, { action: "power_back", outage: OUT }));
  assert.equal(r.confirmers, 2);
  const batch = m.calls[0][1];
  assert.equal(batch.creates[0].attributes.duration_min.value, 60);
  assert.equal(batch.deletes[0].entityKey, OUT);
  const m2 = mocks({ entity: outageEntity({ device: reporter.address }), cutLog: true });
  await assert.rejects(createRelay({ ...m2, now: () => NOW }).handle(await signed(reporter, { action: "power_back", outage: OUT })), { status: 409 });
});

test("backfill validated; daily device limit enforced", async () => {
  const dev = privateKeyToAccount(generatePrivateKey());
  const m = mocks(); const relay = createRelay({ ...m, now: () => NOW, limits: { perDevicePerDay: 2 } });
  await assert.rejects(relay.handle(await signed(dev, { action: "backfill", started_at_ms: NOW - 3600e3, ended_at_ms: NOW - 7200e3 })), { status: 400 });
  await relay.handle(await signed(dev, { action: "backfill", started_at_ms: NOW - 3 * 3600e3, ended_at_ms: NOW - 3600e3, note: "x" }));
  assert.equal(m.calls[0][1].attributes.origin.value, "backfill");
  await assert.rejects(relay.handle(await signed(dev, { action: "backfill", started_at_ms: NOW - 5 * 3600e3, ended_at_ms: NOW - 4 * 3600e3, note: "y" })), { status: 429 });
});

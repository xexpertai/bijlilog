// REPLAY fixture: an in-memory stand-in for the Arkiv read RPC, used ONLY to test the UI and to render
// the clearly-labelled "Replay" preview video when the testnet wallet has no GLM. It is never used by the
// deployed app. It serves the same synthetic data as scripts/seed.mjs, in the real arkiv_query wire format.
import { jsonToPayload, str, u64, i32, addr, key } from "@arkiv-network/sdk";
import { cutLogCreate, outageCreate, confirmCreate, plannedNoticeCreate } from "../src/lib/schema.js";
import { PLAN, PLACES } from "./demo-plan.mjs";
import { RELAYS } from "../src/web/config.js";

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const HEAD = 670_000;
const fake = (n) => "0x" + n.toString(16).padStart(40, "0");
const hex = (n) => "0x" + BigInt(n).toString(16);
const hexKey = (n) => "0x" + n.toString(16).padStart(64, "0");

function wire(c, k, creator, expBlocks) {
  const toBytes = (p) => "0x" + Buffer.from(p instanceof Uint8Array ? p : new TextEncoder().encode(String(p))).toString("hex");
  return {
    key: k, owner: creator, creator, expiresAt: hex(HEAD + expBlocks), contentType: "application/json", payload: toBytes(c.payload),
    attributes: Object.entries(c.attributes).map(([name, v]) => ({ name, type: v.type, value: v.type === "u64" ? hex(v.value) : v.type === "i32" ? v.value : v.value })),
  };
}

export function buildFixture(now = Date.now()) {
  const creator = RELAYS[0].toLowerCase();
  const ents = []; let n = 1;
  for (const [pin, rows] of Object.entries(PLAN)) for (const [ago, hourIst, durMin, confirmers] of rows) {
    const day0 = Math.floor((now - ago * DAY + 330 * 60_000) / DAY) * DAY - 330 * 60_000;
    const s = day0 + hourIst * HOUR;
    ents.push(wire(cutLogCreate({ pin, startedAtMs: s, endedAtMs: s + durMin * 60_000, confirmers, origin: "live", area: PLACES[pin], note: "Demo data", source: "demo" }), hexKey(n++), creator, 365 * 43200));
  }
  const ok = hexKey(900);
  ents.push(wire(outageCreate({ pin: "411001", startedAtMs: now - 50 * 60_000, area: PLACES["411001"], note: "Demo data", source: "demo", device: fake(0xa1) }), ok, creator, 70 * 30));
  for (const k of [0, 1]) ents.push(wire(confirmCreate({ outageKey: ok, pin: "411001", kind: "still_out", atMs: now - (30 - 10 * k) * 60_000, source: "demo", device: fake(0xb1 + k) }), hexKey(950 + k), creator, 30 * 43200));
  // UI layout check only (REPLAY_NOTICES=1): two obviously fake notices. Never used for evidence screenshots.
  if (process.env.REPLAY_NOTICES) for (const [i, area] of ["LAYOUT TEST AREA ONE", "LAYOUT TEST AREA TWO"].entries()) {
    const n = { district: "TESTVILLE", zone: String(400 + i), area, description: "LAYOUT TEST ONLY", startMs: now - 3_600_000, endMs: now + 2 * 3_600_000 };
    ents.push(wire(plannedNoticeCreate({ n, discom: { id: "tpddl", name: "Tata Power-DDL", url: "https://example.invalid/" }, noticeId: `t${i}`, fetchedAtMs: now - 60_000 }), hexKey(990 + i), creator, 5400));
  }
  return ents;
}

// Evaluates the predicates this app emits: =, STARTSWITH, >=, <= and $creator.
function matches(e, query) {
  const attrs = Object.fromEntries(e.attributes.map((a) => [a.name, a.value]));
  return query.split(" AND ").every((p) => {
    let m;
    if (p.startsWith("(") && p.endsWith(")")) return p.slice(1, -1).split(" OR ").some((x) => matches(e, x));
    if ((m = p.match(/^\$creator = addr\((0x[0-9a-fA-F]{40})\)$/))) return e.creator.toLowerCase() === m[1].toLowerCase();
    if ((m = p.match(/^(\w+) = str\('(.*)'\)$/))) return attrs[m[1]] === m[2];
    if ((m = p.match(/^(\w+) STARTSWITH str\('(.*)'\)$/))) return String(attrs[m[1]] ?? "").startsWith(m[2]);
    if ((m = p.match(/^(\w+) = key\((0x\w+)\)$/))) return attrs[m[1]] === m[2];
    if ((m = p.match(/^(\w+) (>=|<=) (u64|i32)\((\d+)\)$/))) {
      const v = BigInt(attrs[m[1]] ?? -1), x = BigInt(m[4]);
      return m[2] === ">=" ? v >= x : v <= x;
    }
    throw new Error(`replay: unsupported predicate ${p}`);
  });
}

export function makeHandler(now = Date.now()) {
  const ents = buildFixture(now);
  return (rpc) => {
    const ok = (result) => ({ jsonrpc: "2.0", id: rpc.id, result });
    switch (rpc.method) {
      case "eth_chainId": return ok("0x7614d1");
      case "eth_blockNumber": return ok(hex(HEAD));
      case "arkiv_query": {
        const [query, opts = {}] = rpc.params;
        const sel = opts.select ?? {};
        const rows = ents.filter((e) => matches(e, query)).slice(0, Number(opts.limit ?? 200));
        const data = rows.map((e) => { const o = {}; for (const f of ["key", "owner", "creator", "expiresAt", "contentType", "payload"]) if (sel[f]) o[f] = e[f]; if (sel.attributes) o.attributes = e.attributes; return o; });
        return ok({ data, blockNumber: hex(HEAD) });
      }
      default: return { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `replay: ${rpc.method} not supported` } };
    }
  };
}

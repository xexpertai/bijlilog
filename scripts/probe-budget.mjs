// Friction probe: what does an SDK caller see once the anonymous arkiv_query budget (10,000 units) is spent?
// WARNING: run it only from a disposable IP/session. It blocks anonymous reads from this IP for about 30 minutes.
// Usage: node scripts/probe-budget.mjs [exhaust]   ("exhaust" first burns the budget with raw requests, 100 units each)
import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http } from "viem";
import { eq } from "@arkiv-network/sdk/query";
import { str } from "@arkiv-network/sdk";
const URL_ = "https://rpc.tiramisu.db-chain.testnet.arkiv.network";
const rpc = (method, params, id = 1) => fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
const Q = ["project = str('bijlilog-v1')", { limit: "0x1", select: { key: true } }];
if (process.argv[2] === "exhaust") {
  let n = 0;
  for (; n < 200; n++) { const r = await rpc("arkiv_query", Q); if (r.status === 429) break; await r.text(); }
  console.log(`budget exhausted after ${n} raw arkiv_query calls this run`);
}
const r = await rpc("arkiv_query", Q);
console.log("raw arkiv_query:", r.status, r.headers.get("content-type"), "| ratelimit:", r.headers.get("ratelimit"), "| retry-after:", r.headers.get("retry-after"));
console.log("body:", (await r.text()).slice(0, 200));
const b = await rpc("eth_blockNumber", [], 2);
console.log("eth_blockNumber meanwhile:", b.status, (await b.text()).slice(0, 80));
for (const retryCount of [0, 3]) {
  const pc = createPublicClient({ chain: tiramisu, transport: http(undefined, { retryCount, timeout: 30_000 }) });
  const t = Date.now();
  try { await pc.select({ key: true }).where([eq("project", str("bijlilog-v1"))]).limit(1).fetch(); console.log(`SDK query, retryCount=${retryCount}: ok`); }
  catch (e) { console.log(`SDK query, retryCount=${retryCount}: failed after ${Date.now() - t} ms | ${e.constructor?.name} | ${e.shortMessage ?? String(e.message).slice(0, 160)} | status ${e.status ?? e.cause?.status}`); }
}
// The viem default (retryCount 3, per-request timeout 10 s) with NO explicit options, as app code usually writes http():
const pc = createPublicClient({ chain: tiramisu, transport: http() });
const t = Date.now();
const timer = setTimeout(() => { console.log(`SDK query with default http(): STILL WAITING after ${(Date.now() - t) / 1000} s (giving up)`); process.exit(0); }, 120_000);
try { await pc.select({ key: true }).where([eq("project", str("bijlilog-v1"))]).limit(1).fetch(); console.log("default http(): ok"); }
catch (e) { console.log(`default http(): failed after ${Date.now() - t} ms | ${e.constructor?.name} | ${e.shortMessage ?? String(e.message).slice(0, 160)}`); }
clearTimeout(timer);

// Companion to probe-budget.mjs: only the SDK part (run it while the anonymous budget is already exhausted).
import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http } from "viem";
import { eq } from "@arkiv-network/sdk/query";
import { str } from "@arkiv-network/sdk";
const mode = process.argv[2] ?? "default"; // default | r0 | r3
const opts = mode === "r0" ? { retryCount: 0 } : mode === "r3" ? { retryCount: 3 } : undefined;
const pc = createPublicClient({ chain: tiramisu, transport: http(undefined, opts) });
const t = Date.now();
const timer = setInterval(() => console.log(`  ...still waiting after ${((Date.now() - t) / 1000).toFixed(0)} s`), 15_000);
setTimeout(() => { console.log(`mode=${mode}: no result after 90 s, giving up`); process.exit(0); }, 90_000);
try { await pc.select({ key: true }).where([eq("project", str("bijlilog-v1"))]).limit(1).fetch(); console.log(`mode=${mode}: ok after ${Date.now() - t} ms`); }
catch (e) { console.log(`mode=${mode}: failed after ${Date.now() - t} ms | ${e.constructor?.name} | shortMessage=${e.shortMessage} | status=${e.status ?? e.cause?.status} | details=${String(e.details ?? "").slice(0, 120)}`); }
clearInterval(timer); process.exit(0);

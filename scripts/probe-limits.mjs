// Friction probe: size limits on attributes and batches (writes tiny 2-minute entities under project "bijlilog-probe").
// Usage: node --env-file=.env.local scripts/probe-limits.mjs
import { createPublicClient, createWalletClient, ExpirationTime, jsonToPayload, str } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const account = privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY);
const wc = createWalletClient({ chain: tiramisu, transport: http(undefined, { retryCount: 0 }), account });
const mk = (extra = {}) => ({ payload: jsonToPayload({ v: 1 }), contentType: "application/json", attributes: { project: str("bijlilog-probe"), ...extra }, expires: ExpirationTime.fromMinutes(2) });
const show = (e) => `${e.name}: ${String(e.shortMessage ?? e.message).replace(/\s+/g, " ").slice(0, 220)}`;
for (const len of [100, 256, 257, 1000]) {
  try { const r = await wc.createEntity(mk({ note: str("x".repeat(len)) })); console.log(`string attribute of ${len} chars: ok`, r.entityKey.slice(0, 12)); }
  catch (e) { console.log(`string attribute of ${len} chars: FAILED -> ${show(e)}`); }
}
for (const n of [5, 20, 50, 100]) {
  const t = Date.now();
  try { const r = await wc.executeBatch({ creates: Array.from({ length: n }, (_, i) => mk({ i: str(String(i)) })) }); console.log(`batch of ${n} creates: ok in ${Date.now() - t} ms, ${r.createdEntities.length} created`); }
  catch (e) { console.log(`batch of ${n} creates: FAILED -> ${show(e)}`); }
}

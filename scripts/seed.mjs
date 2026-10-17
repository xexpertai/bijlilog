// Writes SYNTHETIC demo data to Arkiv Tiramisu (testnet) from the testnet-only relay wallet.
// Every record has source="demo" and is shown as DEMO in the app. These are NOT real outages.
// Usage: node --env-file=.env.local scripts/seed.mjs [--dry] [--live]
//   (default)  cut_log history for 3 PIN codes over the last 28 days
//   --only-live  just the live outage + confirms (refresh the 2-hour lease before a demo)
//   --live     also open 1 live outage + 2 neighbour confirmations (2-hour lease: run just before a demo)
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PLAN, PLACES } from "./demo-plan.mjs";
import { cutLogCreate, outageCreate, confirmCreate } from "../src/lib/schema.js";

const dry = process.argv.includes("--dry"), onlyLive = process.argv.includes("--only-live"), live = onlyLive || process.argv.includes("--live");
const HOUR = 3_600_000, DAY = 24 * HOUR, now = Date.now();
const creates = [];
for (const [pin, rows] of Object.entries(PLAN)) for (const [ago, hourIst, durMin, confirmers] of rows) {
  const day0 = Math.floor((now - ago * DAY + 330 * 60_000) / DAY) * DAY - 330 * 60_000; // IST midnight
  const startedAtMs = day0 + hourIst * HOUR;
  creates.push(cutLogCreate({ pin, startedAtMs, endedAtMs: startedAtMs + durMin * 60_000, confirmers, origin: "live", area: PLACES[pin], note: "Demo data", source: "demo" }));
}
console.log(`planned: ${creates.length} cut_log entities (source=demo)${live ? " + 1 live outage + 2 confirms" : ""}`);
if (dry) process.exit(0);

const account = privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY);
const pc = createPublicClient({ chain: tiramisu, transport: http() });
const wc = createWalletClient({ chain: tiramisu, transport: http(), account });
const bal = await pc.getBalance({ address: account.address });
console.log("relay wallet", account.address, "balance GLM", formatEther(bal));
if (bal === 0n) { console.error("Wallet has 0 test GLM. Claim at hub.arkiv.network/faucet to the address above, then re-run."); process.exit(2); }

// Synthetic neighbour identities (not real keys, no signatures): lets "N neighbours confirmed" count distinct people.
const fake = (n) => "0x" + n.toString(16).padStart(40, "0");
const out = { txs: [], entities: [] };
if (onlyLive) creates.length = 0;
for (let i = 0; i < creates.length; i += 5) {
  const r = await wc.executeBatch({ creates: creates.slice(i, i + 5) });
  out.txs.push(r.txHash); out.entities.push(...r.createdEntities);
  console.log("batch", i / 5 + 1, r.txHash);
}
if (live) {
  const startedAtMs = now - 50 * 60_000;
  const o = await wc.createEntity(outageCreate({ pin: "411001", startedAtMs, area: PLACES["411001"], note: "Demo data", source: "demo", device: fake(0xa1) }));
  out.txs.push(o.txHash); out.entities.push(o.entityKey); console.log("live outage", o.entityKey, o.txHash);
  const c = await wc.executeBatch({ creates: [0, 1].map((k) => confirmCreate({ outageKey: o.entityKey, pin: "411001", kind: "still_out", atMs: now - (30 - 10 * k) * 60_000, source: "demo", device: fake(0xb1 + k) })) });
  out.txs.push(c.txHash); out.entities.push(...c.createdEntities);
}
console.log(JSON.stringify(out, null, 1));

// Judge CLI: reproduces BijliLog's Arkiv reads with no app and no server. Read-only, needs no key or funds.
// Usage: node scripts/verify.mjs [pin-or-prefix]   (default: 411)
import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { render } from "@arkiv-network/sdk/query";
import { http } from "viem";
import { q, decodeOutage, decodeCutLog, fetchAll, explorer } from "../src/lib/schema.js";
import { RELAYS } from "../src/web/config.js";
import { summarize } from "../src/lib/stats.js";

const pin = process.argv[2] ?? "411";
const pc = createPublicClient({ chain: tiramisu, transport: http() });
const creator = RELAYS[0];
console.log("chain", tiramisu.id, "| head block", String(await pc.getBlockNumber()), "| $creator filter", creator);

const live = q.liveOutages(pin), hist = q.history({ pinOrPrefix: pin, sinceMs: 0 });
console.log("\nQ1 live outages:\n ", live.map((p) => render(p)).join(" AND "), `AND $creator = addr(${creator})`);
const outages = (await fetchAll(pc.select({ key: true, creator: true, owner: true, expiresAt: true, attributes: true, payload: true }).where(live).createdBy(creator))).map(decodeOutage);
for (const o of outages) console.log("  ", o.key, o.pin, o.source, "expiresAt block", String(o.expiresAt), explorer.entity(o.key));
console.log(`  -> ${outages.length} live outage(s)`);

console.log("\nQ2 cut history:\n ", hist.map((p) => render(p)).join(" AND "), `AND $creator = addr(${creator})`);
const cuts = (await fetchAll(pc.select({ key: true, creator: true, expiresAt: true, attributes: true, payload: true }).where(hist).createdBy(creator))).map(decodeCutLog);
for (const c of cuts.slice(0, 10)) console.log("  ", c.key, c.pin, `${c.durationMin} min`, `confirmers=${c.confirmers}`, c.source, explorer.entity(c.key));
const s = summarize(cuts);
console.log(`  -> ${s.count} cut(s), ${s.totalHours} h without power, longest ${s.longestMin} min`);
if (!outages.length && !cuts.length) console.log("\nNo BijliLog entities found for this PIN prefix. Try another prefix (411, 560, 226).");

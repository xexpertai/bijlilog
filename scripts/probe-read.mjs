// Read-only probe: no wallet, no gas. Checks HTTP query + WebSocket subscription on Tiramisu.
import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http, webSocket } from "viem";
const hc = createPublicClient({ chain: tiramisu, transport: http() });
console.log("head", await hc.getBlockNumber(), "entities on chain", await hc.getEntityCount());
const page = await hc.select({ key: true, creator: true, attributes: true }).where("*" ).limit(3).fetch().catch(e => ({ err: e.message }));
console.log("star query", page.err ?? page.entities.length);
const wc = createPublicClient({ chain: tiramisu, transport: webSocket() });
let n = 0; const t0 = Date.now();
const un = wc.watchEntityEvents({ onEvent: (e) => { n++; if (n <= 3) console.log("ws event", e.type, e.blockNumber); }, onError: (e) => console.log("ws err", e.message) });
setTimeout(() => { un(); console.log(`ws events in ${(Date.now()-t0)/1000}s:`, n); process.exit(0); }, 30000);

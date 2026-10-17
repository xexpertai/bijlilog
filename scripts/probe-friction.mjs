// Read-only probes against Tiramisu used for arkiv/friction.md. No funds needed. Prints results only.
import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { eq, startsWith, gte } from "@arkiv-network/sdk/query";
import { str, u64 } from "@arkiv-network/sdk";
import { http, webSocket } from "viem";
const pc = createPublicClient({ chain: tiramisu, transport: http() });
const t = async (name, fn) => { try { console.log(name, "=>", await fn()); } catch (e) { console.log(name, "=> ERR", e.name, "|", (e.shortMessage ?? e.message).split("\n")[0]); } };
await t("blockNumber", async () => String(await pc.getBlockNumber()));
await t("empty exact query", async () => (await pc.select({ key: true }).where([eq("project", str("bijlilog-v1"))]).limit(5).fetch()).entities.length);
await t("startsWith query", async () => (await pc.select({ key: true }).where([startsWith("pin", "411")]).limit(5).fetch()).entities.length);
await t("range query u64", async () => (await pc.select({ key: true }).where([gte("started_at_ms", u64(0))]).limit(5).fetch()).entities.length);
await t("getEntity unknown key", async () => JSON.stringify(await pc.getEntity("0x" + "00".repeat(32))));
await t("getEntity malformed key", async () => JSON.stringify(await pc.getEntity("0x1234")));
await t("createdBy builder", async () => (await pc.select({ key: true }).where([eq("type", str("x"))]).createdBy("0x440701BE95a49e2701BCedb39934a638dF0AE217").limit(1).fetch()).entities.length);
const ws = createPublicClient({ chain: tiramisu, transport: webSocket() });
let n = 0; const stop = ws.watchEntityEvents({ onEvent: () => n++, onError: (e) => console.log("ws error", e.message) });
await new Promise((r) => setTimeout(r, 15000)); (await stop)?.(); console.log("ws events in 15s (whole chain):", n);
process.exit(0);

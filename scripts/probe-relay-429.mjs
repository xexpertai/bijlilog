// Friction/regression probe: POST a signed "still_dark" for an unknown outage to a local relay while the anonymous
// Arkiv read budget is spent. Before the fix this hung for minutes; now it must answer 503 within seconds.
// Usage: node --env-file=.env.local server/server.mjs (PORT=18434) in one shell, then: node scripts/probe-relay-429.mjs http://127.0.0.1:18434
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signAction } from "../src/lib/signing.js";
const base = process.argv[2] ?? "http://127.0.0.1:18434";
const dev = privateKeyToAccount(generatePrivateKey());
const body = await signAction(dev, { action: "still_dark", pin: "110001", outage: "0x" + "00".repeat(31) + "01", ts: Date.now() });
const t = Date.now();
const res = await fetch(`${base}/api/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
console.log(`relay answered HTTP ${res.status} after ${Date.now() - t} ms:`, JSON.stringify(await res.json()));

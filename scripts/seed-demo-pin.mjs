// Seeds a believable SYNTHETIC history on one demo PIN through the running relay's "backfill" action
// (each record is sealed to 0x...dEaD in the same batch, source=demo because the area starts with "Synthetic").
// With --live-cuts it also runs 3 live-style cuts through the normal path (report, "Still dark" from 2-5 different device keys, "Power's back"),
// spread over real time (about 25 minutes), so each shows "confirmed by N neighbours". Everything is DEMO ("Synthetic demo: ..."), testnet only.
// Usage: node scripts/seed-demo-pin.mjs <PIN> [baseUrl] [--live-cuts]   (start the server first: scripts/local-server.sh)
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signAction } from "../src/lib/signing.js";
const args = process.argv.slice(2).filter((a) => !a.startsWith("--")), liveCuts = process.argv.includes("--live-cuts");
const PIN = args[0], base = args[1] ?? "http://127.0.0.1:18431";
if (!/^\d{6}$/.test(PIN ?? "")) throw new Error("usage: seed-demo-pin.mjs <6-digit PIN>");
// [days ago, start hour IST, start minute, duration minutes, area]
const PLAN = [
  [41, 19, 20, 38, "Synthetic demo: evening, main road"], [36, 2, 10, 245, "Synthetic demo: night cut, whole lane"],
  [30, 11, 45, 72, "Synthetic demo: morning, market side"], [24, 21, 5, 130, "Synthetic demo: evening peak"],
  [19, 14, 30, 27, "Synthetic demo: short afternoon cut"], [14, 23, 40, 310, "Synthetic demo: night cut, transformer"],
  [9, 7, 15, 95, "Synthetic demo: early morning"], [5, 18, 50, 185, "Synthetic demo: evening, rain"],
  [2, 3, 25, 160, "Synthetic demo: night cut"],
];
const dev = privateKeyToAccount(generatePrivateKey()); // throwaway device key: it only signs
const DAY = 86_400_000, now = Date.now();
const liveFrom = Number((process.argv.find((a) => a.startsWith("--live-from=")) ?? "--live-from=1").split("=")[1]); // resume after an interruption
for (const [ago, h, m, dur, area] of liveFrom > 1 ? [] : PLAN) {
  const day0 = Math.floor((now - ago * DAY + 330 * 60_000) / DAY) * DAY - 330 * 60_000; // IST midnight
  const s = day0 + (h * 60 + m) * 60_000, e = s + dur * 60_000;
  const body = await signAction(dev, { action: "backfill", pin: PIN, started_at_ms: s, ended_at_ms: e, area, note: "Synthetic demo record", ts: Date.now() });
  const r = await fetch(`${base}/api/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${r.status} ${j.error}`);
  console.log(PIN, new Date(s + 330 * 60_000).toISOString().slice(0, 16), dur + " min", j.txHash);
}

if (liveCuts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = async (acct, fields) => {
    const body = await signAction(acct, { pin: PIN, ts: Date.now(), ...fields });
    const r = await fetch(`${base}/api/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw new Error(`${fields.action}: ${r.status} ${j.error}`); return j;
  };
  // [went-at minutes ago, neighbours who confirm, minutes between confirmations, area]
  for (const [wentAgo, neighbours, gapMin, area] of [[72, 4, 0.2, "Synthetic demo: east block"], [0, 2, 3, "Synthetic demo: market lane"], [0, 5, 2.5, "Synthetic demo: station road"]].slice(liveFrom - 1)) {
    const rep = generatePrivateKey(), reporter = privateKeyToAccount(rep);
    const o = await post(reporter, { action: "report", area, note: "Synthetic demo record", ...(wentAgo && { started_at_ms: Date.now() - wentAgo * 60_000 }) });
    console.log("report", area, o.txHash);
    for (let k = 0; k < neighbours; k++) {
      await sleep(gapMin * 60_000);
      const n = await post(privateKeyToAccount(generatePrivateKey()), { action: "still_dark", outage: o.created[0] });
      console.log(" still dark", k + 1, n.txHash, "counted", n.counted);
    }
    await sleep(20_000);
    const b = await post(reporter, { action: "power_back", outage: o.created[0] });
    console.log("power back", b.txHash);
    await sleep(60_000);
  }
}

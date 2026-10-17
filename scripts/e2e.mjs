// Real end-to-end write run against Tiramisu through the running relay server (needs funded relay).
// Usage: node --env-file=.env.local scripts/e2e.mjs [baseUrl]   (start the server first: npm run dev / local-server.sh)
// Records are labelled "TEST RUN" (source=user, signed by throwaway device keys). Prints tx hashes and keys.
// Permissionless extension: a throwaway TESTNET key funded with 0.05 GLM extends the lease without owning it.
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signAction } from "../src/lib/signing.js";
import { q, decodeConfirm, decodeCutLog, fetchAll, explorer } from "../src/lib/schema.js";

const base = process.argv[2] ?? "http://127.0.0.1:18431", PIN = "110001";
const pc = createPublicClient({ chain: tiramisu, transport: http() });
const relayAcct = privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY);
const relayWc = createWalletClient({ chain: tiramisu, transport: http(), account: relayAcct });
const [A, B, C] = [1, 2, 3].map(() => privateKeyToAccount(generatePrivateKey()));
const post = async (acct, fields) => {
  const body = await signAction(acct, { pin: PIN, ts: Date.now(), ...fields });
  const r = await fetch(`${base}/api/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${fields.action}: ${r.status} ${j.error}`); return j;
};
const out = {};
const rep = await post(A, { action: "report", area: "TEST RUN (synthetic)", note: "end-to-end check" }); out.report = rep; console.log("report", rep.txHash, rep.created);
const outage = rep.created[0];
const expiry = async () => Number((await pc.getEntity(outage)).expiresAt);
const e0 = await expiry();
await new Promise((r) => setTimeout(r, 4000));
const s1 = await post(B, { action: "still_dark", outage }); console.log("still_dark B (neighbour: batch confirm+extend)", s1.txHash, "counted", s1.counted);
const e1 = await expiry();
const s2 = await post(A, { action: "still_dark", outage }); console.log("still_dark A (reporter: extend only)", s2.txHash, "counted", s2.counted);
const s3 = await post(C, { action: "still_dark", outage }); console.log("still_dark C (neighbour)", s3.txHash, "counted", s3.counted);
const e2 = await expiry();
console.log("lease expiry block:", e0, "->", e1, "->", e2);
// permissionless extension by a wallet that does NOT own the entity (throwaway testnet key)
const T = privateKeyToAccount(generatePrivateKey());
const fund = await relayWc.sendTransaction({ to: T.address, value: parseEther("0.05") });
await pc.waitForTransactionReceipt({ hash: fund });
const tWc = createWalletClient({ chain: tiramisu, transport: http(), account: T });
const ext = await tWc.extendEntity({ entityKey: outage, expires: ExpirationTime.fromHours(2) });
const e3 = await expiry();
const owner = (await pc.getEntity(outage)).owner;
console.log("permissionless extend by non-owner", T.address, ext.txHash, "owner is", owner, "expiry ->", e3);
const pb = await post(A, { action: "power_back", outage }); console.log("power_back (batch: cut_log + delete outage)", pb.txHash, "confirmers", pb.confirmers, "created", pb.created, "deleted", pb.deleted);
await new Promise((r) => setTimeout(r, 4000));
let gone = false; try { await pc.getEntity(outage); } catch { gone = true; }
const confirms = (await fetchAll(pc.select({ key: true, creator: true, attributes: true, payload: true }).where(q.confirmsFor(outage)))).map(decodeConfirm);
const cut = (await fetchAll(pc.select({ key: true, creator: true, expiresAt: true, attributes: true, payload: true }).where(q.cutLogFor(outage)))).map(decodeCutLog);
console.log("outage deleted:", gone, "| confirms:", confirms.length, "| cut_log:", cut.map((c) => `${c.key} ${c.durationMin}min confirmers=${c.confirmers}`));
// readonly check: relay tries to update the cut_log
let roErr = "no error (UNEXPECTED)"; try { await relayWc.patchEntity({ entityKey: cut[0].key, set: { note_edit: "x" } }); } catch (e) { roErr = (e.shortMessage ?? e.message).split("\n")[0]; }
console.log("update of readonly cut_log:", roErr);
console.log(JSON.stringify({ outage, cut: cut[0]?.key, explorer: { outage: explorer.entity(outage), cut: explorer.entity(cut[0]?.key), power_back_tx: explorer.tx(pb.txHash), report_tx: explorer.tx(rep.txHash) }, expiry: [e0, e1, e2, e3], ext: ext.txHash, pb: pb.txHash }, null, 1));

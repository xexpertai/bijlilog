// Copies the discom's OFFICIAL planned-shutdown notices to Arkiv (type=planned_notice, source=official).
// Not resident reports, not demo data. Source: Tata Power-DDL public "Scheduled Outage" page (see src/lib/notices.js).
// Usage: node --env-file=.env.local scripts/ingest-notices.mjs [--dry] [--file page.html]
//   --dry   fetch + parse + print, write nothing   |   --file  parse a saved page instead of fetching (for tests)
// One GET of the page and one GET of robots.txt per run; windows that already ended are skipped (a lease cannot start in the past).
import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TPDDL, parseTpddl, noticeId, robotsAllows } from "../src/lib/notices.js";
import { plannedNoticeCreate, q, fetchAll, decodeNotice } from "../src/lib/schema.js";

const dry = process.argv.includes("--dry");
const fileArg = process.argv.indexOf("--file") > 0 ? process.argv[process.argv.indexOf("--file") + 1] : null;
const UA = "BijliLog-notice-ingest/1.0 (hackathon prototype; github.com/xexpertai/bijlilog)";
const fetchedAtMs = Date.now();

let html;
if (fileArg) html = await readFile(fileArg, "utf8");
else {
  const robots = await (await fetch(TPDDL.robots, { headers: { "user-agent": UA } })).text();
  const path = new URL(TPDDL.url).pathname;
  if (!robotsAllows(robots, path)) { console.error(`robots.txt disallows ${path}; stopping.`); process.exit(3); }
  const res = await fetch(TPDDL.url, { headers: { "user-agent": UA } });
  if (!res.ok) { console.error("source page returned HTTP", res.status); process.exit(4); }
  html = await res.text();
}
const { listTitle, rows, skipped } = parseTpddl(html);
console.log(`source: ${TPDDL.name} | "${listTitle}" | parsed ${rows.length} notices${skipped ? `, ${skipped} unreadable rows skipped` : ""}`);
const live = rows.filter((r) => r.endMs - fetchedAtMs >= 120_000);
console.log(`${live.length} still running or upcoming (${rows.length - live.length} windows already ended: not written, a lease cannot start in the past)`);
for (const r of live) console.log(`  ${r.district} / zone ${r.zone} | ${r.area} | ${new Date(r.startMs + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")} to ${new Date(r.endMs + 330 * 60_000).toISOString().slice(11, 16)} IST | ${r.description}`);
if (dry || !live.length) process.exit(0);

const account = privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY);
const pc = createPublicClient({ chain: tiramisu, transport: http() });
const wc = createWalletClient({ chain: tiramisu, transport: http(), account });
const bal = await pc.getBalance({ address: account.address });
console.log("relay wallet", account.address, "balance GLM", formatEther(bal));
if (bal === 0n) { console.error("Wallet has 0 test GLM."); process.exit(2); }

// Idempotent: skip notices whose id is already on chain (one query for all ids).
const withId = live.map((r) => ({ r, id: noticeId(TPDDL.id, r) }));
const existing = new Set((await fetchAll(pc.select({ key: true, attributes: true }).where(q.plannedNoticeIds(withId.map((x) => x.id))).createdBy(account.address))).map((e) => e.attributes?.notice_id?.value));
const fresh = withId.filter((x) => !existing.has(x.id));
console.log(`${existing.size} already on chain, writing ${fresh.length}`);
const out = { txs: [], entities: [] };
for (let i = 0; i < fresh.length; i += 5) {
  const creates = fresh.slice(i, i + 5).map((x) => plannedNoticeCreate({ n: x.r, discom: TPDDL, noticeId: x.id, fetchedAtMs: Date.now() }));
  const res = await wc.executeBatch({ creates });
  out.txs.push(res.txHash); out.entities.push(...res.createdEntities);
  console.log("batch", i / 5 + 1, res.txHash);
}
console.log(JSON.stringify(out, null, 1));

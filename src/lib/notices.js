// Official planned-shutdown notices from a discom's public page. Pure parsing, no network.
// Source (checked 17 Oct 2026, see KB/KNOWLEDGE.md "Notices source check"):
//   Tata Power-DDL "Scheduled Outage" page, https://www.tatapower-ddl.com/scheduleoutage/119/customers/outage-details/scheduled-outage
// The page lists, per day, a table: S.No, Discom, Distt, Zone, Description, Date Time from, Date Time to, Area affected, Duration.
// It gives NO PIN code. We never invent one.
import { createHash } from "node:crypto";

export const TPDDL = {
  id: "tpddl",
  name: "Tata Power-DDL",
  url: "https://www.tatapower-ddl.com/scheduleoutage/119/customers/outage-details/scheduled-outage",
  robots: "https://www.tatapower-ddl.com/robots.txt",
  // Tata Power-DDL's licensed area is north and north-west Delhi (postal PIN 110xxx). This mapping is ours, not part of the notice.
  pinPrefix: "110",
};

const ENT = { "&amp;": "&", "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const clean = (s) => s.replace(/<[^>]+>/g, " ").replace(/&(amp|nbsp|lt|gt|quot|#39);/g, (m) => ENT[m]).replace(/\s+/g, " ").trim();

/** "17.10.26 10:30" (IST wall clock) -> ms since epoch, or NaN. */
export function parseIstStamp(s) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return NaN;
  const [d, mo, y, H, M] = m.slice(1).map(Number);
  const year = y < 100 ? 2000 + y : y;
  return Date.UTC(year, mo - 1, d, H, M) - 330 * 60_000;
}

/** Parse the page HTML. Returns { listTitle, rows:[{sno,district,zone,description,startMs,endMs,area}], skipped }. */
export function parseTpddl(html) {
  const start = html.indexOf('id="DivContent"');
  if (start < 0) throw new Error("outage table not found (page layout changed?)");
  const end = html.indexOf("</table>", start);
  const table = html.slice(start, end < 0 ? undefined : end);
  const rows = []; let listTitle = ""; let skipped = 0;
  for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(clean);
    if (cells.length === 1) { listTitle = cells[0]; continue; }
    if (cells.length < 9 || !/^\d+$/.test(cells[0])) continue; // header or junk
    const [sno, , district, zone, description, from, to, area] = cells;
    const startMs = parseIstStamp(from), endMs = parseIstStamp(to);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs) || !district || !area) { skipped++; continue; }
    rows.push({ sno: Number(sno), district, zone, description, startMs, endMs, area });
  }
  return { listTitle, rows, skipped };
}

/** Stable id so a re-run never writes the same notice twice. */
export function noticeId(discomId, r) {
  return createHash("sha256").update([discomId, r.district, r.zone, r.area, r.startMs, r.endMs].join("|")).digest("hex").slice(0, 16);
}

/** robots.txt check for the `*` group: false if the path is disallowed. Deliberately simple (prefix match). */
export function robotsAllows(robotsTxt, path) {
  let applies = false; const dis = [];
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === "user-agent") applies = m[2].trim() === "*";
    else if (applies && k === "disallow" && m[2].trim()) dis.push(m[2].trim());
  }
  return !dis.some((d) => path.startsWith(d));
}

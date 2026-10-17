import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTpddl, parseIstStamp, noticeId, robotsAllows, TPDDL } from "../src/lib/notices.js";
import { plannedNoticeCreate, decodeNotice, q, PROJECT, NOTICE_SOURCE } from "../src/lib/schema.js";
import { render } from "@arkiv-network/sdk/query";

// Synthetic page in the same table structure as the discom's page (invented rows, only for the parser).
const td = (v) => `<td class="x">${v}</td>`;
const row = (...c) => `<tr>${c.map(td).join("")}</tr>`;
const PAGE = `<html><body><div id="DivContent"><table><tbody>
<tr><td colspan="9">TEST DISCOM Distribution System Outage Request From 01-Jan-2030</td></tr>
${row("S. No", "Discom", "Distt", "Zone", "DESCRIPTION", "Date Time from", "Date  Time to", "Area  affected", "Total Duration")}
${row("1", "TEST  DISCOM", "TESTVILLE", "414", "PLANNED  MAINTENANCE", "01.01.30  10:30", "01.01.30  14:30", "PART OF A &amp; B COLONY&nbsp;", "4")}
${row("2", "TEST DISCOM", "OTHERTOWN", "415", "TREE TRIMMING", "01.01.30  23:00", "02.01.30  01:00", "&nbsp;PART OF SEC-18", "2")}
${row("3", "TEST DISCOM", "BROKEN", "416", "BAD TIMES", "oops", "01.01.30  12:00", "PART OF X", "2")}
${row("4", "TEST DISCOM", "BACKWARDS", "417", "END BEFORE START", "01.01.30  12:00", "01.01.30  10:00", "PART OF Y", "2")}
</tbody></table></div></body></html>`;

test("parser reads rows, decodes entities, converts IST to UTC and skips unreadable rows", () => {
  const { listTitle, rows, skipped } = parseTpddl(PAGE);
  assert.match(listTitle, /Request From 01-Jan-2030/);
  assert.equal(rows.length, 2);
  assert.equal(skipped, 2);
  assert.equal(rows[0].area, "PART OF A & B COLONY");
  assert.equal(rows[0].description, "PLANNED MAINTENANCE");
  assert.equal(rows[0].startMs, Date.UTC(2030, 0, 1, 5, 0)); // 10:30 IST = 05:00 UTC
  assert.equal(rows[1].endMs, Date.UTC(2030, 0, 1, 19, 30)); // window crossing midnight: 01:00 IST on the 2nd
  assert.equal(rows[1].area, "PART OF SEC-18");
});

test("parser refuses a page without the table instead of guessing", () => {
  assert.throws(() => parseTpddl("<html>nope</html>"), /not found/);
  assert.ok(Number.isNaN(parseIstStamp("tomorrow")));
});

test("notice ids are stable and differ per window", () => {
  const { rows } = parseTpddl(PAGE);
  assert.equal(noticeId("t", rows[0]), noticeId("t", { ...rows[0] }));
  assert.notEqual(noticeId("t", rows[0]), noticeId("t", rows[1]));
  assert.match(noticeId("t", rows[0]), /^[0-9a-f]{16}$/);
});

test("robots.txt check honours the * group", () => {
  assert.equal(robotsAllows("User-agent: *\nAllow: /\nDisallow: /webtest", "/scheduleoutage/119"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /scheduleoutage", "/scheduleoutage/119"), false);
  assert.equal(robotsAllows("User-agent: other\nDisallow: /", "/x"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow:", "/x"), true);
});

test("planned_notice entity: official source, no PIN attribute, lease ends with the window", () => {
  const { rows } = parseTpddl(PAGE);
  const fetchedAtMs = rows[0].startMs - 60 * 60_000; // an hour before the window
  const c = plannedNoticeCreate({ n: rows[0], discom: TPDDL, noticeId: "abc", fetchedAtMs });
  assert.equal(c.attributes.type.value, "planned_notice");
  assert.equal(c.attributes.source.value, NOTICE_SOURCE);
  assert.equal(c.attributes.project.value, PROJECT);
  assert.equal(c.attributes.pin, undefined, "the source gives no PIN, so none is stored");
  assert.equal(c.attributes.source_url.value, TPDDL.url);
  assert.equal(c.flags.readonly, true);
  // the lease ends exactly when the discom's window ends (wall-clock expiry)
  assert.equal(c.expires.expiresAt.getTime(), rows[0].endMs);
  assert.throws(() => plannedNoticeCreate({ n: rows[0], discom: TPDDL, noticeId: "abc", fetchedAtMs: rows[0].endMs }), /already over/);
});

test("notice decode and queries", () => {
  const { rows } = parseTpddl(PAGE);
  const c = plannedNoticeCreate({ n: rows[0], discom: TPDDL, noticeId: "abc", fetchedAtMs: rows[0].startMs - 1000 });
  const fake = { key: "0x" + "ab".repeat(32), creator: "0x1", expiresAt: 5n, attributes: c.attributes, toJson: () => ({ area: rows[0].area, description: rows[0].description, discom_name: "Tata Power-DDL" }) };
  const d = decodeNotice(fake);
  assert.equal(d.discomName, "Tata Power-DDL"); assert.equal(d.district, "TESTVILLE"); assert.equal(d.startMs, rows[0].startMs); assert.equal(d.area, "PART OF A & B COLONY");
  assert.equal(q.plannedNotices().map((p) => render(p)).join(" AND "), `project = str('${PROJECT}') AND type = str('planned_notice')`);
  assert.match(q.plannedNoticeIds(["a", "b"]).map((p) => render(p)).join(" AND "), /notice_id = str\('a'\) OR notice_id = str\('b'\)/);
});

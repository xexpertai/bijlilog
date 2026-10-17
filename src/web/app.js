// BijliLog browser app. Reads go straight from the browser to Arkiv (HTTP for queries,
// WebSocket for live entity events). Writes are signed by a local device key and sent to the relay.
import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { render } from "@arkiv-network/sdk/query";
import { http, webSocket, fallback } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SEAL_ADDRESS, q, decodeOutage, decodeConfirm, decodeCutLog, decodeNotice, distinctConfirmers, identityOf, fetchAll, explorer } from "../lib/schema.js";
import { isPincode, isPinPrefix, checkPublicText, checkBackfill } from "../lib/validate.js";
import { buildComplaint } from "../lib/complaint.js";
import { summarize, minutesByDayIST, istDate, istTime, toCSV } from "../lib/stats.js";
import { signAction, verifySigned, parseMessage } from "../lib/signing.js";
import { RELAYS, BLOCK_SECONDS } from "./config.js";
import { STR } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } },
};

let lang = store.get("bijlilog.lang") === "hi" ? "hi" : "en";
const t = (k, ...a) => { const v = STR[lang][k] ?? STR.en[k]; return typeof v === "function" ? v(...a) : v; };

// Direct from the browser first; if the anonymous Arkiv RPC budget is exhausted, fall back to the same-origin read proxy.
const publicClient = createPublicClient({ chain: tiramisu, transport: fallback([http(), http(`${location.origin}/rpc`)], { retryCount: 0 }) });
let relays = [...RELAYS];
let writesEnabled = false;

// Device key: generated once per browser, signs actions, never funded, never sent anywhere.
let deviceKey = store.get("bijlilog.deviceKey");
if (!/^0x[0-9a-f]{64}$/i.test(deviceKey ?? "")) { deviceKey = generatePrivateKey(); store.set("bijlilog.deviceKey", deviceKey); }
const device = privateKeyToAccount(deviceKey);

const view = { pin: "", days: 60, confirmed: false, long: false, demo: true, cuts: [], open: [], confirmsBy: new Map(), head: 0n, showAll: false, calAll: false, notices: [] };

// ---------- tiny DOM helper (all chain data goes through textContent) ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") Object.assign(el.style, v); // CSSOM, allowed by the strict CSP
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const fmtDur = (min) => (min >= 60 ? `${Math.floor(min / 60)} ${t("h")} ${String(min % 60).padStart(2, "0")} ${t("min")}` : `${min} ${t("min")}`);
const locale = () => (lang === "hi" ? "hi-IN" : "en-IN");
const dayMonth = (ymd) => { const d = new Date(`${ymd}T00:00:00Z`); return { day: d.getUTCDate(), mon: d.toLocaleDateString(locale(), { month: "short", timeZone: "UTC" }), full: d.toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: "UTC" }), dow: (d.getUTCDay() + 6) % 7 }; };
function toast(msg) { const el = $("toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(toast.tm); toast.tm = setTimeout(() => el.classList.remove("show"), 3600); }
const isRateLimit = (e) => /429|ANON_COST|rate.?limit|budget/i.test(`${e?.message ?? ""} ${e?.shortMessage ?? ""} ${e?.details ?? ""}`);

function applyLang() {
  document.documentElement.lang = lang === "hi" ? "hi" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const b of document.querySelectorAll(".lang button")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
}

// ---------- signature check, shown only on records that are not demo data ----------
async function proofBadge(rec, expectedAction) {
  if (rec.source === "demo" && !rec.signed) return null; // the DEMO badge is shown instead (a signed demo row reads "DEMO · signed ✓")
  const viaRelay = relays.some((r) => r.toLowerCase() === (rec.creator ?? "").toLowerCase());
  if (!viaRelay) return h("span", { class: "badge" }, `wallet ${short(rec.creator)}`);
  let ok = false;
  if (rec.signed && rec.device) {
    ok = await verifySigned(rec.signed, rec.device);
    try { const m = parseMessage(rec.signed.msg); ok = ok && m.pin === rec.pin && (!expectedAction || expectedAction.includes(m.action)); } catch { ok = false; }
  }
  return h("span", { class: `badge ${ok ? "ok" : "bad"}`, title: rec.device ?? "" }, `${ok ? t("sigOk") : t("sigBad")} ${short(rec.device)}`);
}

// ---------- data loading ----------
async function loadNow(pin) {
  view.head = await publicClient.getBlockNumber();
  const raw = await fetchAll(publicClient.select({ key: true, creator: true, owner: true, expiresAt: true, attributes: true, payload: true })
    .where(q.liveOutages(pin)).createdBy(relays[0]));
  const outages = raw.map(decodeOutage).sort((a, b) => b.startedAtMs - a.startedAtMs);
  // Hide leases already closed by someone else's "Power's back". Two queries for all outages (OR on the outage key).
  let open = outages; const confirmsBy = new Map();
  if (outages.length) {
    const keys = outages.map((o) => o.key);
    const closedRaw = await fetchAll(publicClient.select({ key: true, attributes: true }).where(q.cutLogForAny(keys)).createdBy(relays[0]));
    const closed = new Set(closedRaw.map((e) => e.attributes?.outage?.value?.toLowerCase()));
    open = outages.filter((o) => !closed.has(o.key.toLowerCase()));
    if (open.length) {
      const all = (await fetchAll(publicClient.select({ key: true, creator: true, attributes: true, payload: true }).where(q.confirmsForAny(open.map((o) => o.key))).createdBy(relays[0]))).map(decodeConfirm);
      for (const c of all) { const k = (c.outage ?? "").toLowerCase(); confirmsBy.set(k, [...(confirmsBy.get(k) ?? []), c]); }
    }
  }
  view.open = open; view.confirmsBy = confirmsBy;
}

async function loadHistory(pin) {
  const sinceMs = Date.now() - view.days * 86_400_000;
  const filters = { pinOrPrefix: pin, sinceMs, minConfirmers: view.confirmed ? 1 : 0, minDurationMin: view.long ? 240 : 0, source: view.demo ? undefined : "user" };
  const preds = q.history(filters);
  const raw = await fetchAll(publicClient.select({ key: true, creator: true, owner: true, expiresAt: true, attributes: true, payload: true }).where(preds).createdBy(relays[0]));
  // The query filters on source=user, but a few early test records (TEST_RUN_KEYS) are stored as user and read as demo.
  view.cuts = raw.map(decodeCutLog).filter((c) => filters.source !== "user" || c.source !== "demo").sort((a, b) => b.startedAtMs - a.startedAtMs);
  view.queries = [
    "// Live cuts for this PIN (HTTP JSON-RPC arkiv_query, or the SDK):",
    q.liveOutages(pin).map((p) => render(p)).join(" AND ") + ` AND $creator = addr(${relays[0]})`,
    "", "// History shown on this page:",
    preds.map((p) => render(p)).join(" AND ") + ` AND $creator = addr(${relays[0]})`,
  ].join("\n");
}

async function loadNotices() {
  const raw = await fetchAll(publicClient.select({ key: true, creator: true, expiresAt: true, attributes: true, payload: true })
    .where(q.plannedNotices()).createdBy(relays[0]));
  view.notices = raw.map(decodeNotice).filter((n) => n.endMs > Date.now()).sort((a, b) => a.startMs - b.startMs);
}

// Official notices are a separate record type (planned_notice): blue "OFFICIAL NOTICE" rows, never mixed with resident reports or DEMO rows.
function renderNotices() {
  const card = $("notices-card"), box = $("notices"); const list = view.notices;
  $("notices-count").textContent = t("noticesCount", list.length);
  const delhi = view.pin.startsWith("110");
  card.classList.toggle("hot", delhi && list.length > 0);
  if (delhi && list.length && !card.dataset.touched) card.open = true;
  if (!list.length) { box.replaceChildren(h("p", { class: "hint" }, t("noticesEmpty"))); return; }
  box.replaceChildren(...list.map((n) => {
    const day = dayMonth(istDate(n.startMs)).full;
    return h("article", { class: "notice" },
      h("div", { class: "when" }, `${day}, ${istTime(n.startMs)}–${istTime(n.endMs)} IST`),
      h("div", {}, `${n.area} · ${n.district} (${t("noticeZone")} ${n.zone})`),
      n.description && h("div", { class: "hint" }, n.description),
      h("div", { class: "sub" }, h("span", { class: "badge official" }, t("noticesBadge", n.discomName)), " ",
        h("a", { href: n.sourceUrl, target: "_blank", rel: "noopener" }, t("noticeSrc")), " · ",
        h("a", { href: explorer.entity(n.key), target: "_blank", rel: "noopener" }, t("chain")), " · ",
        h("span", { class: "hint" }, t("noticeFetched", istTime(n.fetchedAtMs)))));
  }));
}

// ---------- rendering ----------
function renderStatus() {
  const box = $("status"); const pin = view.pin; const full = pin.length === 6;
  box.replaceChildren(); box.setAttribute("aria-busy", "false");
  $("report-card").hidden = true;
  if (!full) {
    box.append(h("div", { class: "status area" },
      h("div", { class: "eyebrow" }, t("areaEyebrow")),
      h("h2", { class: "calm-title" }, t("areaTitle", pin, view.open.length)),
      h("p", { class: "sub" }, t("areaReadOnly"))));
    if (view.open.length) for (const o of view.open) box.append(outageCard(o, false));
    return;
  }
  if (!view.open.length) {
    box.append(h("div", { class: "status calm" },
      h("div", { class: "eyebrow" }, t("calmEyebrow")),
      h("h2", { class: "calm-title" }, t("calmTitle", pin)),
      h("p", { class: "sub" }, t("calmSub")),
      view.cuts[0] && h("p", { class: "sub last-cut" }, t("lastCut", `${dayMonth(istDate(view.cuts[0].startedAtMs)).full}`, fmtDur(view.cuts[0].durationMin)), view.cuts[0].source === "demo" && " ", view.cuts[0].source === "demo" && h("span", { class: "badge demo" }, t("demo"))),
      writesEnabled && h("button", { class: "btn danger big", type: "button", onclick: () => { $("report-card").hidden = false; $("area").focus(); $("report-card").scrollIntoView({ block: "center" }); } }, "⚡ " + t("powerCutHere")),
      h("a", { class: "btn ghost big-ish", target: "_blank", rel: "noopener", href: `https://wa.me/?text=${encodeURIComponent(t("neighbourMsg", pin, `${location.origin}/?pin=${pin}`))}` }, t("tellNeighbours"))));
    return;
  }
  for (const o of view.open) box.append(outageCard(o, true));
}

function outageCard(o, canAct) {
  const confirms = (view.confirmsBy.get(o.key.toLowerCase()) ?? []).filter((c) => relays.some((r) => r.toLowerCase() === c.creator.toLowerCase()));
  const n = distinctConfirmers(confirms, identityOf(o, relays), relays);
  const leftMin = Math.max(0, Math.round(Number(o.expiresAt - view.head) * BLOCK_SECONDS / 60));
  const pct = Math.min(100, Math.round((leftMin / 120) * 100));
  const dots = h("span", { class: "dots", "aria-hidden": "true" }, Array.from({ length: 5 }, (_, i) => h("i", { class: i < n ? "on" : "" })));
  return h("div", { class: "status out" },
    h("div", { class: "eyebrow" }, h("span", { class: "pulse" }), t("noPowerNow"), o.source === "demo" && h("span", { class: "badge demo" }, t("demo")), view.pin.length < 6 && h("span", { class: "badge" }, o.pin)),
    h("div", { class: "big-time", "data-since": String(o.startedAtMs) }, fmtDur(Math.max(1, Math.round((Date.now() - o.startedAtMs) / 60000)))),
    h("div", { class: "sub" }, `${t("sinceAt", istTime(o.startedAtMs))} · ${t("lasting")}`),
    (o.area || o.note) && h("div", { class: "place" }, "📍 " + [o.area, o.note].filter(Boolean).join(" — ")),
    h("div", { class: "facts" }, h("span", {}, dots, t("neighbours", n))),
    h("div", {}, h("div", { class: "lease", role: "img", "aria-label": t("leaseLeft", fmtDur(leftMin)) }, h("b", { style: { width: `${pct}%` } })), h("p", { class: "hint", style: { color: "inherit", opacity: ".85" } }, t("leaseLeft", fmtDur(leftMin)))),
    canAct && writesEnabled && h("div", { class: "btn-row" },
      h("button", { class: "btn danger", type: "button", onclick: (e) => act(e.currentTarget, { action: "still_dark", pin: view.pin, outage: o.key }) }, t("stillDark")),
      h("button", { class: "btn ok", type: "button", onclick: (e) => act(e.currentTarget, { action: "power_back", pin: view.pin, outage: o.key }) }, t("powerBack"))),
    h("a", { href: explorer.entity(o.key), target: "_blank", rel: "noopener", class: "hint", style: { color: "inherit" } }, t("chain")));
}

function renderScope() {
  const nDemo = view.cuts.filter((c) => c.source === "demo").length + view.open.filter((o) => o.source === "demo").length;
  const on = view.demo;
  $("scope").replaceChildren(
    h("span", { class: `scope-chip ${on && nDemo ? "demo" : "real"}` }, on ? (nDemo ? t("scopeDemo", nDemo) : t("scopeReal")) : t("scopeReal")),
    h("button", { class: "linkbtn", type: "button", onclick: () => { view.demo = !view.demo; pressed($("f-demo"), view.demo); view.pin && show(view.pin, { quiet: true }); } }, on ? t("scopeHide") : t("scopeShow")));
}

function renderTiles() {
  const s = summarize(view.cuts);
  const tile = (v, label, unit) => h("div", { class: "tile" }, h("b", {}, v, unit && h("small", {}, ` ${unit}`)), h("span", {}, label));
  $("tiles").replaceChildren(
    tile(s.count, t("cuts")), tile(s.totalHours, t("hoursOff"), t("h")),
    tile(fmtDur(s.longestMin), t("longest")), tile(s.nightCuts, t("nightCuts")));
}

function renderHeat() {
  const days = view.days;
  let strip = minutesByDayIST(view.cuts, days, Date.now());
  // Phones: a 60-day calendar pushes the history far down, so show the latest 35 days first.
  const short60 = days === 60 && window.matchMedia("(max-width: 599px)").matches && !view.calAll;
  if (short60) strip = strip.slice(-35);
  const more = $("heat-more"); more.hidden = !short60; more.textContent = t("showAll60", days);
  const level = (m) => (m === 0 ? 0 : m < 60 ? 1 : m < 180 ? 2 : m < 360 ? 3 : 4); // matches the legend: none, <1 h, 1-3 h, 3-6 h, 6+ h
  const dows = lang === "hi" ? ["सो", "मं", "बु", "गु", "शु", "श", "र"] : ["M", "T", "W", "T", "F", "S", "S"];
  const cells = dows.map((d) => h("div", { class: "dow", "aria-hidden": "true" }, d));
  const first = dayMonth(strip[0].day).dow;
  for (let i = 0; i < first; i++) cells.push(h("div", { class: "cell pad", "aria-hidden": "true" }));
  strip.forEach((d, i) => {
    const dm = dayMonth(d.day);
    cells.push(h("div", { class: `cell l${level(d.minutes)}${i === strip.length - 1 ? " today" : ""}`, title: t("cellLabel", dm.full, fmtDur(d.minutes)) }, dm.day));
  });
  const heat = $("heat");
  heat.setAttribute("aria-label", t("calLabel", days, summarize(view.cuts).totalHours));
  heat.replaceChildren(...cells);
}

async function renderHistory() {
  const box = $("history"); const pin = view.pin;
  if (!view.cuts.length) {
    box.replaceChildren(h("div", { class: "empty" }, h("b", {}, t("emptyTitle")), h("span", {}, t("emptySub"))));
    return;
  }
  const rows = [];
  for (const c of view.cuts.slice(0, view.showAll ? 500 : 20)) {
    const dm = dayMonth(istDate(c.startedAtMs));
    const proof = await proofBadge(c, ["power_back", "backfill"]);
    rows.push(h("article", { class: "cut" },
      h("div", { class: "date", "aria-hidden": "true" }, h("b", {}, dm.day), h("span", {}, dm.mon)),
      h("div", {},
        h("div", { class: "when" }, `${istTime(c.startedAtMs)}–${istTime(c.endedAtMs)}`),
        h("div", { class: "sub" },
          c.source === "demo" && h("span", { class: "badge demo" }, t("demo")),
          pin.length < 6 && h("span", { class: "badge" }, c.pin),
          c.origin === "backfill" ? h("span", { class: "badge" }, t("backfill")) : h("span", {}, t("confirmedBy", c.confirmers)), proof,
          c.owner?.toLowerCase() === SEAL_ADDRESS.toLowerCase() && h("span", { class: "badge ok", title: t("sealedTip") }, t("sealed")),
          h("a", { href: explorer.entity(c.key), target: "_blank", rel: "noopener" }, t("chain")))),
      h("div", { class: `dur${c.durationMin >= 240 ? " long" : ""}` }, fmtDur(c.durationMin))));
  }
  if (!view.showAll && view.cuts.length > 20) rows.push(h("button", { class: "btn ghost", type: "button", onclick: () => { view.showAll = true; renderHistory(); } }, `+${view.cuts.length - 20}`));
  box.replaceChildren(...rows);
}

function renderRecent() {
  let list = []; try { list = JSON.parse(store.get("bijlilog.recent") ?? "[]"); } catch { /* ignore */ }
  $("recent").replaceChildren(...list.filter((p) => p !== view.pin).slice(0, 4).map((p) => h("button", { class: "chip", type: "button", onclick: () => { $("pin").value = p; show(p); } }, p)));
}
function remember(pin) {
  let list = []; try { list = JSON.parse(store.get("bijlilog.recent") ?? "[]"); } catch { /* ignore */ }
  store.set("bijlilog.recent", JSON.stringify([pin, ...list.filter((p) => p !== pin)].slice(0, 5)));
}

function renderAll() {
  renderStatus(); renderNotices(); renderScope(); renderTiles(); renderHeat(); renderHistory(); renderRecent();
  $("queries").textContent = view.queries ?? "";
}

function renderError(e, retry) {
  const box = $("status"); box.setAttribute("aria-busy", "false");
  box.replaceChildren(h("div", { class: "err", role: "alert" }, h("span", {}, isRateLimit(e) ? t("rateLimited") : t("loadErr")), h("button", { class: "btn", type: "button", onclick: retry }, t("retry"))));
}

async function show(pin, { quiet = false } = {}) {
  if (!isPinPrefix(pin)) { toast(t("enterPin")); return; }
  view.pin = pin; view.showAll = false;
  store.set("bijlilog.pin", pin); remember(pin);
  history.replaceState(null, "", `?pin=${pin}`);
  if (!quiet) { const s = $("status"); s.setAttribute("aria-busy", "true"); s.replaceChildren(h("div", { class: "skeleton", "aria-hidden": "true" })); }
  try {
    await Promise.all([loadNow(pin), loadHistory(pin)]);
    renderAll();
  } catch (e) { renderError(e, () => show(pin)); }
}

// keep "for 1 h 20 min" fresh without hitting the network
setInterval(() => {
  for (const el of document.querySelectorAll(".big-time[data-since]")) el.textContent = fmtDur(Math.max(1, Math.round((Date.now() - Number(el.dataset.since)) / 60000)));
}, 30_000);

// ---------- writes ----------
async function act(btn, action) {
  const btns = [...document.querySelectorAll("button")]; btns.forEach((b) => (b.disabled = true));
  toast(t("sending"));
  try {
    const signed = await signAction(device, { ...action, ts: Date.now() });
    const res = await fetch("/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body.outageKey) toast(t("already"));
    else if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    else toast(`${t("done")} · tx ${short(body.txHash)}`);
    await show(view.pin, { quiet: true });
  } catch (e) {
    toast(e.message);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

function todayAt(hhmm) {
  if (!hhmm) return undefined;
  const [H, M] = hhmm.split(":").map(Number);
  // Interpret as IST wall-clock time today; if that is in the future, it was yesterday.
  const nowIst = new Date(Date.now() + 330 * 60_000);
  let ms = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate(), H, M) - 330 * 60_000;
  if (ms > Date.now()) ms -= 86_400_000;
  return ms;
}
const istLocalToMs = (v) => (v ? Date.parse(`${v}:00+05:30`) : NaN);

// ---------- live updates over WebSocket ----------
function startLive() {
  try {
    const ws = createPublicClient({ chain: tiramisu, transport: webSocket() });
    let timer = null;
    const mine = (owner) => relays.some((r) => r.toLowerCase() === (owner ?? "").toLowerCase());
    ws.watchEntityEvents({
      onEvent: (e) => {
        if (!mine(e.owner ?? e.newOwner)) return;
        $("live-text").textContent = `· ${t("newEvent")} (block ${e.blockNumber})`;
        clearTimeout(timer);
        timer = setTimeout(() => view.pin && show(view.pin, { quiet: true }), 1200);
      },
      onError: () => { $("live-dot").hidden = true; },
    });
    $("live-dot").hidden = false;
  } catch { $("live-dot").hidden = true; }
}

// ---------- wire up ----------
function pressed(btn, on) { btn.setAttribute("aria-pressed", String(on)); }
async function init() {
  applyLang();
  $("device-addr").textContent = device.address;
  $("relay-addr").textContent = relays.join(", ");
  try {
    const cfg = await (await fetch("/api/config")).json();
    writesEnabled = !!cfg.writesEnabled;
  } catch { writesEnabled = false; }

  for (const b of document.querySelectorAll(".lang button")) b.addEventListener("click", () => {
    lang = b.dataset.lang; store.set("bijlilog.lang", lang); applyLang();
    if (view.pin && $("status").getAttribute("aria-busy") === "false") renderAll();
  });
  $("pin-form").addEventListener("submit", (e) => { e.preventDefault(); $("pin").blur(); show($("pin").value.trim()); });
  for (const b of $("range").querySelectorAll("button")) b.addEventListener("click", async () => {
    view.days = Number(b.dataset.days); for (const x of $("range").querySelectorAll("button")) pressed(x, x === b);
    view.pin && show(view.pin, { quiet: true });
  });
  for (const [id, key] of [["f-confirmed", "confirmed"], ["f-long", "long"], ["f-demo", "demo"]]) $(id).addEventListener("click", () => {
    view[key] = !view[key]; pressed($(id), view[key]); view.pin && show(view.pin, { quiet: true });
  });
  $("report-cancel").addEventListener("click", () => { $("report-card").hidden = true; });
  $("report-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const area = checkPublicText($("area").value), note = checkPublicText($("note").value);
    if (!area.ok) return toast(area.reason);
    if (!note.ok) return toast(note.reason);
    act(e.submitter, { action: "report", pin: view.pin, area: area.value, note: note.value, started_at_ms: todayAt($("went-at").value) });
  });
  $("show-backfill").addEventListener("click", () => { const f = $("backfill-form"); f.hidden = !f.hidden; $("show-backfill").setAttribute("aria-expanded", String(!f.hidden)); });
  $("backfill-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!isPincode(view.pin)) return toast(t("enterPin"));
    const s = istLocalToMs($("bf-start").value), en = istLocalToMs($("bf-end").value);
    const chk = checkBackfill({ startedAtMs: s, endedAtMs: en, nowMs: Date.now() });
    if (!chk.ok) return toast(chk.reason);
    const note = checkPublicText($("bf-note").value);
    if (!note.ok) return toast(note.reason);
    act(e.submitter, { action: "backfill", pin: view.pin, started_at_ms: s, ended_at_ms: en, note: note.value });
  });
  $("heat-more").addEventListener("click", () => { view.calAll = true; renderHeat(); });
  const dlg = $("complaint-dialog"); let cpLang = lang;
  const fillComplaint = () => {
    const { text } = buildComplaint({ cuts: view.cuts, pin: view.pin, lang: cpLang, explorerEntity: explorer.entity, maxRows: 40 });
    // WhatsApp links get long once percent-encoded (Hindi especially), so the shared text lists at most 8 rows and points to the CSV.
    const wa = buildComplaint({ cuts: view.cuts, pin: view.pin, lang: cpLang, explorerEntity: explorer.entity, maxRows: 8 }).text;
    $("complaint-text").value = text;
    $("cp-wa").href = `https://wa.me/?text=${encodeURIComponent(wa)}`;
    pressed($("cp-en"), cpLang === "en"); pressed($("cp-hi"), cpLang === "hi");
  };
  $("complaint").addEventListener("click", () => { if (!isPincode(view.pin)) return toast(t("enterPin")); cpLang = lang; fillComplaint(); dlg.showModal(); });
  $("cp-en").addEventListener("click", () => { cpLang = "en"; fillComplaint(); });
  $("cp-hi").addEventListener("click", () => { cpLang = "hi"; fillComplaint(); });
  $("cp-close").addEventListener("click", () => dlg.close());
  $("cp-copy").addEventListener("click", async () => {
    const ta = $("complaint-text");
    try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand("copy"); }
    toast(t("copied"));
  });
  $("csv").addEventListener("click", () => {
    const blob = new Blob([toCSV(view.cuts, explorer.entity)], { type: "text/csv" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `bijlilog-${view.pin}-${istDate(Date.now())}.csv` });
    document.body.append(a); a.click(); a.remove();
  });

  $("notices-card").addEventListener("toggle", () => { $("notices-card").dataset.touched = "1"; });
  loadNotices().then(renderNotices).catch(() => { $("notices").replaceChildren(h("p", { class: "hint" }, t("loadErr"))); });
  setInterval(() => loadNotices().then(renderNotices).catch(() => {}), 600_000);
  renderRecent();
  const fromUrl = new URLSearchParams(location.search).get("pin");
  const pin = fromUrl ?? store.get("bijlilog.pin") ?? "411001"; // first visit: show the Pune demo PIN so the page is never empty
  if (pin) { $("pin").value = pin; show(pin); } else { $("status").setAttribute("aria-busy", "false"); renderEmptyStart(); }
  startLive();
}
function renderEmptyStart() {
  $("status").replaceChildren(h("div", { class: "status area" }, h("div", { class: "eyebrow" }, "⚡ BijliLog"), h("h2", { class: "calm-title" }, t("pinLabel")), h("p", { class: "sub" }, t("pinHint"))));
}
init();

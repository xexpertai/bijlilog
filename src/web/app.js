// BijliLog browser app. Reads go straight from the browser to Arkiv (HTTP for queries,
// WebSocket for live entity events). Writes are signed by a local device key and sent to the relay.
import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { render } from "@arkiv-network/sdk/query";
import { http, webSocket, fallback } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { q, decodeOutage, decodeConfirm, decodeCutLog, distinctConfirmers, identityOf, fetchAll, explorer } from "../lib/schema.js";
import { isPincode, isPinPrefix, checkPublicText, checkBackfill } from "../lib/validate.js";
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

let current = { pin: "", cuts: [] };

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
const fmtDur = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`);
function toast(msg) { const el = $("toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(toast.tm); toast.tm = setTimeout(() => el.classList.remove("show"), 3200); }

function applyLang() {
  document.documentElement.lang = lang === "hi" ? "hi" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  $("lang").textContent = lang === "hi" ? "English" : "हिंदी";
}

// ---------- signature check shown on every record ----------
async function proofBadge(rec, expectedAction) {
  const viaRelay = relays.some((r) => r.toLowerCase() === (rec.creator ?? "").toLowerCase());
  if (!viaRelay) return h("span", { class: "badge" }, `wallet ${short(rec.creator)}`);
  if (rec.source === "demo" && !rec.signed) return h("span", { class: "badge demo" }, t("demo"));
  let ok = false;
  if (rec.signed && rec.device) {
    ok = await verifySigned(rec.signed, rec.device);
    try { const m = parseMessage(rec.signed.msg); ok = ok && m.pin === rec.pin && (!expectedAction || expectedAction.includes(m.action)); } catch { ok = false; }
  }
  return h("span", { class: `badge ${ok ? "ok" : "bad"}`, title: rec.device ?? "" }, `${ok ? t("sigOk") : t("sigBad")} ${short(rec.device)}`);
}

// ---------- Right now ----------
async function loadNow(pin) {
  const box = $("now");
  const head = await publicClient.getBlockNumber();
  const raw = await fetchAll(publicClient.select({ key: true, creator: true, owner: true, expiresAt: true, attributes: true, payload: true })
    .where(q.liveOutages(pin)).createdBy(relays[0]));
  const outages = raw.map(decodeOutage).sort((a, b) => b.startedAtMs - a.startedAtMs);
  // Hide leases already closed by someone else's "Power's back" (they expire on their own shortly).
  // Two queries for all outages together (OR on the outage key), not two per outage.
  let open = outages, confirmsBy = new Map();
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
  box.replaceChildren();
  const fullPin = pin.length === 6;
  $("report-card").hidden = !(fullPin && open.length === 0 && writesEnabled);
  if (!open.length) { box.append(h("p", { class: "calm" }, fullPin ? t("noCut") : t("noCutArea"))); }
  if (!fullPin) box.append(h("p", { class: "hint" }, t("areaReadOnly")));
  for (const o of open) {
    const confirms = (confirmsBy.get(o.key.toLowerCase()) ?? []).filter((c) => relays.some((r) => r.toLowerCase() === c.creator.toLowerCase()));
    const n = distinctConfirmers(confirms, identityOf(o, relays), relays);
    const leftMin = Math.max(0, Math.round(Number(o.expiresAt - head) * BLOCK_SECONDS / 60));
    const sinceMin = Math.max(1, Math.round((Date.now() - o.startedAtMs) / 60000));
    const card = h("div", { class: "outage" },
      h("div", { class: "since" }, `${t("outSince")} ${istTime(o.startedAtMs)}`, h("span", { class: "hint" }, ` · ${t("forDur")} ${fmtDur(sinceMin)}`)),
      (o.area || o.note) && h("div", {}, [o.area, o.note].filter(Boolean).join(" — ")),
      h("div", { class: "meta" },
        o.source === "demo" && h("span", { class: "badge demo" }, t("demo")),
        !fullPin && h("span", { class: "badge" }, o.pin),
        h("span", {}, t("neighbours", n)),
        h("span", {}, t("leaseLeft", fmtDur(leftMin))),
        await proofBadge(o, ["report"]),
        h("a", { href: explorer.entity(o.key), target: "_blank", rel: "noopener" }, "explorer ↗")),
      fullPin && writesEnabled && h("div", { class: "btn-row" },
        h("button", { class: "btn", type: "button", onclick: (e) => act(e.currentTarget, { action: "still_dark", pin, outage: o.key }) }, t("stillDark")),
        h("button", { class: "btn ok", type: "button", onclick: (e) => act(e.currentTarget, { action: "power_back", pin, outage: o.key }) }, t("powerBack"))));
    box.append(card);
  }
}

// ---------- History ----------
async function loadHistory(pin) {
  const days = Number($("range").value);
  const sinceMs = Date.now() - days * 86_400_000;
  const filters = {
    pinOrPrefix: pin, sinceMs,
    minConfirmers: $("f-confirmed").checked ? 1 : 0,
    minDurationMin: $("f-long").checked ? 240 : 0,
    source: $("f-demo").checked ? undefined : "user",
  };
  const preds = q.history(filters);
  const raw = await fetchAll(publicClient.select({ key: true, creator: true, expiresAt: true, attributes: true, payload: true }).where(preds).createdBy(relays[0]));
  const cuts = raw.map(decodeCutLog).sort((a, b) => b.startedAtMs - a.startedAtMs);
  current.cuts = cuts;
  const s = summarize(cuts);
  $("tiles").replaceChildren(...[[s.count, t("cuts")], [s.totalHours, t("hoursOff")], [fmtDur(s.longestMin), t("longest")], [s.longCuts, t("longCuts")], [s.nightCuts, t("nightCuts")]]
    .map(([v, l]) => h("div", { class: "tile" }, h("b", {}, v), h("span", {}, l))));
  const strip = minutesByDayIST(cuts, days, Date.now());
  const max = Math.max(60, ...strip.map((d) => d.minutes));
  $("strip").replaceChildren(...strip.map((d) => h("i", { class: d.minutes ? "" : "zero", style: { height: `${Math.max(2, Math.round((d.minutes / max) * 100))}%` }, title: `${d.day}: ${fmtDur(d.minutes)}` })));
  if (!cuts.length) { $("history").replaceChildren(h("p", { class: "empty" }, t("none"))); return; }
  const rows = [];
  for (const c of cuts.slice(0, 100)) {
    rows.push(h("tr", {},
      h("td", { class: "num" }, `${istDate(c.startedAtMs).slice(5)} ${istTime(c.startedAtMs)}–${istTime(c.endedAtMs)}`, pin.length < 6 ? h("div", { class: "hint" }, c.pin) : null),
      h("td", { class: "num" }, fmtDur(c.durationMin)),
      h("td", { class: "num" }, String(c.confirmers)),
      h("td", {}, c.source === "demo" && h("span", { class: "badge demo" }, t("demo")), " ",
        c.origin === "backfill" && h("span", { class: "badge" }, t("backfill")), " ",
        await proofBadge(c, ["power_back", "backfill"]), " ",
        h("a", { href: explorer.entity(c.key), target: "_blank", rel: "noopener" }, "↗"))));
  }
  $("history").replaceChildren(h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, t("when")), h("th", {}, t("dur")), h("th", {}, t("conf")), h("th", {}, t("proof")))),
    h("tbody", {}, rows))));
  $("queries").textContent = [
    "// Live cuts for this PIN (HTTP JSON-RPC arkiv_query, or the SDK):",
    q.liveOutages(pin).map((p) => render(p)).join(" AND ") + ` AND $creator = addr(${relays[0]})`,
    "",
    "// History shown above:",
    preds.map((p) => render(p)).join(" AND ") + ` AND $creator = addr(${relays[0]})`,
  ].join("\n");
}

async function show(pin) {
  if (!isPinPrefix(pin)) { toast(t("enterPin")); return; }
  current.pin = pin;
  store.set("bijlilog.pin", pin);
  history.replaceState(null, "", `?pin=${pin}`);
  await Promise.all([loadNow(pin), loadHistory(pin)]).catch((e) => toast(e?.shortMessage ?? e?.message ?? "Arkiv read failed"));
}

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
    await show(current.pin);
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
        $("live-text").textContent = `${t("newEvent")}: ${e.type} · block ${e.blockNumber}`;
        clearTimeout(timer);
        timer = setTimeout(() => current.pin && show(current.pin), 1200);
      },
      onError: () => { $("live-dot").hidden = true; },
    });
    $("live-dot").hidden = false;
  } catch { $("live-dot").hidden = true; }
}

// ---------- wire up ----------
async function init() {
  applyLang();
  $("device-addr").textContent = device.address;
  $("relay-addr").textContent = relays.join(", ");
  try {
    const cfg = await (await fetch("/api/config")).json();
    writesEnabled = !!cfg.writesEnabled;
    if (cfg.relay && !relays.some((r) => r.toLowerCase() === cfg.relay.toLowerCase())) {
      console.warn("server relay differs from the published RELAYS list; reads keep using the published list");
    }
  } catch { writesEnabled = false; }

  $("lang").addEventListener("click", () => { lang = lang === "hi" ? "en" : "hi"; store.set("bijlilog.lang", lang); applyLang(); current.pin && show(current.pin); });
  $("pin-form").addEventListener("submit", (e) => { e.preventDefault(); show($("pin").value.trim()); });
  for (const id of ["range", "f-confirmed", "f-long", "f-demo"]) $(id).addEventListener("change", () => current.pin && loadHistory(current.pin));
  $("report-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const area = checkPublicText($("area").value), note = checkPublicText($("note").value);
    if (!area.ok) return toast(area.reason);
    if (!note.ok) return toast(note.reason);
    act(e.submitter, { action: "report", pin: current.pin, area: area.value, note: note.value, started_at_ms: todayAt($("went-at").value) });
  });
  $("show-backfill").addEventListener("click", () => { $("backfill-form").hidden = !$("backfill-form").hidden; });
  $("backfill-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!isPincode(current.pin)) return toast(t("enterPin"));
    const s = istLocalToMs($("bf-start").value), en = istLocalToMs($("bf-end").value);
    const chk = checkBackfill({ startedAtMs: s, endedAtMs: en, nowMs: Date.now() });
    if (!chk.ok) return toast(chk.reason);
    const note = checkPublicText($("bf-note").value);
    if (!note.ok) return toast(note.reason);
    act(e.submitter, { action: "backfill", pin: current.pin, started_at_ms: s, ended_at_ms: en, note: note.value });
  });
  $("csv").addEventListener("click", () => {
    const blob = new Blob([toCSV(current.cuts, explorer.entity)], { type: "text/csv" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `bijlilog-${current.pin}-${istDate(Date.now())}.csv` });
    document.body.append(a); a.click(); a.remove();
  });

  const fromUrl = new URLSearchParams(location.search).get("pin");
  const pin = fromUrl ?? store.get("bijlilog.pin") ?? "";
  if (pin) { $("pin").value = pin; show(pin); }
  startLive();
}
init();

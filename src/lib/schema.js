// BijliLog data contract on Arkiv. One place for entity types, attributes, lifetimes and queries.
// Shared by the browser app, the seed script and the judge CLI. See /arkiv/schema.md.
import { ExpirationTime, jsonToPayload, str, u64, i32, key, addr } from "@arkiv-network/sdk";
import { eq, gte, lte, startsWith, or } from "@arkiv-network/sdk/query";

export const PROJECT = "bijlilog-v1";
export const EXPLORER = "https://tiramisu.explorer.arkiv.network";

// Lifetimes follow product logic (see /arkiv/schema.md, "Entity Expiration").
export const LIFETIME = {
  // A live outage is a 2-hour lease. Any neighbour who taps "Still dark" renews it
  // (permissionless Lifetime Extension). If nobody renews it, it leaves the live map by itself.
  outageLeaseHours: 2,
  // A neighbour's confirmation is evidence for the cut it confirms, kept for one billing dispute window.
  confirmDays: 30,
  // A finished cut is the record people use for complaints and yearly reliability stats.
  cutLogDays: 365,
};

export const leaseExpiry = () => ExpirationTime.fromHours(LIFETIME.outageLeaseHours);
export const confirmExpiry = () => ExpirationTime.fromDays(LIFETIME.confirmDays);
export const cutLogExpiry = () => ExpirationTime.fromDays(LIFETIME.cutLogDays);

export const SOURCES = ["user", "demo"];

// ---------- builders (pure: return SDK create/batch params) ----------

export function outageCreate({ pin, startedAtMs, area = "", note = "", source = "user", device, signed }) {
  return {
    payload: jsonToPayload({ v: 1, area, note, ...(signed && { signed }) }),
    contentType: "application/json",
    attributes: {
      project: str(PROJECT),
      type: str("outage"),
      pin: str(pin),
      started_at_ms: u64(startedAtMs),
      source: str(source),
      ...deviceAttr(device),
    },
    expires: leaseExpiry(),
    // Neighbours who are not the owner may still renew the lease, but can never edit the report.
    flags: { permissionlessExtension: true },
  };
}

export function confirmCreate({ outageKey, pin, kind, atMs, source = "user", device, signed }) {
  if (!["still_out", "restored"].includes(kind)) throw new Error(`bad confirm kind: ${kind}`);
  return {
    payload: jsonToPayload({ v: 1, ...(signed && { signed }) }),
    contentType: "application/json",
    attributes: {
      project: str(PROJECT),
      type: str("confirm"),
      outage: key(outageKey),
      pin: str(pin),
      kind: str(kind),
      at_ms: u64(atMs),
      source: str(source),
      ...deviceAttr(device),
    },
    expires: confirmExpiry(),
    flags: { readonly: true },
  };
}

export function cutLogCreate({ outageKey, pin, startedAtMs, endedAtMs, confirmers, origin, area = "", note = "", source = "user", device, signed }) {
  if (!(endedAtMs > startedAtMs)) throw new Error("a cut must end after it starts");
  if (!["live", "backfill"].includes(origin)) throw new Error(`bad origin: ${origin}`);
  const attributes = {
    project: str(PROJECT),
    type: str("cut_log"),
    pin: str(pin),
    started_at_ms: u64(startedAtMs),
    ended_at_ms: u64(endedAtMs),
    duration_min: i32(Math.max(1, Math.round((endedAtMs - startedAtMs) / 60000))),
    confirmers: i32(confirmers),
    origin: str(origin),
    source: str(source),
    ...deviceAttr(device),
  };
  if (outageKey) attributes.outage = key(outageKey);
  return {
    payload: jsonToPayload({ v: 1, area, note, ...(signed && { signed }) }),
    contentType: "application/json",
    attributes,
    expires: cutLogExpiry(),
    // A published cut record can never be edited, by us or anyone. It can still be extended.
    flags: { readonly: true, permissionlessExtension: true },
  };
}

// "Still dark" from a neighbour: the confirmation and the lease renewal land together or not at all.
export function stillDarkBatch({ outageKey, pin, atMs, source = "user", device, signed }) {
  return {
    creates: [confirmCreate({ outageKey, pin, kind: "still_out", atMs, source, device, signed })],
    extensions: [{ entityKey: outageKey, expires: leaseExpiry() }],
  };
}

// "Power's back": write the permanent record; if the caller owns the live report, retire it in the same tx.
export function powerBackBatch({ outage, endedAtMs, confirmers, callerIsOwner, source = "user", device, signed }) {
  const batch = {
    creates: [cutLogCreate({
      outageKey: outage.key, pin: outage.pin, startedAtMs: outage.startedAtMs, endedAtMs,
      confirmers, origin: "live", area: outage.area, note: outage.note, source, device, signed,
    })],
  };
  if (callerIsOwner) batch.deletes = [{ entityKey: outage.key }];
  return batch;
}

// In relay mode the server pays for the write and $creator is the relay wallet; the person's
// device address (a key that only ever signs, never holds funds) is recorded here and its
// signature travels in the payload so anyone can re-verify it.
function deviceAttr(device) {
  return device ? { device: addr(device) } : {};
}

// ---------- queries (pure: return predicate arrays for select().where(...)) ----------

const base = (type) => [eq("project", str(PROJECT)), eq("type", str(type))];

/** pinOrPrefix: a full 6-digit pincode (exact) or a 1-5 digit prefix (postal region / sorting district). */
export function pinPredicate(pinOrPrefix) {
  return pinOrPrefix.length === 6 ? eq("pin", str(pinOrPrefix)) : startsWith("pin", pinOrPrefix);
}

export const q = {
  liveOutages: (pinOrPrefix) => [...base("outage"), pinPredicate(pinOrPrefix)],
  confirmsFor: (outageKey) => [...base("confirm"), eq("outage", key(outageKey))],
  // One query for any number of outages (OR), so a page load costs a constant number of queries.
  confirmsForAny: (keys) => [...base("confirm"), keys.length === 1 ? eq("outage", key(keys[0])) : or(...keys.map((k) => eq("outage", key(k))))],
  cutLogForAny: (keys) => [...base("cut_log"), keys.length === 1 ? eq("outage", key(keys[0])) : or(...keys.map((k) => eq("outage", key(k))))],
  cutLogFor: (outageKey) => [...base("cut_log"), eq("outage", key(outageKey))],
  history: ({ pinOrPrefix, sinceMs, untilMs, minConfirmers = 0, minDurationMin = 0, source }) => {
    const p = [...base("cut_log"), pinPredicate(pinOrPrefix), gte("started_at_ms", u64(sinceMs))];
    if (source) p.push(eq("source", str(source)));
    if (untilMs !== undefined) p.push(lte("started_at_ms", u64(untilMs)));
    if (minConfirmers > 0) p.push(gte("confirmers", i32(minConfirmers)));
    if (minDurationMin > 0) p.push(gte("duration_min", i32(minDurationMin)));
    return p;
  },
};

// ---------- decoding ----------

const val = (e, name) => e.attributes?.[name]?.value;

export function decodeOutage(e) {
  const body = safeJson(e);
  return {
    key: e.key, creator: e.creator, owner: e.owner, expiresAt: e.expiresAt,
    pin: val(e, "pin"), startedAtMs: Number(val(e, "started_at_ms")), source: val(e, "source"),
    device: val(e, "device") ?? null, signed: body.signed ?? null,
    area: str60(body.area), note: str60(body.note),
  };
}

export function decodeConfirm(e) {
  const body = safeJson(e);
  return { key: e.key, creator: e.creator, device: val(e, "device") ?? null, signed: body.signed ?? null,
    outage: val(e, "outage"), kind: val(e, "kind"), atMs: Number(val(e, "at_ms")) };
}

export function decodeCutLog(e) {
  const body = safeJson(e);
  return {
    key: e.key, creator: e.creator, expiresAt: e.expiresAt, outage: val(e, "outage") ?? null,
    pin: val(e, "pin"), startedAtMs: Number(val(e, "started_at_ms")), endedAtMs: Number(val(e, "ended_at_ms")),
    durationMin: val(e, "duration_min"), confirmers: val(e, "confirmers"), origin: val(e, "origin"),
    source: val(e, "source"), device: val(e, "device") ?? null, signed: body.signed ?? null,
    area: str60(body.area), note: str60(body.note),
  };
}

/**
 * Who a record speaks for. Entities written by a trusted relay speak for the signing device;
 * entities written directly by any other wallet speak for that wallet ($creator, unforgeable).
 */
export function identityOf(rec, relays) {
  const viaRelay = relays.some((r) => r.toLowerCase() === (rec.creator ?? "").toLowerCase());
  return (viaRelay && rec.device ? rec.device : rec.creator ?? "").toLowerCase();
}

function safeJson(e) {
  try { const j = e.toJson ? e.toJson() : {}; return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
const str60 = (s) => (typeof s === "string" ? s.slice(0, 60) : "");

/** Distinct neighbours who confirmed, excluding the original reporter (self-confirmation does not count). */
export function distinctConfirmers(confirms, reporterIdentity, relays = []) {
  const r = (reporterIdentity ?? "").toLowerCase();
  return new Set(confirms.filter((c) => c.kind === "still_out").map((c) => identityOf(c, relays)).filter((a) => a && a !== r)).size;
}

/** Walk every page of a query (cursor pagination, max 200 per page). */
export async function fetchAll(builder, max = 2000) {
  let page = await builder.limit(200).fetch();
  const out = [...page.entities];
  while (page.hasNextPage() && out.length < max) {
    page = await page.next();
    out.push(...page.entities);
  }
  return out;
}

export const explorer = {
  tx: (h) => `${EXPLORER}/tx/${h}`,
  entity: (k) => `${EXPLORER}/entity/${k}`,
  address: (a) => `${EXPLORER}/address/${a}`,
};

// Relay: turns a device-signed action into Arkiv writes paid by the (testnet) relay wallet.
// Pure logic with injected clients so it can be unit-tested without a network.
import { isAddress, getAddress } from "viem";
import { parseMessage, verifySigned, canonicalMessage } from "../src/lib/signing.js";
import { isPincode, checkPublicText, checkBackfill } from "../src/lib/validate.js";
import {
  PROJECT, outageCreate, cutLogCreate, stillDarkBatch, powerBackBatch, leaseExpiry,
  q, decodeOutage, decodeConfirm, decodeCutLog, distinctConfirmers, identityOf, fetchAll,
} from "../src/lib/schema.js";

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const DAY = 86_400_000;

export function createRelay({ publicClient, walletClient, now = () => Date.now(), limits = {} }) {
  const L = { perDevicePerDay: 30, perIpPerDay: 80, globalPerDay: 600, clockSkewMs: 5 * 60_000, ...limits };
  const relayAddress = walletClient.account.address;
  const counters = new Map(); // "kind:id:day" -> count
  const usedSigs = new Set();
  let queue = Promise.resolve();

  function bump(kind, id, max) {
    const k = `${kind}:${id}:${Math.floor(now() / DAY)}`;
    const n = (counters.get(k) ?? 0) + 1;
    if (n > max) throw new HttpError(429, `daily limit reached (${kind}); try again tomorrow`);
    counters.set(k, n);
    if (counters.size > 50_000) counters.clear();
  }

  /** Serialize writes: one relay wallet, one nonce sequence. */
  function enqueue(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  async function loadOutage(outageKey) {
    let e;
    try {
      e = await publicClient.getEntity(outageKey);
    } catch {
      throw new HttpError(404, "that outage report is no longer live (it expired or was closed)");
    }
    const a = e.attributes ?? {};
    if (a.project?.value !== PROJECT || a.type?.value !== "outage") throw new HttpError(400, "not a BijliLog outage");
    return { raw: e, outage: decodeOutage(e) };
  }

  async function handle({ device, msg, sig }, { ip = "unknown" } = {}) {
    // 1. Authenticate the device and the exact text it signed.
    if (!isAddress(device ?? "")) throw new HttpError(400, "bad device address");
    device = getAddress(device);
    let a;
    try { a = parseMessage(msg); } catch { throw new HttpError(400, "bad message"); }
    if (canonicalMessage(a) !== msg) throw new HttpError(400, "message is not canonical");
    if (!(await verifySigned({ msg, sig }, device))) throw new HttpError(401, "signature does not match device");
    const ts = Number(a.ts);
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > L.clockSkewMs) throw new HttpError(400, "message timestamp too old or in the future");
    if (usedSigs.has(sig)) throw new HttpError(409, "this signed action was already used");

    // 2. Validate the content before anything is paid for.
    if (!isPincode(a.pin ?? "")) throw new HttpError(400, "PIN code must be 6 digits");
    const area = checkPublicText(a.area ?? "");
    const note = checkPublicText(a.note ?? "");
    if (!area.ok) throw new HttpError(400, `area: ${area.reason}`);
    if (!note.ok) throw new HttpError(400, `note: ${note.reason}`);

    bump("device", device, L.perDevicePerDay);
    bump("ip", ip, L.perIpPerDay);
    bump("global", "all", L.globalPerDay);
    usedSigs.add(sig);
    if (usedSigs.size > 100_000) usedSigs.clear();

    const signed = { msg, sig };
    const common = { device, signed };
    // Acting on a DEMO outage produces DEMO records, never records that look like real user reports.
    const srcOf = (outage) => (outage?.source === "demo" ? "demo" : "user");

    return enqueue(async () => {
      switch (a.action) {
        case "report": {
          const startedAtMs = a.started_at_ms ? Number(a.started_at_ms) : ts;
          if (!(startedAtMs <= now() + 60_000 && now() - startedAtMs <= 12 * 3_600_000))
            throw new HttpError(400, "start time must be within the last 12 hours");
          // One live report per PIN: point the person at the existing one instead of duplicating it.
          const live = await publicClient.select({ key: true }).where(q.liveOutages(a.pin)).createdBy(relayAddress).limit(1).fetch();
          if (live.entities.length) throw new HttpError(409, "a power cut is already live for this PIN; confirm it instead", { outageKey: live.entities[0].key });
          const r = await walletClient.createEntity(outageCreate({ pin: a.pin, startedAtMs, area: area.value, note: note.value, source: "user", ...common }));
          return { action: "report", txHash: r.txHash, created: [r.entityKey] };
        }
        case "still_dark": {
          const { outage } = await loadOutage(a.outage);
          if (outage.pin !== a.pin) throw new HttpError(400, "PIN does not match the outage");
          const reporter = identityOf(outage, [relayAddress]);
          const mine = device.toLowerCase();
          const already = (await fetchAll(publicClient.select({ key: true, creator: true, attributes: true, payload: true }).where(q.confirmsFor(outage.key))))
            .map(decodeConfirm).some((c) => identityOf(c, [relayAddress]) === mine);
          if (reporter === mine || already) {
            // The reporter (or a repeat confirmer) only renews the lease; it does not count as a new witness.
            const r = await walletClient.extendEntity({ entityKey: outage.key, expires: leaseExpiry() });
            return { action: "still_dark", txHash: r.txHash, extended: [outage.key], counted: false };
          }
          const r = await walletClient.executeBatch(stillDarkBatch({ outageKey: outage.key, pin: outage.pin, atMs: ts, source: srcOf(outage), ...common }));
          return { action: "still_dark", txHash: r.txHash, created: r.createdEntities, extended: [outage.key], counted: true };
        }
        case "power_back": {
          const { outage } = await loadOutage(a.outage);
          if (outage.pin !== a.pin) throw new HttpError(400, "PIN does not match the outage");
          const existing = await publicClient.select({ key: true }).where(q.cutLogFor(outage.key)).createdBy(relayAddress).limit(1).fetch();
          if (existing.entities.length) throw new HttpError(409, "this cut is already logged", { cutLogKey: existing.entities[0].key });
          const endedAtMs = Math.min(ts, now());
          if (!(endedAtMs > outage.startedAtMs)) throw new HttpError(400, "end must be after start");
          const confirms = (await fetchAll(publicClient.select({ key: true, creator: true, attributes: true, payload: true }).where(q.confirmsFor(outage.key)))).map(decodeConfirm);
          const confirmers = distinctConfirmers(confirms, identityOf(outage, [relayAddress]), [relayAddress]);
          // Predict the key the new cut_log will get so the same batch can hand it to the seal address.
          const sealKey = publicClient.predictEntityKeys ? (await publicClient.predictEntityKeys({ owner: relayAddress, count: 1 }))[0] : undefined;
          const callerIsOwner = outage.owner?.toLowerCase() === relayAddress.toLowerCase();
          const r = await walletClient.executeBatch(powerBackBatch({ outage, endedAtMs, confirmers, callerIsOwner, source: srcOf(outage), sealKey, ...common }));
          return { action: "power_back", txHash: r.txHash, created: r.createdEntities, deleted: r.deletedEntities ?? [], confirmers };
        }
        case "backfill": {
          const startedAtMs = Number(a.started_at_ms), endedAtMs = Number(a.ended_at_ms);
          const chk = checkBackfill({ startedAtMs, endedAtMs, nowMs: now() });
          if (!chk.ok) throw new HttpError(400, chk.reason);
          const r = await walletClient.createEntity(cutLogCreate({
            pin: a.pin, startedAtMs, endedAtMs, confirmers: 0, origin: "backfill", area: area.value, note: note.value, source: "user", ...common,
          }));
          return { action: "backfill", txHash: r.txHash, created: [r.entityKey] };
        }
        default:
          throw new HttpError(400, "unknown action");
      }
    });
  }

  return { handle, relayAddress };
}

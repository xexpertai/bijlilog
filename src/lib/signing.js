// Signed actions: what a device signs, and how anyone (the relay, a judge, another app) checks it.
// The signed text is stored in the entity payload, so verification needs only Arkiv data.
import { verifyMessage } from "viem";

export const ACTIONS = ["report", "still_dark", "power_back", "backfill"];
const FIELDS = ["action", "pin", "outage", "started_at_ms", "ended_at_ms", "area", "note", "ts"];

/** Canonical text a device signs. Field order is fixed; absent fields are empty. */
export function canonicalMessage(a) {
  if (!ACTIONS.includes(a.action)) throw new Error(`unknown action ${a.action}`);
  const lines = FIELDS.map((f) => `${f}=${a[f] === undefined || a[f] === null ? "" : String(a[f]).replace(/[\r\n]/g, " ")}`);
  return ["BijliLog signed action v1", ...lines].join("\n");
}

/** Parse the canonical text back into an action object (used when re-verifying stored payloads). */
export function parseMessage(text) {
  const [head, ...lines] = String(text).split("\n");
  if (head !== "BijliLog signed action v1") throw new Error("not a BijliLog message");
  const out = {};
  for (const l of lines) {
    const i = l.indexOf("=");
    const k = l.slice(0, i), v = l.slice(i + 1);
    if (FIELDS.includes(k) && v !== "") out[k] = v;
  }
  return out;
}

/** Sign with a viem account (local device key) or a wallet client. Returns { msg, sig, device }. */
export async function signAction(account, action) {
  const msg = canonicalMessage(action);
  const sig = await account.signMessage({ message: msg });
  return { msg, sig, device: account.address };
}

/** True if `signed.sig` over `signed.msg` recovers to `device`. */
export async function verifySigned(signed, device) {
  if (!signed?.msg || !signed?.sig || !device) return false;
  try {
    return await verifyMessage({ address: device, message: signed.msg, signature: signed.sig });
  } catch {
    return false;
  }
}

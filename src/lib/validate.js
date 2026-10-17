// Input checks that run before anything is written to Arkiv. Everything on Arkiv is public,
// so free text is short and is refused if it looks like personal data.

/** India Post PIN codes: 6 digits, first digit 1-9 (the region). */
export function isPincode(s) {
  return typeof s === "string" && /^[1-9][0-9]{5}$/.test(s);
}

/** A PIN prefix for area-wide views: 1 to 6 digits, first digit 1-9. */
export function isPinPrefix(s) {
  return typeof s === "string" && /^[1-9][0-9]{0,5}$/.test(s);
}

const PII_PATTERNS = [
  { re: /[\w.+-]+@[\w-]+\.[\w.]+/, why: "an email address" },
  { re: /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/, why: "a phone number" },
  { re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, why: "a 12-digit ID number" },
  { re: /\d{7,}/, why: "a long number (account, meter or phone numbers are private)" },
  { re: /\b(?:h\.?\s?no|house\s?no|flat\s?no|plot\s?no)\b/i, why: "a house or flat number" },
];

/**
 * Validate a short public label (area or note). Returns { ok, value, reason }.
 * Max 60 characters; refuses emails, phone numbers, ID-like and long numbers, house numbers.
 */
export function checkPublicText(input, { max = 60 } = {}) {
  const value = String(input ?? "").replace(/\s+/g, " ").trim();
  if (value.length > max) return { ok: false, value, reason: `keep it under ${max} characters` };
  for (const { re, why } of PII_PATTERNS) {
    if (re.test(value)) return { ok: false, value, reason: `looks like ${why}; this log is public, so leave it out` };
  }
  return { ok: true, value };
}

/** A backfilled cut must be in the past, end after it starts, last under 7 days, and be at most 60 days old. */
export function checkBackfill({ startedAtMs, endedAtMs, nowMs }) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return { ok: false, reason: "enter both times" };
  if (endedAtMs <= startedAtMs) return { ok: false, reason: "power must come back after it went" };
  if (endedAtMs > nowMs + 60_000) return { ok: false, reason: "the end time is in the future" };
  if (endedAtMs - startedAtMs > 7 * 86_400_000) return { ok: false, reason: "a single cut over 7 days: split it or check the dates" };
  if (nowMs - startedAtMs > 60 * 86_400_000) return { ok: false, reason: "only cuts from the last 60 days can be added" };
  return { ok: true };
}

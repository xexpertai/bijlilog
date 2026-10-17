// Reliability summary for one PIN code over a period, computed from cut_log entities.
// The counts mirror the two everyday questions: how often did power go, and for how long.

/**
 * @param {Array<{startedAtMs:number,endedAtMs:number,durationMin:number,confirmers:number}>} cuts
 * @param {{longCutMin?:number}} opts  longCutMin: threshold for "long cuts" (default 4 hours)
 */
export function summarize(cuts, { longCutMin = 240 } = {}) {
  const totalMin = cuts.reduce((s, c) => s + c.durationMin, 0);
  const longest = cuts.reduce((m, c) => (c.durationMin > (m?.durationMin ?? -1) ? c : m), null);
  return {
    count: cuts.length,
    totalHours: round1(totalMin / 60),
    avgMin: cuts.length ? Math.round(totalMin / cuts.length) : 0,
    longestMin: longest ? longest.durationMin : 0,
    longCuts: cuts.filter((c) => c.durationMin >= longCutMin).length,
    confirmedCuts: cuts.filter((c) => c.confirmers >= 1).length,
    nightCuts: cuts.filter((c) => isNightIST(c.startedAtMs)).length,
  };
}

/** Group cuts by IST calendar day (YYYY-MM-DD) → total minutes, for the bar strip. */
export function minutesByDayIST(cuts, days, nowMs) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push({ day: istDate(nowMs - i * 86_400_000), minutes: 0 });
  const idx = new Map(out.map((d, i) => [d.day, i]));
  for (const c of cuts) {
    const i = idx.get(istDate(c.startedAtMs));
    if (i !== undefined) out[i].minutes += c.durationMin;
  }
  return out;
}

const IST_OFFSET_MS = 330 * 60_000;
export function istDate(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}
export function istTime(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
}
/** 22:00-06:00 IST */
export function isNightIST(ms) {
  const h = new Date(ms + IST_OFFSET_MS).getUTCHours();
  return h >= 22 || h < 6;
}

/** CSV for a complaint: one row per cut, with the Arkiv entity key and explorer link so anyone can verify it. */
export function toCSV(cuts, explorerEntity) {
  const head = ["pin", "start_ist", "end_ist", "duration_min", "confirmed_by_neighbours", "origin", "source", "reporter_wallet", "arkiv_entity", "verify_url"];
  const rows = cuts.map((c) => [
    c.pin, `${istDate(c.startedAtMs)} ${istTime(c.startedAtMs)}`, `${istDate(c.endedAtMs)} ${istTime(c.endedAtMs)}`,
    c.durationMin, c.confirmers, c.origin, c.source, c.creator, c.key, explorerEntity(c.key),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const round1 = (x) => Math.round(x * 10) / 10;

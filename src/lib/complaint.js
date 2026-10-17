// Ready-to-send complaint summary built from cut records. Pure function, no network.
// Honesty guard: if any included cut is DEMO (synthetic), the text starts with "SAMPLE ONLY ... Do not file."
// The legal sentence names the Rules and the 45-day forum period but deliberately gives no rule numbers
// (we cannot verify them against the official text from here); the resident should check before filing.
import { summarize, istDate, istTime } from "./stats.js";

const T = {
  en: {
    sample: "SAMPLE ONLY: contains DEMO (synthetic) records. Do not file.",
    demoTag: "[DEMO]",
    intro: ({ pin, from, to, count, hours, longest, night }) =>
      `Power cuts at PIN ${pin}, ${from} to ${to} (IST): ${count} ${count === 1 ? "cut" : "cuts"}, ${hours} hours without power, longest ${longest}, ${night} began at night (10pm-6am). Each cut below has a start, an end and an Arkiv record anyone can check; finished cuts cannot be edited or deleted.`,
    law: "Under the Electricity (Rights of Consumers) Rules, 2020, the licensee must provide reliable 24x7 supply, and the Consumer Grievance Redressal Forum must decide a grievance within 45 days. I request action and a written reply.",
    row: ({ i, date, start, end, dur, n, url, demo }) =>
      `${i}. ${date} ${start}-${end} (${dur}), ${n === 1 ? "confirmed by 1 neighbour" : `confirmed by ${n} neighbours`}${demo ? " [DEMO]" : ""}, ${url}`,
    more: (k) => `... and ${k} more cuts (full list: CSV).`,
    h: "h", min: "min", none: "no cuts in this period",
  },
  hi: {
    sample: "केवल नमूना: इसमें डेमो (नकली) रिकॉर्ड हैं। इसे शिकायत में न भेजें।",
    demoTag: "[डेमो]",
    intro: ({ pin, from, to, count, hours, longest, night }) =>
      `पिन ${pin} पर बिजली कटौती, ${from} से ${to} (IST): ${count} कटौतियाँ, ${hours} घंटे बिना बिजली, सबसे लंबी ${longest}, ${night} रात (10 बजे-6 बजे) में शुरू हुईं। नीचे हर कटौती की शुरुआत, अंत और एक Arkiv रिकॉर्ड है जिसे कोई भी जाँच सकता है; पूरी हो चुकी कटौती बदली या हटाई नहीं जा सकती।`,
    law: "विद्युत (उपभोक्ताओं के अधिकार) नियम, 2020 के तहत लाइसेंसधारी को भरोसेमंद 24x7 आपूर्ति देनी है, और उपभोक्ता शिकायत निवारण फ़ोरम को शिकायत का निपटारा 45 दिनों में करना है। मेरा अनुरोध है कि कार्रवाई हो और लिखित जवाब दिया जाए।",
    row: ({ i, date, start, end, dur, n, url, demo }) =>
      `${i}. ${date} ${start}-${end} (${dur}), ${n === 1 ? "1 पड़ोसी ने पुष्टि की" : `${n} पड़ोसियों ने पुष्टि की`}${demo ? " [डेमो]" : ""}, ${url}`,
    more: (k) => `... और ${k} कटौतियाँ (पूरी सूची: CSV)।`,
    h: "घं", min: "मि", none: "इस अवधि में कोई कटौती नहीं",
  },
};

export function buildComplaint({ cuts, pin, lang = "en", explorerEntity, maxRows = 15 }) {
  const L = T[lang === "hi" ? "hi" : "en"];
  const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} ${L.h} ${String(m % 60).padStart(2, "0")} ${L.min}` : `${m} ${L.min}`);
  const sorted = [...cuts].sort((a, b) => a.startedAtMs - b.startedAtMs);
  if (!sorted.length) return { text: `${pin}: ${L.none}`, hasDemo: false };
  const s = summarize(sorted);
  const hasDemo = sorted.some((c) => c.source === "demo");
  const head = L.intro({ pin, from: istDate(sorted[0].startedAtMs), to: istDate(sorted[sorted.length - 1].endedAtMs), count: s.count, hours: s.totalHours, longest: dur(s.longestMin), night: s.nightCuts });
  const rows = sorted.slice(0, maxRows).map((c, k) => L.row({
    i: k + 1, date: istDate(c.startedAtMs), start: istTime(c.startedAtMs), end: istTime(c.endedAtMs), dur: dur(c.durationMin),
    n: c.confirmers, url: explorerEntity(c.key), demo: c.source === "demo",
  }));
  if (sorted.length > maxRows) rows.push(L.more(sorted.length - maxRows));
  const text = [hasDemo ? L.sample : null, head, L.law, ...rows, hasDemo ? L.sample : null].filter(Boolean).join("\n\n");
  return { text, hasDemo };
}

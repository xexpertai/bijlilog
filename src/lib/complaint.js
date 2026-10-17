// Ready-to-send complaint summary built from cut records. Pure function, no network.
// Honesty guards:
//  - if any included cut is DEMO (synthetic), the text starts and ends with "SAMPLE ONLY ... Do not file.";
//  - "cannot be edited or deleted" is only claimed for rows that really are sealed (owner = SEAL_ADDRESS);
//  - past cuts added by a resident are tagged, and the legal line is hedged (no rule numbers, check your state).
import { summarize, istDate, istTime } from "./stats.js";
import { SEAL_ADDRESS } from "./schema.js";

const T = {
  en: {
    sample: "SAMPLE ONLY: contains DEMO (synthetic) records. Do not file.",
    intro: ({ pin, from, to, count, hours, longest, night }) =>
      `Power cuts at PIN ${pin}, ${from} to ${to} (IST): ${count} ${count === 1 ? "cut" : "cuts"}, ${hours} hours without power, longest ${longest}, ${night} began at night (10pm-6am). Each cut below has a start, an end and an Arkiv record anyone can check.`,
    sealedAll: "Every cut below is sealed: nobody can edit or delete it.",
    sealedSome: "Cuts marked [sealed] cannot be edited or deleted by anyone; the others could still be changed by the operator.",
    law: "Under the Electricity (Rights of Consumers) Rules, 2020, the licensee must provide 24x7 supply (State Commissions may allow fewer hours for some categories, e.g. agriculture), and the Consumer Grievance Redressal Forum must decide a grievance within 45 days. I request action and a written reply.",
    check: "Please check the current rules for your state before filing.",
    row: ({ i, date, start, end, dur, n, url, demo, sealed, later, tagSeal }) =>
      `${i}. ${date} ${start}-${end} (${dur}), ${later ? "added later by a resident" : n === 1 ? "confirmed by 1 neighbour" : `confirmed by ${n} neighbours`}${demo ? " [DEMO]" : ""}${tagSeal && sealed ? " [sealed]" : ""}, ${url}`,
    more: (k) => `... and ${k} more cuts (full list: CSV).`,
    h: "h", min: "min", none: "no cuts in this period",
  },
  hi: {
    sample: "केवल नमूना: इसमें डेमो (नकली) रिकॉर्ड हैं। इसे शिकायत में न भेजें।",
    intro: ({ pin, from, to, count, hours, longest, night }) =>
      `पिन ${pin} पर बिजली कटौती, ${from} से ${to} (IST): ${count} ${count === 1 ? "कटौती" : "कटौतियाँ"}, ${hours} घंटे बिना बिजली, सबसे लंबी ${longest}, ${night} रात (10 बजे-6 बजे) में शुरू हुईं। नीचे हर कटौती की शुरुआत, अंत और एक Arkiv रिकॉर्ड है जिसे कोई भी जाँच सकता है।`,
    sealedAll: "नीचे की हर कटौती सील है: उसे कोई बदल या हटा नहीं सकता।",
    sealedSome: "[सील] वाली कटौतियों को कोई भी बदल या हटा नहीं सकता; बाकी को ऑपरेटर अब भी बदल सकता है।",
    law: "विद्युत (उपभोक्ताओं के अधिकार) नियम, 2020 के तहत लाइसेंसधारी को 24x7 आपूर्ति देनी है (राज्य आयोग कुछ श्रेणियों, जैसे कृषि, के लिए कम घंटे की अनुमति दे सकते हैं), और उपभोक्ता शिकायत निवारण फ़ोरम को शिकायत का निपटारा 45 दिनों में करना है। मेरा अनुरोध है कि कार्रवाई हो और लिखित जवाब दिया जाए।",
    check: "भेजने से पहले अपने राज्य के मौजूदा नियम जाँच लें।",
    row: ({ i, date, start, end, dur, n, url, demo, sealed, later, tagSeal }) =>
      `${i}. ${date} ${start}-${end} (${dur}), ${later ? "निवासी द्वारा बाद में जोड़ी गई" : n === 1 ? "1 पड़ोसी ने पुष्टि की" : `${n} पड़ोसियों ने पुष्टि की`}${demo ? " [डेमो]" : ""}${tagSeal && sealed ? " [सील]" : ""}, ${url}`,
    more: (k) => `... और ${k} कटौतियाँ (पूरी सूची: CSV)।`,
    h: "घं", min: "मि", none: "इस अवधि में कोई कटौती नहीं",
  },
};

const isSealed = (c) => (c.owner ?? "").toLowerCase() === SEAL_ADDRESS.toLowerCase();

/** maxRows caps the listed rows (use ~8 for a WhatsApp link, 15+ for copy). */
export function buildComplaint({ cuts, pin, lang = "en", explorerEntity, maxRows = 15 }) {
  const L = T[lang === "hi" ? "hi" : "en"];
  const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} ${L.h} ${String(m % 60).padStart(2, "0")} ${L.min}` : `${m} ${L.min}`);
  const sorted = [...cuts].sort((a, b) => a.startedAtMs - b.startedAtMs);
  if (!sorted.length) return { text: `${pin}: ${L.none}`, hasDemo: false };
  const s = summarize(sorted);
  const hasDemo = sorted.some((c) => c.source === "demo");
  const allSealed = sorted.every(isSealed);
  const head = L.intro({ pin, from: istDate(sorted[0].startedAtMs), to: istDate(sorted[sorted.length - 1].endedAtMs), count: s.count, hours: s.totalHours, longest: dur(s.longestMin), night: s.nightCuts });
  const rows = sorted.slice(0, maxRows).map((c, k) => L.row({
    i: k + 1, date: istDate(c.startedAtMs), start: istTime(c.startedAtMs), end: istTime(c.endedAtMs), dur: dur(c.durationMin),
    n: c.confirmers, url: explorerEntity(c.key), demo: c.source === "demo", sealed: isSealed(c), later: c.origin === "backfill", tagSeal: !allSealed,
  }));
  if (sorted.length > maxRows) rows.push(L.more(sorted.length - maxRows));
  const text = [hasDemo ? L.sample : null, head, allSealed ? L.sealedAll : L.sealedSome, L.law, ...rows, L.check, hasDemo ? L.sample : null].filter(Boolean).join("\n\n");
  return { text, hasDemo };
}

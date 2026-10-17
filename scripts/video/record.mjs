// Records the demo scenes with Playwright at 1920x1080.
// MODE=replay (default): RPC reads are served by the labelled in-memory fixture (scripts/replay-rpc.mjs).
// MODE=live: the app talks to the real Tiramisu testnet at BASE (run seed.mjs --live first).
// Usage: node scripts/video/record.mjs <build_dir> [baseUrl]
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { makeHandler } from "../replay-rpc.mjs";

const B = process.argv[2], BASE = process.argv[3] ?? "http://127.0.0.1:18431";
const MODE = process.env.MODE ?? "replay";
const dur = JSON.parse(readFileSync(`${B}/durations.json`));
const PAD = 0.45; // seconds of picture after each line
mkdirSync(`${B}/clips`, { recursive: true });
const handler = makeHandler();
const browser = await chromium.launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Disclosure badges live in a reserved 60 px strip added by assemble.py below the 1920x1020 picture, so they never cover app UI.
const VH = 1020;


import { generatePrivateKey } from "viem/accounts";
const KEY_R = generatePrivateKey(), KEY_N = generatePrivateKey(); // reporter phone, neighbour phone (throwaway device keys: they only sign)
const PINX = process.env.PINX ?? "380001";
async function newScene(id, { app = true, url = `${BASE}/?pin=${PINX}`, key = KEY_R } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: VH }, recordVideo: { dir: `${B}/clips/raw-${id}`, size: { width: 1920, height: VH } }, colorScheme: "light" });
  const t0 = Date.now();
  const page = await ctx.newPage();
  if (app) {
    await page.addInitScript(([key]) => {
      try { localStorage.setItem("bijlilog.deviceKey", key); localStorage.setItem("bijlilog.lang", "en"); } catch {}
      addEventListener("DOMContentLoaded", () => { document.documentElement.style.zoom = "1.85"; });
    }, [key]);
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#status[aria-busy='false']", { timeout: 30000 });
    await sleep(500);
  }
  const readyAt = (Date.now() - t0) / 1000;
  return { ctx, page, t0, readyAt };
}
async function finish(id, s, ms, tail = 2500) {
  // Action scenes: when the real transactions take longer than the narration, use the LAST `ms` of the recording
  // (so the result is on screen at the end); otherwise hold until the narration is done.
  const readyAt = s.readyAt;
  const A = (Date.now() - s.t0) / 1000 - readyAt;
  const want = ms / 1000;
  await sleep(Math.max(tail, want * 1000 - A * 1000));
  const E = (Date.now() - s.t0) / 1000 - readyAt;
  const ss = readyAt + Math.max(0, E - want);
  await s.page.close(); await s.ctx.close();
  writeFileSync(`${B}/clips/${id}.json`, JSON.stringify({ ss, len: Math.min(E, want) }));
  console.log(id, "actions done at", A.toFixed(1), "audio", dur[id], "ss", ss.toFixed(1));
}

const total = (id) => Math.round((dur[id] + PAD) * 1000);
const smooth = (page, y, ms) => page.evaluate(([y, ms]) => new Promise((res) => {
  const y0 = scrollY, t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); scrollTo(0, y0 + (y - y0) * (k * k * (3 - 2 * k))); k < 1 ? requestAnimationFrame(step) : res(); };
  requestAnimationFrame(step);
}), [y, ms]);
const el = async (page, sel) => { await page.waitForSelector(sel, { timeout: 20000 }); return page.evaluate((s) => document.querySelector(s).getBoundingClientRect().top + scrollY, sel); };

// ---- cards (animated with CSS so there is always motion) ----
const CSS = `*{box-sizing:border-box}body{margin:0;width:1920px;height:1020px;background:#11151d;color:#e8ebf1;font:500 72px/1.3 system-ui,sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 170px;overflow:hidden}
.bolt{width:120px;fill:#ffc83d;margin-bottom:26px}h1{font-size:150px;margin:0 0 18px;letter-spacing:-.02em}.sub{color:#a2abbb;font-size:60px}
.l{opacity:0;transform:translateY(24px);animation:in .8s ease forwards}@keyframes in{to{opacity:1;transform:none}}
.k{color:#ffc83d;font-weight:700}.li{margin:20px 0;font-size:62px}.foot{position:absolute;left:170px;bottom:48px;color:#a2abbb;font-size:28px}
.bar{position:absolute;left:0;bottom:0;height:8px;background:#ffc83d;width:0;animation:w var(--d) linear forwards}@keyframes w{to{width:100%}}`;
const BOLT = `<svg viewBox="0 0 24 24" class="bolt"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`;
const d = (n) => `animation-delay:${n}s`;
async function card(id, html) {
  const s = await newScene(id, { app: false });
  await s.page.setContent(`<style>html{background:#11151d}${CSS}</style>${html}<div class="bar" style="--d:${dur[id] + PAD}s"></div>`);
  await sleep(250); s.readyAt = (Date.now() - s.t0) / 1000; // skip the blank page that precedes setContent
  await finish(id, s, total(id));
}


const want = (id) => !process.env.ONLY || process.env.ONLY.split(",").includes(id);

const HINT = (txt) => `document.title=document.title`;
const toIstHHMM = (ms) => new Date(ms + 330 * 60_000).toISOString().slice(11, 16);
const calm = () => `#status .status.calm`;

if (want("s1")) { // s1: real app from frame 0, moving from the first moment: pan to the cut history, then the calendar, then back
  const s = await newScene("s1"); const p = s.page;
  await sleep(150); await smooth(p, (await el(p, "#history-card")) - 60, 1500);
  await sleep(700); await smooth(p, (await el(p, "#calendar-card")) - 120, 1700);
  await sleep(1200); await smooth(p, 0, 1700);
  await finish("s1", s, total("s1"));
}
if (want("s2")) { // s2: report a (DEMO) cut: real transaction
  const s = await newScene("s2"); const p = s.page;
  await sleep(700);
  for (let k = 0; k < 4; k++) { // the status card can re-render while polling: retry until the form is really open
    await p.click(".status.calm .btn.danger.big").catch(() => {});
    if (await p.waitForSelector("#area", { state: "visible", timeout: 2500 }).then(() => true, () => false)) break;
  }
  await sleep(600);
  await p.fill("#area", ""); await p.type("#area", "Synthetic demo: market lane", { delay: 45 });
  await p.fill("#went-at", toIstHHMM(Date.now() - 5 * 60_000));
  await sleep(500); await p.click("#report-form button[type=submit]");
  await p.waitForSelector(".status.out", { timeout: 45000 });
  await finish("s2", s, total("s2"));
}
if (want("s3")) { // s3: a second phone (other device key) taps Still dark; this page updates live
  const s = await newScene("s3"); const p = s.page;
  const n = await newScene("s3n", { key: KEY_N }); // background neighbour phone, not part of the recorded picture
  await sleep(1200);
  await n.page.click(".status.out .btn.danger");
  await p.waitForFunction(() => /confirmed/.test(document.querySelector(".status.out .facts")?.textContent ?? "") && !/No neighbour/.test(document.querySelector(".status.out .facts")?.textContent ?? ""), null, { timeout: 40000 }).catch(() => {});
  await n.page.close(); await n.ctx.close();
  await finish("s3", s, total("s3"));
}
if (want("s4")) { // s4: power's back: sealed cut appears
  const s = await newScene("s4"); const p = s.page;
  await sleep(1500); await p.click(".status.out .btn.ok");
  await p.waitForSelector(".status.calm", { timeout: 45000 });
  await sleep(1000); await smooth(p, (await el(p, "#history-card")) - 60, 1500);
  await finish("s4", s, total("s4"));
}
if (want("s5")) { // s5: proof badges, legend, calendar
  const s = await newScene("s5"); const p = s.page;
  await smooth(p, (await el(p, "#history-card")) - 60, 1200); await sleep(2500);
  await p.evaluate(() => { document.querySelector(".legend-proof").style.outline = "3px solid #ffc83d"; });
  await sleep(3000); await smooth(p, (await el(p, "#calendar-card")) - 100, 1600);
  await finish("s5", s, total("s5"));
}
if (want("s6")) { // s6: complaint summary
  const s = await newScene("s6"); const p = s.page;
  await smooth(p, (await el(p, "#complaint")) - 400, 900); await sleep(300);
  await p.click("#complaint"); await sleep(3300); // top of the text (SAMPLE ONLY line) stays on screen while it is mentioned
  await p.evaluate(() => { const t = document.querySelector("#complaint-text"); t.scrollTo({ top: 230, behavior: "smooth" }); });
  await sleep(2400); await p.click("#cp-hi"); await sleep(2600);
  await finish("s6", s, total("s6"), 500);
}
if (want("s7")) { // s7: verify panel
  const s = await newScene("s7"); const p = s.page;
  await smooth(p, 99999, 1); await sleep(300);
  await p.evaluate(() => { document.querySelector("#verify").open = true; document.querySelector("#verify").scrollIntoView({ block: "start" }); });
  await sleep(1500); await smooth(p, (await el(p, "#queries")) - 250, 1500);
  await finish("s7", s, total("s7"));
}

// small real screenshot of the sealed cut history, used on the two end slides
const shotCtx = await browser.newContext({ viewport: { width: 1920, height: VH }, colorScheme: "light" });
const shotPage = await shotCtx.newPage();
await shotPage.addInitScript(() => { try { localStorage.setItem("bijlilog.lang", "en"); } catch {} addEventListener("DOMContentLoaded", () => { document.documentElement.style.zoom = "1.85"; }); });
await shotPage.goto(`${BASE}/?pin=${PINX}`, { waitUntil: "networkidle" });
await shotPage.waitForSelector("#status[aria-busy='false']", { timeout: 30000 });
await sleep(500);
const SHOT = "data:image/png;base64," + (await shotPage.locator("#history-card").screenshot()).toString("base64");
await shotCtx.close();
const FRAME = `<img class="l" style="animation-delay:.5s" src="${SHOT}">`;
const CSS2 = `body{padding:0 90px;flex-direction:row;align-items:center;gap:70px}.col{flex:1}.pic{width:600px;height:880px;flex:none;overflow:hidden;border-radius:18px;border:4px solid #2c3446;box-shadow:0 20px 70px #0008;-webkit-mask-image:linear-gradient(#000 88%,transparent)}.pic img{width:100%;display:block}
.li{font-size:54px;margin:22px 0;line-height:1.25}h1{font-size:112px;margin-bottom:10px}`;
const cardCSS = (extra) => `<style>${CSS2}${extra ?? ""}</style>`;
want("s8") && await card("s8", `${cardCSS()}<div class="col"><h1 class="l" style="${d(0.1)}">Why <span class="k">Arkiv</span></h1>
<div class="li l" style="${d(0.8)}"><span class="k">Expiry</span>: every live cut is a 2-hour lease</div>
<div class="li l" style="${d(3.2)}"><span class="k">Permissionless extension</span>: any neighbour renews it</div>
<div class="li l" style="${d(6)}"><span class="k">Atomic batches</span>: changes land together</div>
<div class="li l" style="${d(8.4)}"><span class="k">Sealed records</span>: a finished cut is evidence</div>
<div class="li l sub" style="${d(11)};font-size:42px">Honest limit: new reports go through our relay (stated in the README)</div></div><div class="pic">${FRAME}</div>`);
want("s9") && await card("s9", `${cardCSS()}<div class="col"><div class="l" style="${d(0.2)}">${BOLT}</div><h1 class="l" style="${d(0.4)};font-size:170px">BijliLog</h1><div class="l" style="${d(1)};font-size:50px;color:#ffd866;white-space:nowrap">bijlilog-196979752200.us-central1.run.app</div><div class="l sub" style="${d(1.8)};font-size:39px;margin-top:20px">github.com/xexpertai/bijlilog · by Harsha Shinde · MIT</div><div class="l sub" style="${d(2.6)};font-size:38px;margin-top:14px">Arkiv Tiramisu testnet · synthetic DEMO data · no personal data · built with AI assistance</div><div class="l sub" style="${d(3.4)};font-size:38px;color:#ffd866;margin-top:14px">Narration: AI copy of my own voice (consented)</div></div><div class="pic">${FRAME}</div>`);
{ // disclosure strip (60 px, added under every scene by assemble.py)
  const c = await browser.newContext({ viewport: { width: 1920, height: 60 } }); const pg = await c.newPage();
  await pg.setContent(`<body style="margin:0;width:1920px;height:60px;background:#0b0e14;color:#ffd866;font:700 27px/60px system-ui,sans-serif;display:flex;justify-content:space-between;padding:0 36px;box-sizing:border-box;letter-spacing:.02em"><span>LIVE app · Arkiv Tiramisu testnet · DEMO records are synthetic</span><span style="color:#fff">Narration: AI copy of my own voice (consented)</span></body>`);
  await pg.screenshot({ path: `${B}/strip.png` }); await c.close();
}
await browser.close();
import { readdirSync } from "node:fs";
for (const dname of readdirSync(`${B}/clips`).filter((n) => n.startsWith("raw-") && n !== "raw-s3n" && readdirSync(`${B}/clips/${n}`).length)) {
  const f = readdirSync(`${B}/clips/${dname}`)[0];
  renameSync(`${B}/clips/${dname}/${f}`, `${B}/clips/${dname.slice(4)}.webm`);
}
console.log("recorded clips in", `${B}/clips`);

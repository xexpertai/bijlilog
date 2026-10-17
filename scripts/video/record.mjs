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
const BADGE = MODE === "replay" ? "REPLAY PREVIEW · synthetic fixture, not the live chain" : "LIVE · Arkiv Tiramisu testnet · DEMO records are synthetic";

async function newScene(id, { app = true, url = `${BASE}/?pin=411001` } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: `${B}/clips/raw-${id}`, size: { width: 1920, height: 1080 } }, colorScheme: "light" });
  const t0 = Date.now();
  const page = await ctx.newPage();
  if (app) {
    if (MODE === "replay") {
      await page.route("https://rpc.tiramisu.db-chain.testnet.arkiv.network/**", async (route) => {
        const body = JSON.parse(route.request().postData());
        const res = Array.isArray(body) ? body.map(handler) : handler(body);
        await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(res) });
      });
    }
    await page.addInitScript((badge) => {
      addEventListener("DOMContentLoaded", () => {
        document.documentElement.style.zoom = "1.85";
        const b = document.createElement("div");
        b.textContent = badge;
        Object.assign(b.style, { position: "fixed", left: "50%", top: "8px", transform: "translateX(-50%) scale(0.65)", background: "#1d2433", color: "#ffd866", font: "700 15px system-ui,sans-serif", padding: "8px 16px", borderRadius: "999px", zIndex: 99999, letterSpacing: ".03em" });
        document.body.append(b);
      });
    }, BADGE);
    await page.goto(url, { waitUntil: "networkidle" });
    await sleep(900);
  }
  const readyAt = (Date.now() - t0) / 1000;
  return { ctx, page, t0, readyAt };
}
async function finish(id, s, ms) {
  const readyAt = s.readyAt;
  await sleep(ms);
  await s.page.close(); await s.ctx.close();
  writeFileSync(`${B}/clips/${id}.json`, JSON.stringify({ ss: readyAt }));
}
const total = (id) => Math.round((dur[id] + PAD) * 1000);
const smooth = (page, y, ms) => page.evaluate(([y, ms]) => new Promise((res) => {
  const y0 = scrollY, t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); scrollTo(0, y0 + (y - y0) * (k * k * (3 - 2 * k))); k < 1 ? requestAnimationFrame(step) : res(); };
  requestAnimationFrame(step);
}), [y, ms]);
const el = async (page, sel) => { await page.waitForSelector(sel, { timeout: 20000 }); return page.evaluate((s) => document.querySelector(s).getBoundingClientRect().top + scrollY, sel); };

// ---- cards (animated with CSS so there is always motion) ----
const CSS = `*{box-sizing:border-box}body{margin:0;width:1920px;height:1080px;background:#11151d;color:#e8ebf1;font:500 72px/1.3 system-ui,sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 170px;overflow:hidden}
.bolt{width:120px;fill:#ffc83d;margin-bottom:26px}h1{font-size:150px;margin:0 0 18px;letter-spacing:-.02em}.sub{color:#a2abbb;font-size:60px}
.l{opacity:0;transform:translateY(24px);animation:in .8s ease forwards}@keyframes in{to{opacity:1;transform:none}}
.k{color:#ffc83d;font-weight:700}.li{margin:20px 0;font-size:62px}.foot{position:absolute;left:170px;bottom:48px;color:#a2abbb;font-size:28px}
.bar{position:absolute;left:0;bottom:0;height:8px;background:#ffc83d;width:0;animation:w var(--d) linear forwards}@keyframes w{to{width:100%}}`;
const BOLT = `<svg viewBox="0 0 24 24" class="bolt"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`;
const d = (n) => `animation-delay:${n}s`;
async function card(id, html) {
  const s = await newScene(id, { app: false });
  await s.page.setContent(`<style>${CSS}</style>${html}<div class="bar" style="--d:${dur[id] + PAD}s"></div>`);
  await finish(id, s, total(id));
}
await card("s1", `<div class="l" style="${d(0.2)}">${BOLT}</div><div class="l" style="${d(0.5)}">Power cut tonight.</div><div class="l sub" style="${d(2)}">You will not find a record you can show.</div><div class="l sub" style="${d(5)}">The only log is usually the utility's own.</div>`);
await card("s2", `<div class="l" style="${d(0.2)}">${BOLT}</div><h1 class="l" style="${d(0.4)}">BijliLog</h1><div class="l sub" style="${d(1.2)}">A power-cut log for your PIN code.</div><div class="l sub" style="${d(2.6)}">Kept by neighbours. Stored on <span class="k">Arkiv</span>.</div>`);

// ---- app scenes ----
{ // s3: live cut lease
  const s = await newScene("s3", { url: `${BASE}/` });
  const p = s.page, ms = total("s3");
  await sleep(600); await p.click("#pin"); await p.keyboard.type("411001", { delay: 140 });
  await sleep(300); await p.keyboard.press("Enter");
  await sleep(2500);
  await p.evaluate(() => document.querySelector(".outage")?.animate([{ boxShadow: "0 0 0 0 #ffc83d" }, { boxShadow: "0 0 0 10px #ffc83d00" }], { duration: 1200, iterations: 3 }));
  await finish("s3", s, ms - 4000);
}
{ const s = await newScene("s4"); const p = s.page;
  await smooth(p, (await el(p, ".outage .meta")) - 250, 1500);
  let used = 1500;
  if (MODE === "live") { await p.click(".btn-row .btn:not(.ok)"); await sleep(5000); used += 5000; }
  await finish("s4", s, total("s4") - used); }
{ const s = await newScene("s5"); const p = s.page; let used = 0;
  if (MODE === "live") { await smooth(p, (await el(p, "#now-card")) - 40, 700); await p.click(".btn-row .btn.ok"); await sleep(5500); used += 6200; }
  await smooth(p, (await el(p, "#history-card")) - 60, 1800); used += 1800;
  await sleep(1500); used += 1500; await smooth(p, (await el(p, "#history")) - 300, 2200); used += 2200;
  await finish("s5", s, total("s5") - used); }
{ const s = await newScene("s6"); const p = s.page;
  await smooth(p, (await el(p, "#history-card")) - 60, 1200);
  await sleep(1500); await p.check("#f-confirmed"); await sleep(2200); await p.check("#f-long"); await sleep(2500);
  await p.evaluate(() => { document.querySelector("#csv").style.outline = "4px solid #ffc83d"; });
  await finish("s6", s, total("s6") - 7600); }
{ const s = await newScene("s7"); const p = s.page;
  await smooth(p, (await el(p, ".about")) - 60, 1500);
  await p.click("details summary"); await sleep(700);
  await smooth(p, (await el(p, "#queries")) - 350, 1500);
  await finish("s7", s, total("s7") - 3800); }
{ const s = await newScene("s8"); const p = s.page;
  await smooth(p, 0, 400); await sleep(600); await p.click("#lang"); await sleep(1800);
  await smooth(p, (await el(p, "#now-card")) - 20, 1500);
  await finish("s8", s, total("s8") - 4300); }

await card("s9", `<h1 class="l" style="${d(0.1)};font-size:104px">Why <span class="k">Arkiv</span></h1>
<div class="li l" style="${d(0.8)}"><span class="k">Expiry</span>: every cut is a 2-hour lease</div>
<div class="li l" style="${d(3)}"><span class="k">Permissionless extension</span>: any neighbour renews it</div>
<div class="li l" style="${d(6)}"><span class="k">Atomic batch</span>: confirm + renew land together</div>
<div class="li l" style="${d(8.8)}"><span class="k">WebSocket events</span>: the page updates live</div>`);
await card("s10", `<div class="l" style="${d(0.2)}">${BOLT}</div><h1 class="l" style="${d(0.4)}">BijliLog</h1><div class="l sub" style="${d(1)}">Arkiv Tiramisu testnet · synthetic demo data · no personal data</div><div class="l sub" style="${d(2.2)}">Open source, MIT · built with AI assistance (Claude Code) · Narration: synthetic voice</div><div class="l sub" style="${d(3.4)};color:#ffd866">${MODE === "replay" ? "REPLAY PREVIEW: recorded from a local fixture of the synthetic data" : "Live app and repository links are in the submission"}</div>`);
await browser.close();
// playwright names clips randomly: move them to <id>.webm
import { readdirSync } from "node:fs";
for (const dname of readdirSync(`${B}/clips`).filter((n) => n.startsWith("raw-"))) {
  const f = readdirSync(`${B}/clips/${dname}`)[0];
  renameSync(`${B}/clips/${dname}/${f}`, `${B}/clips/${dname.slice(4)}.webm`);
}
console.log("recorded clips in", `${B}/clips`);

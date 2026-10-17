// Screenshots at phone and desktop widths for UI review. Usage: node scripts/shots.mjs [baseUrl] [pin] [outDir]
import { chromium } from "playwright-core";
const base = process.argv[2] ?? "http://127.0.0.1:18431", pin = process.argv[3] ?? "411001", out = process.argv[4] ?? "evidence/ui";
import { mkdirSync } from "node:fs"; mkdirSync(out, { recursive: true });
const b = await chromium.launch(); const errors = [];
const replay = process.env.REPLAY ? (await import("./replay-rpc.mjs")).makeHandler() : null;
for (const [name, vp, hi] of [["phone", { width: 390, height: 844 }, false], ["phone-hi", { width: 390, height: 844 }, true], ["desktop", { width: 1280, height: 900 }, false]]) {
  const p = await b.newPage({ viewport: vp, deviceScaleFactor: name.startsWith("phone") ? 2 : 1 });
  if (replay) await p.route("https://rpc.tiramisu.db-chain.testnet.arkiv.network/**", async (r) => { const body = JSON.parse(r.request().postData()); await r.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(Array.isArray(body) ? body.map(replay) : replay(body)) }); });
  p.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`)); p.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await p.goto(`${base}/?pin=${pin}`, { waitUntil: "networkidle" });
  if (hi) await p.click("#lang-hi");
  await p.waitForTimeout(3000);
  console.log(name, "overflow-x:", await p.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await p.screenshot({ path: `${out}/${name}-top.png` }); await p.screenshot({ path: `${out}/${name}-full.png`, fullPage: true });
  await p.close();
}
console.log("console errors:", errors.length ? errors : "none"); await b.close();

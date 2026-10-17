// Headless UI check: loads the app, records console errors, saves screenshots.
// Usage: node scripts/ui-check.mjs [baseUrl] [pin] [outDir]
import { chromium } from "playwright-core";
const base = process.argv[2] ?? "http://localhost:18431";
const pin = process.argv[3] ?? "411001";
const out = process.argv[4] ?? "evidence/tmp";
const browser = await chromium.launch();
const errors = [];
for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: name === "phone" ? 2 : 1 });
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/?pin=${pin}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(6000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await page.screenshot({ path: `${out}/ui-${name}.png`, fullPage: true });
  console.log(name, "horizontal overflow:", overflow, "| live dot:", await page.isVisible("#live-dot"), "| now:", (await page.textContent("#now")).slice(0, 90));
  await page.close();
}
await browser.close();
console.log("console errors:", errors.length ? errors : "none");

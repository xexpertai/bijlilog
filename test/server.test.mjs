import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// Regression: POST /api/action must reach the relay handler (503 when writes are off), not a 404.
test("server routes /api/action, /api/config and /healthz", async () => {
  const port = 19000 + Math.floor(Math.random() * 500);
  const env = { ...process.env, PORT: String(port) };
  delete env.SPONSOR_PRIVATE_KEY;
  const child = spawn(process.execPath, ["server/server.mjs"], { env, stdio: "pipe" });
  try {
    await new Promise((res, rej) => { child.stdout.on("data", (d) => /listening/.test(String(d)) && res()); child.on("error", rej); setTimeout(() => rej(new Error("server start timeout")), 8000); });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.writesEnabled, false);
    const r = await fetch(`${base}/api/action`, { method: "POST", body: "{}" });
    assert.equal(r.status, 503);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  } finally { child.kill(); }
});

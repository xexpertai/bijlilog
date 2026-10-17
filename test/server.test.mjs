import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// Regression: POST /api/action must reach the relay handler (503 when writes are off), not a 404.
test("server routes /api/action, /api/config and /health", async () => {
  const port = 19000 + Math.floor(Math.random() * 500);
  const env = { ...process.env, PORT: String(port) };
  delete env.SPONSOR_PRIVATE_KEY;
  const child = spawn(process.execPath, ["server/server.mjs"], { env, stdio: "pipe" });
  try {
    await new Promise((res, rej) => { child.stdout.on("data", (d) => /listening/.test(String(d)) && res()); child.on("error", rej); setTimeout(() => rej(new Error("server start timeout")), 8000); });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.writesEnabled, false);
    const r = await fetch(`${base}/api/action`, { method: "POST", body: "{}" });
    assert.equal(r.status, 503);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    // read proxy: write methods are refused, read methods are forwarded (any upstream status, but not 403/404/405)
    const bad = await fetch(`${base}/rpc`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x"] }) });
    assert.equal(bad.status, 403);
    const ok = await fetch(`${base}/rpc`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    assert.ok(![403, 404, 405].includes(ok.status));
  } finally { child.kill(); }
});

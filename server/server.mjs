// BijliLog server: serves the static app and the write relay. Reads never touch this server:
// the browser queries Arkiv directly, so the log stays readable even if this server is down.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http as httpTransport } from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { createRelay, HttpError, isRateLimited } from "./relay.js";
import { PROJECT } from "../src/lib/schema.js";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const RPC = process.env.ARKIV_RPC_URL || undefined; // optional access-key URL; stays server-side
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".png": "image/png" };

// Reads fail fast: viem's default retry waits for the RPC's Retry-After header (up to ~30-55 min when the anonymous
// budget is spent), which hung a relay request for 5 minutes on 17 Oct. See arkiv/friction.md item 8.
const publicClient = createPublicClient({ chain: tiramisu, transport: httpTransport(RPC, { retryCount: 0, timeout: 20_000 }) });
let relay = null;
if (process.env.SPONSOR_PRIVATE_KEY) {
  const account = privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY, { nonceManager });
  relay = createRelay({ publicClient, walletClient: createWalletClient({ chain: tiramisu, transport: httpTransport(RPC), account }) });
  console.log(`relay wallet (Tiramisu testnet): ${relay.relayAddress}`);
} else {
  console.log("no SPONSOR_PRIVATE_KEY: read-only mode (relay disabled)");
}

const READ_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getBlockByNumber", "arkiv_query", "arkiv_getEntityCount", "arkiv_getBlockTiming"]);
const security = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; connect-src 'self' https://rpc.tiramisu.db-chain.testnet.arkiv.network wss://rpc.tiramisu.db-chain.testnet.arkiv.network; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...security });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function readJson(req, max = 8192) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw new HttpError(413, "body too large"); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid JSON"); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname === "/api/config") {
      return send(res, 200, { project: PROJECT, chainId: 7738577, relay: relay?.relayAddress ?? null, writesEnabled: !!relay });
    }
    if (url.pathname === "/rpc" && req.method === "POST") {
      // Read-only fallback for browsers whose anonymous Arkiv RPC budget is used up (ANON_COST_LIMITED).
      // Forwards a small allowlist of read methods to the Arkiv RPC, with the server-side access key if one is set.
      const body = await readJson(req, 16384);
      const calls = Array.isArray(body) ? body : [body];
      if (calls.length > 10 || !calls.every((c) => READ_METHODS.has(c?.method))) throw new HttpError(403, "method not allowed on the read proxy");
      const r = await fetch(RPC ?? "https://rpc.tiramisu.db-chain.testnet.arkiv.network", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", ...security });
      return res.end(await r.text());
    }
    if (url.pathname === "/api/action" && req.method === "POST") {
      if (!relay) throw new HttpError(503, "writes are disabled on this deployment");
      const body = await readJson(req);
      const ip = (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").toString().split(",")[0].trim();
      const result = await relay.handle(body, { ip });
      return send(res, 200, { ok: true, ...result });
    }
    if (url.pathname.startsWith("/api/")) throw new HttpError(404, "not found");
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path === "/" || !extname(path)) path = "/index.html";
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) throw new HttpError(404, "not found");
    const data = await readFile(file).catch(() => { throw new HttpError(404, "not found"); });
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": path === "/index.html" ? "no-cache" : "public, max-age=300", ...security });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch (e) {
    if (!(e instanceof HttpError) && isRateLimited(e)) e = new HttpError(503, "The public Arkiv network is rate-limiting this server right now. Please try again in a few minutes.");
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("error:", e?.shortMessage ?? e?.message);
    send(res, status, { ok: false, error: status === 500 ? "write failed on the Arkiv network; please retry" : e.message, ...(e.extra ?? {}) });
  }
});

server.listen(PORT, () => console.log(`BijliLog listening on :${PORT}`));

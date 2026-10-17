// Friction probe: what does arkiv_query answer to malformed or "natural" query strings? (raw JSON-RPC, 100 units each)
const U = "https://rpc.tiramisu.db-chain.testnet.arkiv.network";
const call = async (label, params) => {
  const r = await fetch(U, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "arkiv_query", params }) });
  const body = (await r.text()).replace(/\s+/g, " ").slice(0, 260);
  console.log(`[${label}] HTTP ${r.status} | quota%=${r.headers.get("arkiv-quota-used-percent")} | ${body}`);
};
const opt = { limit: "0x1", select: { key: true } };
await call("valid", ["project = str('bijlilog-v1')", opt]);
await call("double quotes + &&", ['project = "bijlilog-v1" && type = "outage"', opt]);
await call("unquoted string", ["project = bijlilog-v1", opt]);
await call("!= operator", ["project = str('bijlilog-v1') AND type != str('outage')", opt]);
await call("lowercase and", ["project = str('bijlilog-v1') and type = str('outage')", opt]);
await call("unknown option resultsPerPage", ["project = str('bijlilog-v1')", { resultsPerPage: 1 }]);
await call("limit as number", ["project = str('bijlilog-v1')", { limit: 1, select: { key: true } }]);
await call("untyped number compare", ["project = str('bijlilog-v1') AND started_at_ms >= 5", opt]);
await call("empty query", ["", opt]);

# Friction report: building BijliLog on Arkiv

Versions: `@arkiv-network/sdk` 0.8.1, `viem` 2.57.4, Node 22, Tiramisu testnet (chain 7738577, 0x7614d1), 17 Oct 2026 (block ~670k). Every item below was run, not assumed; the probes are in `scripts/probe-friction.mjs`, `scripts/probe-gas.mjs` and `scripts/probe-read.mjs`. Read paths and write paths were both run on the live testnet on 17 Oct 2026 (seed: `evidence/seed-output.txt`; end-to-end run through the relay: `evidence/e2e-output.txt`, script `scripts/e2e.mjs`). Writes need test GLM, which is a human step: see items 1 and 2.

## Things that got in the way

### 1. First write from an unfunded wallet fails with an error that does not say "no funds"
- **Surface:** SDK `createEntity` on a wallet with 0 test GLM.
- **Expected:** an error naming insufficient balance (or a pointer to the faucet).
- **Actual:** `EntityMutationError: Transaction failed: Execution error without revert data`, cause `Transaction creation failed.`, details `out of gas: gas required exceeds: 0`. The message mentions gas, but nothing connects it to the account having no GLM. Saved in `evidence/unfunded-write-error.txt`.
- **Steps:** `node --env-file=.env.local scripts/probe-gas.mjs` with a fresh key (the balance line prints `0`).
- **Fix idea:** map this RPC error to a typed `InsufficientFundsError` that includes the address and the faucet URL; or have `createEntity` check `getBalance` when estimation fails.

### 2. The faucet cannot be used by a build agent or a script, so the first write is a manual step
- **Surface:** hub.arkiv.network/faucet.
- **Expected:** for a testnet, a CLI or HTTP claim for an address.
- **Actual:** the page needs a wallet sign-in (SIWE) and a CAPTCHA. The recipient field accepts any address, which is good, but it is not scriptable, so a team that wants a CI job or a headless setup cannot get gas without a human and a browser wallet.
- **Fix idea:** a rate-limited, key-authenticated faucet endpoint (the Access Keys already identify a developer), or a documented "request funds" flow.

### 3. `watchEntityEvents` cannot be filtered on the node, so a small app receives the whole chain
- **Surface:** SDK `watchEntityEvents` over WebSocket transport.
- **Expected:** a filter by `$creator`, `$owner` or an attribute so the node only sends relevant events.
- **Actual:** the stream is chain-wide. In 15 s on 17 Oct it delivered 15 events, none from BijliLog (the chain was running someone's `arkiv-chain-indexer-baseload` load generator). The app has to filter every event client-side by owner. That works, but the bandwidth grows with network activity, not with the app.
- **Steps:** `node scripts/probe-friction.mjs` (last line prints the event count). Reconnect behaviour was not tested.
- **Fix idea:** accept the same predicate language as `arkiv_query` as the subscription filter.

### 4. Enumerating "my app's" data safely requires remembering to add `$creator`
- **Surface:** `arkiv_query` / `select().where()`.
- **Expected/actual:** attributes are writable by anyone, so `project = str('bijlilog-v1')` alone also matches records a stranger copies. This is by design and documented, but it is easy to forget; BijliLog adds `.createdBy(relay)` to every read. A lint-style warning or a `client.select().whereApp(...)` helper would make the safe path the default.

### 5. `!=` is documented as unsupported and fails to parse
- **Surface:** query language.
- **Expected:** `kind != str('restored')`.
- **Actual:** the docs say `!=` is reserved but not implemented; the workaround is `NOT (attr = value)`, which also matches entities that never set the attribute. BijliLog does not need it (it selects with `=`), so this was read from the docs and not exercised in the app.

### 6. "readonly" blocks edits but not deletion, which the flag name does not suggest
- **Surface:** creation flag `readonly` (SDK 0.8.1), `patchEntity`, `deleteEntity`.
- **Expected:** a record created `readonly` is immutable, so I planned to tell users "nobody, including us, can change or remove a published cut".
- **Actual:** edits are rejected, with a very clear message: `EntityMutationError: Transaction failed: entity 0x4b8a90a4…0d8862 was created readonly, so its contents can never change. Its expiry can still be extended, and it can be transferred or deleted`. So the owner can still delete it. That is documented in the error, but I only learned it by testing, and BijliLog's copy now says "only the relay wallet could delete it, and that would be visible on chain".
- **Steps:** `node --env-file=.env.local scripts/probe-readonly.mjs <cut_log entity key>`.
- **Fix idea:** state the delete/transfer exceptions next to the flag in the docs, and consider a stronger flag (or burning ownership) for records that must be tamper-evident including against the owner.

### 7. The anonymous read budget is small, and the rejection is not a JSON-RPC error
- **Surface:** public Tiramisu HTTP RPC without an access key; `arkiv_query`.
- **Expected:** the docs say the public RPC "works without one, at the default rate limit"; I expected a limit I could size an app against, and a standard JSON-RPC error when it is hit.
- **Actual:** after about a day of development (many page loads and video-recording runs, each page load issuing several `arkiv_query` calls from the browser) every query returned HTTP 429 with the body `{"error":"ANON_COST_LIMITED","message":"unauthenticated query budget exhausted; get an API key at https://hub.arkiv.network for a monthly quota"}`. That body is not a JSON-RPC error object (`error` is a string, no code/id), so SDK callers see a generic failure. The response headers are useful and complete (`RateLimit: limit=10000, remaining=0, reset=1328`, `Retry-After: 1328`, plus `Arkiv-Cost` and `Arkiv-Quota-Used-Percent` exposed to browsers), but the size of the budget, what one query costs and the window are not in the Access Keys page.
- **Steps:** loop page loads of the app against the public RPC until `curl -i -X POST https://rpc.tiramisu.db-chain.testnet.arkiv.network -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["type = str('"'"'x'"'"')",{"limit":"0x1","select":{"key":true}}]}'` returns 429.
- **Cost measured:** every `arkiv_query` costs a flat 100 units in the `Arkiv-Cost` header (an `eth_blockNumber` costs none), so the 10000-unit budget is about 100 queries. Our first version issued 7 queries for a page with two live cuts (N+1); we now OR the outage keys together, so a page load is 4 queries.
- **What we did:** the browser app reads directly and falls back to a same-origin read-only proxy (`/rpc`, allowlist of read methods) that can use a server-side access key.
- **Fix idea:** document the anonymous budget and per-query cost in Access Keys, and return a JSON-RPC error (with `data.retryAfter`) so SDK clients can surface "rate limited, retry in N s".

## Paths tested that worked as documented
| Surface | What was run | Result |
|---|---|---|
| Seed (17 Oct) | `executeBatch({creates})` x4 (5 entities each) + `createEntity` + one more batch: 19 entities | all succeeded; relay balance went from 9.0 to 8.9976 GLM in total, i.e. about 0.0001 GLM per entity |
| Atomic batch with extension | relay `still_dark` by a neighbour: `executeBatch({creates:[confirm], extensions:[outage]})` | one tx; confirm created and lease renewed; the app showed "3 neighbours" and a fresh 2 h lease |
| Reporter or repeat tap | `extendEntity` only | tx ok; not counted as a new witness (by our logic) |
| Lease semantics | three extensions seconds apart | expiry block 683330 -> 683336 -> 683342: each extension sets a new expiry counted from now (documented), it does not add 2 h on top |
| **Permissionless extension** | a throwaway testnet key that does not own the entity (funded with 0.05 GLM) called `extendEntity` on a `permissionlessExtension` outage | succeeded (tx `0x928e0e2108875d93485ec6ab9d33a47a56b97a510287adfb7dbc52e72acce044`), owner stayed the relay wallet, expiry -> 683350 |
| Atomic batch with delete | "Power's back": `executeBatch({creates:[cut_log], deletes:[outage]})` | one tx; outage gone from `getEntity` (NoEntityFoundError), cut_log present with `confirmers=2` |
| Install | `npm i @arkiv-network/sdk viem` | 38 s, no peer-dependency errors |
| HTTP RPC | `eth_chainId`, `eth_blockNumber`, `arkiv_query` through the SDK | chain id 0x7614d1; block 670424 on 17 Oct |
| Query predicates | `eq` + `startsWith` + `gte` on `u64` and `i32`, `.createdBy()`, `.limit()` on an unused project name | all return 0 results without errors |
| Typed errors on reads | `getEntity` on an unknown key; on a 2-byte key | `NoEntityFoundError: No live entity with key 0x00… It was never created, or it has been deleted or has expired.` (clear and useful) and `InvalidValueError: … 2 bytes, not exactly 32 bytes.` |
| Query rendering | `render(predicate)` from `@arkiv-network/sdk/query` | produces the text the RPC expects, which the app prints in its "Verify without this app" panel |
| WebSocket | `watchEntityEvents` with `webSocket()` transport | connected and delivered events (15 in 15 s) |

## What to improve first
Make the first-write path less opaque: a typed insufficient-funds error (item 1) and a scriptable testnet faucet (item 2). They decide whether a new builder gets from install to a first entity in minutes or stalls.

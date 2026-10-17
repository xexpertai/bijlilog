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

### 6. "readonly" blocks edits but not deletion; sealing needs an ownership transfer
- **Surface:** creation flag `readonly` (SDK 0.8.1), `patchEntity`, `deleteEntity`, `changeOwnership` / batch `ownershipChanges`, `predictEntityKeys`.
- **Expected:** a record created `readonly` is immutable, so I planned to tell users "nobody, including us, can change or remove a published cut".
- **Actual:** edits are rejected with a very clear message: `EntityMutationError: Transaction failed: entity 0x21510277…2b2dd2 was created readonly, so its contents can never change. Its expiry can still be extended, and it can be transferred or deleted` (`evidence/readonly-output.txt`). So the owner can still delete it. To make the claim true, BijliLog now creates the cut_log and transfers it to `0x…dEaD` in one batch (`ownershipChanges`, with the new key from `predictEntityKeys` so the transfer can name an entity created in the same transaction). Verified (`evidence/e2e-output.txt`): `cut_log owner: 0x…dEaD | creator: <relay>`; patch and delete by the relay fail with `entity … is owned by 0x…dEaD, not 0x4407…`; a non-owner can still `extendEntity` it.
- **Steps:** `node --env-file=.env.local scripts/e2e.mjs http://127.0.0.1:18432` (server running with a funded relay key).
- **Friction in detail:** the docs/flag name suggest immutability, but deletion and transfer stay allowed; you only learn it from the error. Also, `predictEntityKeys` is only valid while nothing else from that owner is in flight; BijliLog serialises all relay writes in one queue to keep it true. A small mistake of ours: SDK 0.8.1 has `patchEntity`, not `updateEntity`, and our first readonly test called the wrong name.
- **Fix idea:** state the delete/transfer exceptions next to the flag in the docs, and offer a `sealed`/`immutable` creation flag (no delete, no transfer) so tamper-evident records do not depend on a burn address.

### 7. The anonymous read budget is small, and the rejection is not a JSON-RPC error
- **Surface:** public Tiramisu HTTP RPC without an access key; `arkiv_query`.
- **Expected:** the docs say the public RPC "works without one, at the default rate limit"; I expected a limit I could size an app against, and a standard JSON-RPC error when it is hit.
- **Actual:** after about a day of development (many page loads and video-recording runs, each page load issuing several `arkiv_query` calls from the browser) every query returned HTTP 429 with the body `{"error":"ANON_COST_LIMITED","message":"unauthenticated query budget exhausted; get an API key at https://hub.arkiv.network for a monthly quota"}`. That body is not a JSON-RPC error object (`error` is a string, no code/id), so SDK callers see a generic failure. The response headers are useful and complete (`RateLimit: limit=10000, remaining=0, reset=1328`, `Retry-After: 1328`, plus `Arkiv-Cost` and `Arkiv-Quota-Used-Percent` exposed to browsers), but the size of the budget, what one query costs and the window are not in the Access Keys page.
- **Steps:** loop page loads of the app against the public RPC until `curl -i -X POST https://rpc.tiramisu.db-chain.testnet.arkiv.network -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["type = str('"'"'x'"'"')",{"limit":"0x1","select":{"key":true}}]}'` returns 429.
- **Cost measured:** every `arkiv_query` costs a flat 100 units in the `Arkiv-Cost` header (an `eth_blockNumber` costs none), so the 10000-unit budget is about 100 queries. Our first version issued 7 queries for a page with two live cuts (N+1); we now OR the outage keys together, so a page load is 4 queries.
- **What we did:** the browser app reads directly and falls back to a same-origin read-only proxy (`/rpc`, allowlist of read methods) that can use a server-side access key.
- **Fix idea:** document the anonymous budget and per-query cost in Access Keys, and return a JSON-RPC error (with `data.retryAfter`) so SDK clients can surface "rate limited, retry in N s".

### 8. A default-configured client hangs for the whole rate-limit window instead of failing: the SDK honours `Retry-After`
- **Surface:** `createPublicClient({ chain: tiramisu, transport: http() })` (viem transport, default `retryCount: 3`) on the public RPC, once the anonymous `arkiv_query` budget is spent (item 7).
- **Expected:** an `arkiv_query` that is refused with 429 fails in well under a second with an error that says "rate limited", so an app can fall back or show a message.
- **Actual:** the call does not return. viem's retry reads the response's `Retry-After` header and sleeps that long before retrying (`node_modules/viem/utils/buildRequest.ts`, `delay: ... Number.parseInt(retryAfter, 10) * 1000`). The RPC sends `Retry-After: 1830` and, in a probe later that evening, `3243` (54 minutes). Measured on 17 Oct 2026 evening, right after the budget was spent (`evidence/budget-probe-output.txt`, `evidence/budget-probe-sdk-output.txt`): `retryCount: 0` fails in 0.24 to 0.7 s with `HttpRequestError: HTTP request failed`, status 429 and `details: "ANON_COST_LIMITED"`. With `retryCount: 3` the call printed "still waiting" every 15 s and was abandoned at 90 s; a first probe with the default transport was still waiting when its 300 s timeout killed it. The limit is not a hard cutoff: a few calls seconds later (one `retryCount: 3`, one default) were answered normally in about 500 ms, so the hang appears whenever a request is actually refused, and a loop of queries sees a mix of fast answers and very long stalls.
- **How it hit us (real):** on 17 Oct ~15:40 IST, `scripts/seed-demo-pin.mjs` sent a signed "Power's back" to our relay. The relay's own Arkiv read (to check whether the cut was already logged) used the default transport while, as far as we can tell, the anonymous budget was spent (a 429 with `Retry-After: 1830` was recorded minutes later, at 15:51 IST), and the request hung until the seeder's HTTP client gave up after 300 s. We did not capture the relay's stack at that moment, but the retry sleep above is the only wait of that length in the path, and the same call now answers 503 in 727 ms: `TypeError: fetch failed ... HeadersTimeoutError: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT)` (`seed380.log`, kept in our scratch folder). The relay returned nothing, so the browser/seeder saw only a transport error.
- **Fix idea (Arkiv):** ship `tiramisu` with a transport policy that does not sleep on `Retry-After` for 429s longer than a few seconds, or export a typed `RateLimitedError { retryAfterSeconds }`. Docs: "pass `http(url, { retryCount: 0 })` for reads that must fail fast".
- **What we did:** relay reads use `retryCount: 0, timeout: 20 s`; a rate-limit error becomes `503 "The public Arkiv network is rate-limiting this server right now"` (`server/server.mjs`, `isRateLimited` in `server/relay.js`, unit-tested). Verified against the spent budget: `evidence/relay-429-after-fix.txt` (503 in 727 ms; before, 300 s and no answer). Repro: `node scripts/probe-budget-sdk.mjs r0|r3|default` while the budget is spent (`scripts/probe-budget.mjs exhaust` burns it on purpose; it blocks your IP for about 30-55 min).

### 9. You cannot see the budget that blocks you, only a different one
- **Surface:** response headers of the public Tiramisu RPC (`curl -i -X POST ... arkiv_query`).
- **Expected:** the `RateLimit` header on a successful call tells me how much of the budget that will block me is left; the Access Keys page says responses expose `Arkiv-Quota-Used-Percent`.
- **Actual:** a successful `arkiv_query` returns `arkiv-cost: 100` and `ratelimit: limit=600, remaining=596, reset=29`, a **per-minute request window**. The 10,000-unit anonymous budget that actually blocked us is never shown on a 200: `Arkiv-Quota-Used-Percent` appears in `Access-Control-Expose-Headers` but is not sent on the 200 responses we checked. Only the 429 shows `ratelimit: limit=10000, remaining=0, reset=<s>`, and `reset` was 653, 1328, 1708, 1830 and 3243 on different occasions, so the window is not a fixed 30 minutes, and enforcement is not a hard cutoff (item 8: some calls still pass seconds after a 429). Meanwhile `eth_blockNumber` keeps returning 200, so a "chain is up" health check passes while every query fails.
- **Steps:** `curl -si -X POST https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["project = str('"'"'bijlilog-v1'"'"')",{"limit":"0x1","select":{"key":true}}]}'` and compare with the same call after the budget is spent (`evidence/budget-probe-output.txt`).
- **Fix idea:** send `RateLimit-Policy` with both limits (and `Arkiv-Quota-Used-Percent`) on every response, so a browser app can warn before it is blocked.

### 10. A write that times out leaves no receipt to ask about, and finding out costs a rate-limited read
- **Surface:** relay-style apps that submit a write and wait (`createEntity` / `executeBatch`), then need to know if it landed.
- **Expected:** a client-supplied idempotency key, or a receipt I can look up for free, so a retry after a timeout cannot create a second entity.
- **Actual (our run):** the hung "Power's back" of item 8 returned no transaction hash. To learn whether it had landed we had to query by attribute (`type = cut_log AND outage = key(<outage>)`), which is an `arkiv_query` costing 100 units, the very resource that was exhausted. When the budget came back the answer was: **it had not landed** (0 cut records for that outage; the outage lease later expired), so the seeder simply started over with a new live cut. We had assumed a timeout might mean "done on chain"; here it did not, and nothing in the client could tell us which.
- **Steps:** same as item 8, then `node scripts/verify.mjs 380001` lists the cuts that did land.
- **What we did:** the relay keeps the signed action in a used-signature set before writing (a replay returns 409), so a blind retry cannot double-write from our side. It does mean a timed-out action must be re-signed by the phone.
- **Fix idea:** accept a caller-chosen salt/nonce as an idempotency key on `createEntity` (`predictEntityKeys` already derives keys from owner, counter and salt, so a key could be reserved before sending), and document how to check a pending transaction by hash instead of by query.

## Paths tested that worked as documented
| Surface | What was run | Result |
|---|---|---|
| Seed (17 Oct) | `executeBatch({creates})` x4 (5 entities each) + `createEntity` + one more batch: 19 entities | all succeeded; relay balance went from 9.0 to 8.9976 GLM in total, i.e. about 0.0001 GLM per entity |
| Atomic batch with extension | relay `still_dark` by a neighbour: `executeBatch({creates:[confirm], extensions:[outage]})` | one tx; confirm created and lease renewed; the app showed "3 neighbours" and a fresh 2 h lease |
| Reporter or repeat tap | `extendEntity` only | tx ok; not counted as a new witness (by our logic) |
| Lease semantics | three extensions seconds apart | expiry block 683330 -> 683336 -> 683342: each extension sets a new expiry counted from now (documented), it does not add 2 h on top |
| **Permissionless extension** | a throwaway testnet key that does not own the entity (funded with 0.05 GLM) called `extendEntity` on a `permissionlessExtension` outage | succeeded (tx `0x928e0e2108875d93485ec6ab9d33a47a56b97a510287adfb7dbc52e72acce044`), owner stayed the relay wallet, expiry -> 683350 |
| Atomic batch with delete | "Power's back": `executeBatch({creates:[cut_log], deletes:[outage]})` | one tx; outage gone from `getEntity` (NoEntityFoundError), cut_log present with `confirmers=2` |
| Block time | `eth_getBlockByNumber` timestamps over the last 100, 10,000, 100,000 and 300,000 blocks (17 Oct, evening) | exactly 2.0000 s/block each time, so lifetimes in hours are accurate on Tiramisu today (docs: "block production is not a clock", so do not rely on it forever) |
| Wall-clock expiry | `ExpirationTime.atDate(new Date(windowEnd))` for the official-notice entities | accepted; `{ minLifetime: 0n, expiresAt: <Date> }`; a bad duration (`fromSeconds(9001)`) is rejected with a message that names the 2 s block time and suggests 9000 or 9002 |
| String attribute limit | `str` of 100, 256, 257 and 1000 characters (`scripts/probe-limits.mjs`) | 100 ok; longer is refused client-side with `InvalidValueError ... 256 UTF-8 bytes exceeds the 128-byte limit on a str. Store the long form in the entity payload`. The limit is in **bytes**, so a Devanagari value (3 bytes per character) fits about 42 characters. Clear message, documented |
| Batch size | `executeBatch` with 5, 20, 50 and 100 creates | all succeeded, each in about 7 s end to end (6.9, 7.0, 7.3, 7.6 s), so batching is close to free per entity; our seed scripts use 5 per batch out of caution, not need |
| Install | `npm i @arkiv-network/sdk viem` | 38 s, no peer-dependency errors |
| HTTP RPC | `eth_chainId`, `eth_blockNumber`, `arkiv_query` through the SDK | chain id 0x7614d1; block 670424 on 17 Oct |
| Query predicates | `eq` + `startsWith` + `gte` on `u64` and `i32`, `.createdBy()`, `.limit()` on an unused project name | all return 0 results without errors |
| Typed errors on reads | `getEntity` on an unknown key; on a 2-byte key | `NoEntityFoundError: No live entity with key 0x00… It was never created, or it has been deleted or has expired.` (clear and useful) and `InvalidValueError: … 2 bytes, not exactly 32 bytes.` |
| Query rendering | `render(predicate)` from `@arkiv-network/sdk/query` | produces the text the RPC expects, which the app prints in its "Verify without this app" panel |
| WebSocket | `watchEntityEvents` with `webSocket()` transport | connected and delivered events (15 in 15 s) |

## What to improve first
Make the first-write path less opaque: a typed insufficient-funds error (item 1) and a scriptable testnet faucet (item 2). They decide whether a new builder gets from install to a first entity in minutes or stalls.

# Friction report: building BijliLog on Arkiv

Versions: `@arkiv-network/sdk` 0.8.1, `viem` 2.57.4, Node 22, Tiramisu testnet (chain 7738577, 0x7614d1), 17 Oct 2026 (block ~670k). Every item below was run, not assumed; the probes are in `scripts/probe-friction.mjs`, `scripts/probe-gas.mjs` and `scripts/probe-read.mjs`. Read paths were exercised against the live testnet. Write paths (create, extend, batch) need test GLM; see items 1 and 2 for why that is a human step.

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

## Paths tested that worked as documented
| Surface | What was run | Result |
|---|---|---|
| Install | `npm i @arkiv-network/sdk viem` | 38 s, no peer-dependency errors |
| HTTP RPC | `eth_chainId`, `eth_blockNumber`, `arkiv_query` through the SDK | chain id 0x7614d1; block 670424 on 17 Oct |
| Query predicates | `eq` + `startsWith` + `gte` on `u64` and `i32`, `.createdBy()`, `.limit()` on an unused project name | all return 0 results without errors |
| Typed errors on reads | `getEntity` on an unknown key; on a 2-byte key | `NoEntityFoundError: No live entity with key 0x00… It was never created, or it has been deleted or has expired.` (clear and useful) and `InvalidValueError: … 2 bytes, not exactly 32 bytes.` |
| Query rendering | `render(predicate)` from `@arkiv-network/sdk/query` | produces the text the RPC expects, which the app prints in its "Verify without this app" panel |
| WebSocket | `watchEntityEvents` with `webSocket()` transport | connected and delivered events (15 in 15 s) |

## What to improve first
Make the first-write path less opaque: a typed insufficient-funds error (item 1) and a scriptable testnet faucet (item 2). They decide whether a new builder gets from install to a first entity in minutes or stalls.

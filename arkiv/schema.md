# BijliLog data contract on Arkiv (Tiramisu testnet, chain 7738577)

All entities carry `project = "bijlilog-v1"`. The contract lives in one file, [`src/lib/schema.js`](../src/lib/schema.js), shared by the browser app, the relay and the seed script. Everything below is generated from, and checked against, that file.

**Who writes.** One *relay wallet* creates every entity and pays the testnet fee (address in `src/web/config.js` and in the app's "Verify without this app" panel). A neighbour's phone holds a device key that only signs; the signed text is stored in the entity payload and the signer's address in the `device` attribute, so authorship can be re-verified from Arkiv data alone. Readers filter on `$creator = relay` so a stranger cannot inject records by copying the attributes.

**No personal data.** Free text is at most 60 characters and refused if it looks like an email, phone number, ID number, long number or house number (`src/lib/validate.js`). Demo data is synthetic and has `source = "demo"`.

## Entity types

### `outage` (a live cut = a lease)
| Attribute | Type | Meaning |
|---|---|---|
| `project` | str | `bijlilog-v1` |
| `type` | str | `outage` |
| `pin` | str | 6-digit India Post PIN code |
| `started_at_ms` | u64 | when power went (ms since epoch) |
| `source` | str | `user` or `demo` |
| `device` | addr | signing device (optional) |

Payload (JSON): `{ v, area, note, signed:{msg,sig} }`.
**Expiration: 2 hours** (`ExpirationTime.fromHours(2)`). **Flags: `permissionlessExtension`**, so any neighbour can renew the lease without owning the entity, but can never edit it.

### `confirm` (a neighbour says "still dark", or "restored")
Attributes: `project`, `type=confirm`, `outage` (**key** of the outage), `pin`, `kind` (`still_out`|`restored`), `at_ms` (u64), `source`, `device` (addr).
**Expiration: 30 days** (one billing-dispute window). **Flags: `readonly`**.

### `cut_log` (a finished cut: the year-long record, 365 days; anyone can renew it)
| Attribute | Type | Meaning |
|---|---|---|
| `project`, `type=cut_log`, `pin`, `source`, `device` | as above | |
| `started_at_ms`, `ended_at_ms` | u64 | range-queried |
| `duration_min` | i32 | range-queried ("4 hours or more") |
| `confirmers` | i32 | distinct neighbours who confirmed; range-queried ("confirmed only") |
| `origin` | str | `live` (closed from a live outage) or `backfill` (past cut added by hand) |
| `outage` | key | the outage it closed (live origin only) |

**Expiration: 365 days.** **Flags: `readonly` + `permissionlessExtension`**, and, for cuts closed through the app, **ownership transferred to `0x000000000000000000000000000000000000dEaD` in the same transaction** as the create. Result (tested on Tiramisu, `evidence/e2e-output.txt`): a patch or delete by the relay is rejected ("owned by 0x…dEaD"), a patch by anyone is rejected by `readonly` (`evidence/readonly-output.txt`), and anyone can still extend the record. `$creator` stays the relay wallet, so readers can still tell who wrote it. The 16 seed demo cuts are `readonly` but still owned by the relay.

## Writes (all via the Arkiv SDK 0.8.1)
| Action | Arkiv call | Why this shape |
|---|---|---|
| Report a cut | `createEntity` (`outage`) | starts the 2 h lease |
| "Still dark" by a neighbour | `executeBatch({ creates:[confirm], extensions:[outage] })` | confirmation and lease renewal land together or not at all |
| "Still dark" by the reporter, or a repeat | `extendEntity` | renews the lease but is not counted as a new witness |
| "Power's back" | `executeBatch({ creates:[cut_log], deletes:[outage], ownershipChanges:[cut_log -> 0x…dEaD] })`, key from `predictEntityKeys` | the year-long record (365 days, renewable by anyone), the end of the lease and the sealing in one transaction |
| Add a past cut | `executeBatch` (`cut_log`, `origin=backfill`, sealed to 0x…dEaD in the same batch) | |

## Queries the app runs (rendered by the SDK's `render()`; also shown in the app)
1. Live cuts for a PIN (exact) or postal district (prefix):
   `project = str('bijlilog-v1') AND type = str('outage') AND pin = str('<pin>')` or `pin STARTSWITH str('<prefix>')`, plus `$creator = addr(<relay>)`.
2. Neighbours who confirmed, for all live outages in one query: `project = str('bijlilog-v1') AND type = str('confirm') AND (outage = key(<k1>) OR outage = key(<k2>))`, plus `$creator = addr(<relay>)`.
3. Has a lease already been closed? `... AND type = str('cut_log') AND (outage = key(<k1>) OR ...)`, plus `$creator`. (Two queries for any number of outages: the public RPC charges a flat 100 cost units per `arkiv_query`, so a page load costs 4 queries.)
4. History for a PIN or prefix, all optional filters shown:
   `project = str('bijlilog-v1') AND type = str('cut_log') AND pin STARTSWITH str('<prefix>') AND started_at_ms >= u64(<since>) AND source = str('user') AND confirmers >= i32(1) AND duration_min >= i32(240)`, plus `$creator = addr(<relay>)`.
5. Pagination: `fetchAll()` follows the cursor, 200 per page.
6. Live updates: `watchEntityEvents` on a WebSocket transport (no `fromBlock`), filtered client-side to the relay as owner.

Reproduce all reads with no app: `node scripts/verify.mjs 411`.

## What deliberately stays off Arkiv
The signing device's private key (it never leaves the phone), the relay wallet's private key, and the relay's in-memory rate-limit counters. The relay is only a fee-payer: if it is down, every record already written stays readable and queryable straight from Arkiv.

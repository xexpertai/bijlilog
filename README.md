# BijliLog

**A community-kept power-cut log for your PIN code, stored on [Arkiv](https://arkiv.network).** Built for the Arkiv Global Tour Stop, track *Best Indian Use Case*. Runs on the Arkiv **Tiramisu testnet** (chain 7738577): no real money, no personal data.

> **Live app:** `https://bijlilog-196979752200.us-central1.run.app` (filled in at deploy) · **Demo video:** `<VIDEO_URL>` · Contract: [`arkiv/schema.md`](arkiv/schema.md) · Friction report: [`arkiv/friction.md`](arkiv/friction.md)

## Why India
Power cuts are an everyday fact for households and small shops across India, and the record of *when* power went and *how long* it stayed off normally sits with the utility. A tenant, a shopkeeper or a residents' association that wants to complain about repeated evening or night cuts has to rely on memory. BijliLog gives a neighbourhood a shared, tamper-evident log keyed on the one identifier everybody knows, the 6-digit **PIN code**, in English and Hindi, on a phone, without an account:

- **Report** a cut in one tap; neighbours tap **Still dark** to confirm and keep it live.
- **History** per PIN (or postal district by prefix): cuts, hours without power, longest cut, how many began at night, filtered by "confirmed by a neighbour" and "4 hours or more".
- **Download a CSV for a complaint**: every row carries its Arkiv entity key and an explorer link, so whoever receives it can verify it independently.

**Public sources behind the problem** (cited, not ours):
- The [Electricity (Rights of Consumers) Rules, 2020](https://www.cag.org.in/blogs/electricity-rights-consumers-rules-2020) require distribution licensees to supply 24x7 power (Rule 10), to communicate scheduled outages by SMS or other electronic means (Rule 16), and provide for automatic compensation (Rule 13). Unscheduled cuts have no neighbour-held record: that gap is what BijliLog fills. (PIB press release on the Rules: <https://www.pib.gov.in/PressReleasePage.aspx?PRID=1682384>.)
- State compensation schemes pay for *restoration delay*, which needs a start and an end time. Example from the same source: Tamil Nadu pays Rs 50 for every six hours (or part) of delay in restoration, capped at Rs 2,000. A BijliLog cut record is exactly a start, an end and a verifiable key.
- A [LocalCircles survey of 23 May 2024](https://www.localcircles.com/a/press/page/electricity-power-outage-survey) (over 15,000 households in 364 districts; self-selected online respondents, so indicative only) reported that 38% of households confirmed daily power outages, up from 20% in February. We quote it as context, not as a measurement of any PIN code.

*Honesty note:* this was built and tested by one person. It has no real users yet, and the demo records are synthetic and labelled **DEMO** in the app. We make no claims about outage statistics.

## Why Arkiv (what breaks without it)
| Property used | What goes wrong on a database an operator controls |
|---|---|
| **Entities expire by themselves** | A "live cut" must disappear if nobody confirms it. Here the 2-hour lease *is* the entity's expiration; no cleanup job to trust or run. |
| **Permissionless extension** | Any neighbour renews a lease without being its owner and without being able to edit it. A database needs accounts and an auth model for that. |
| **Read-only entities** | A published cut record cannot be edited by anyone, including the operator (verified on Tiramisu: patches are rejected). Only the owner wallet could delete it, openly on chain. That is what makes it usable evidence in a complaint. |
| **Creator is on-chain (`$creator`)** | Readers filter on the relay wallet, so strangers cannot inject look-alike records. |
| **Queries from the browser** | The page reads Arkiv directly. If our server disappears, every record stays readable and queryable. |

What deliberately stays off Arkiv: device private keys, the relay wallet key and rate-limit counters.

## How it uses Arkiv
Details and exact queries are in [`arkiv/schema.md`](arkiv/schema.md). In short: typed attributes with numeric ranges (`started_at_ms`, `duration_min`, `confirmers`), `startsWith` on `pin` for postal districts, `$creator` filtering, cursor pagination, **different expiry per type** (outage 2 h, confirm 30 d, cut log 365 d), `extendEntity` as a lease renewed by activity, creation flags (`permissionlessExtension`, `readonly`), **atomic batches** (confirm + renew; cut record + end of lease) and `watchEntityEvents` over WebSocket so the page updates without polling.

**Trust model.** One relay wallet pays the testnet fee, so neighbours need no wallet. Each phone holds a device key that only signs; the signed text sits in the entity payload with the signer's address, and the app re-verifies the signature on every record it shows.

## Run it
Needs Node 22.
```bash
npm ci
npm test                       # 15 tests (data contract, validation, relay logic, server routing)
npm run build && npm start     # http://localhost:8080 : read-only until a relay key is set
```
To enable writes, put a **testnet-only** key in `.env.local` as `SPONSOR_PRIVATE_KEY=0x...`, fund its address with test GLM at <https://hub.arkiv.network/faucet>, then `npm run dev`.
```bash
node --env-file=.env.local scripts/seed.mjs --live   # synthetic, labelled demo data (add --dry to preview)
node scripts/e2e.mjs                                  # real create/extend/batch run against Tiramisu (relay must be funded)
node scripts/verify.mjs 411                           # reproduce the app's reads with no app and no server
CONFIRM_PUBLIC=1 scripts/deploy-cloudrun.sh           # optional: Cloud Run (Dockerfile included)
```
The relay wallet address that creates every entity is in [`src/web/config.js`](src/web/config.js).

## Layout
`src/lib/` data contract, validation, signing, stats · `server/` write relay and static server · `src/web/`, `web/` browser app · `arkiv/` schema and friction report · `scripts/` seed, verify, probes, video pipeline · `test/` tests.

## AI assistance
**Narration: synthetic voice.** The demo video is narrated by the open-source Kokoro text-to-speech model, not a human voice.

Built with AI assistance (Claude Code, Anthropic). The demo video voice is synthesized with the open-source Kokoro model. The code was written by Claude Code under the author's direction; the tests are in this repo.

## Licence
MIT, see [LICENSE](LICENSE).

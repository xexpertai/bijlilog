// Gas/cost probe. Uses the testnet-only sponsor key from .env.local. Prints only addresses/numbers.
import { createWalletClient, createPublicClient, ExpirationTime, jsonToPayload, str, u64 } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const account = privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY);
const pc = createPublicClient({ chain: tiramisu, transport: http() });
const wc = createWalletClient({ chain: tiramisu, transport: http(), account });
console.log("address", account.address, "balance GLM", formatEther(await pc.getBalance({ address: account.address })));
console.log("gasPrice wei", await pc.getGasPrice());
const days = Number(process.argv[2] ?? 1);
try {
  const r = await wc.createEntity({ payload: jsonToPayload({ probe: true }), contentType: "application/json",
    attributes: { project: str("bijlilog-probe"), type: str("probe"), at_ms: u64(Date.now()) }, expires: ExpirationTime.fromDays(days) });
  console.log("created", r.entityKey, r.txHash);
  const rc = await pc.getTransactionReceipt({ hash: r.txHash });
  console.log("gasUsed", rc.gasUsed, "cost GLM", formatEther(rc.gasUsed * rc.effectiveGasPrice));
} catch (e) { console.log("ERR", e.shortMessage ?? e.message.split("\n").slice(0,4).join(" | ")); }

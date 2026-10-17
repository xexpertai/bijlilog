import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http } from "viem"; import { privateKeyToAccount } from "viem/accounts";
const wc = createWalletClient({ chain: tiramisu, transport: http(), account: privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY) });
try { const r = await wc.patchEntity({ entityKey: process.argv[2], set: { note_edit: "x" } }); console.log("UNEXPECTED success", r.txHash); } catch (e) { console.log("rejected:", e.name, "|", (e.shortMessage ?? e.message).split("\n").slice(0,3).join(" | ")); }

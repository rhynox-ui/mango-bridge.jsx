// scripts/verify-arc.mjs
//
// Pins the Arc-specific rules. On Arc, USDC is both the gas token and an
// ERC-20: eth_getBalance reports it with 18 decimals, the ERC-20 at
// 0x3600… with 6. Mixing the two is a 10^12 error, and listing both
// views as separate assets would count the same dollars twice.
//
// Run: node scripts/verify-arc.mjs

import {
  ARC_USDC,
  ARC_GAS_RESERVE_USDC,
  MAINNET_CHAIN_IDS,
  NATIVE_SYMBOL,
  TOKEN_ADDRESSES,
  currencyAddress,
  canRelayHandle,
  assetDecimalsForChain,
} from "../src/chainData.js";
import { tokensForWalletChain } from "../src/wallet/walletTokens.js";
import { buildAggregatedRows } from "../src/wallet/assetAggregation.js";
import { CHAIN_KEY_TO_WAGMI_MAINNET, RPC_FALLBACKS } from "../src/wallet/chainRegistry.js";

let passed = 0;
const failures = [];
const check = (name, fn) => { try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m ?? "assertion failed"); };

check("Arc is chain 5042 with USDC as its native asset", () => {
  assert(MAINNET_CHAIN_IDS.arc === 5042, `got ${MAINNET_CHAIN_IDS.arc}`);
  assert(NATIVE_SYMBOL.arc === "USDC", `got ${NATIVE_SYMBOL.arc}`);
});

check("Arc USDC resolves to the 6-decimal ERC-20, never the 18-decimal 0x0 sentinel", () => {
  assert(ARC_USDC === "0x3600000000000000000000000000000000000000", ARC_USDC);
  assert(currencyAddress("arc", "USDC") === ARC_USDC, currencyAddress("arc", "USDC"));
  assert(assetDecimalsForChain("arc", "USDC") === 6, `got ${assetDecimalsForChain("arc", "USDC")}`);
});

check("Relay can route Arc USDC both ways", () => {
  assert(canRelayHandle("arc", "base", "USDC", "USDC"), "arc -> base");
  assert(canRelayHandle("base", "arc", "USDC", "USDC"), "base -> arc");
  assert(!canRelayHandle("arc", "base", "ETH", "ETH"), "ETH has no Arc address");
});

check("Arc USDC is NOT also a token entry (it would be counted twice)", () => {
  assert(TOKEN_ADDRESSES.USDC.arc === undefined, "TOKEN_ADDRESSES.USDC.arc must stay unset");
  assert(tokensForWalletChain("arc").length === 0, JSON.stringify(tokensForWalletChain("arc")));
});

check("wallet dashboard shows Arc's USDC once, merged with other chains' USDC", () => {
  const nativeSymbolFor = (k) => ({ ethereum: "ETH", arc: "USDC" })[k];
  const tokensFor = (k) => (k === "ethereum" ? [{ symbol: "USDC", address: TOKEN_ADDRESSES.USDC.ethereum, decimals: 6, isCustom: false }] : tokensForWalletChain(k));
  const rows = buildAggregatedRows(["ethereum", "arc"], { nativeSymbolFor, tokensFor });
  const usdc = rows.find((r) => r.symbol === "USDC");
  assert(usdc?.kind === "aggregate", JSON.stringify(usdc));
  const arcSources = usdc.sources.filter((s) => s.chainKey === "arc");
  assert(arcSources.length === 1, `expected one Arc USDC source, got ${arcSources.length}`);
});

check("Arc viem chain has real RPCs and an 18-decimal native currency", () => {
  const chain = CHAIN_KEY_TO_WAGMI_MAINNET.arc;
  assert(chain?.id === 5042, JSON.stringify(chain?.id));
  assert(chain.nativeCurrency.decimals === 18, `got ${chain.nativeCurrency.decimals}`);
  assert(chain.rpcUrls.default.http.length > 0, "no default RPC");
  assert((RPC_FALLBACKS[5042] || []).length >= 2, "needs at least two fallback RPCs");
});

check("MAX keeps a small, positive USDC gas reserve on Arc", () => {
  assert(ARC_GAS_RESERVE_USDC > 0 && ARC_GAS_RESERVE_USDC <= 0.1, `got ${ARC_GAS_RESERVE_USDC}`);
});

console.log(`${passed}/${passed + failures.length} checks passed`);
for (const f of failures) console.error(`  FAIL ${f}`);
if (failures.length > 0) process.exit(1);

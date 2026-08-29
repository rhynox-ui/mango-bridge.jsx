// scripts/verify-automation.mjs
//
// Offline checks for the automation backend's signature-based auth and
// input validation — the parts that don't need a live Redis connection.
// automationStore.js's own Redis-touching logic (createChallenge,
// verifyChallenge's session write, createAutomation, the whole job
// queue/claim/ack lifecycle) needs a real Upstash instance to exercise,
// same honest boundary verify-referral.mjs's own header already draws
// for claimReferral().

import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { isValidAddress, messageForChallenge, validateAutomationConfig, SUPPORTED_AUTOMATION_CHAINS } from "../api/automationStore.js";

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    console.log(`ok - ${name}`);
    passed++;
  } else {
    console.log(`FAIL - ${name}`);
    failed++;
  }
}

const TEST_PRIVATE_KEY = `0x${"b2".repeat(32)}`;
const account = privateKeyToAccount(TEST_PRIVATE_KEY);

check("isValidAddress accepts a real address", isValidAddress(account.address));
check("isValidAddress rejects a malformed address", !isValidAddress("0xnotanaddress"));
check("isValidAddress rejects a non-string", !isValidAddress(42));

const nonce = "abc123";
const message = messageForChallenge(account.address, nonce);
check("messageForChallenge embeds the wallet address and nonce", message.includes(account.address.toLowerCase()) && message.includes(nonce));
check("messageForChallenge states this never grants spending/signing access — a user signing this deserves to know that", message.toLowerCase().includes("does not grant"));

const signature = await account.signMessage({ message });
const validForRealAddress = await verifyMessage({ address: account.address, message, signature });
check("a real signature verifies for the address that actually signed it", validForRealAddress);

const validForWrongAddress = await verifyMessage({ address: "0x000000000000000000000000000000000000dEaD", message, signature });
check("the same signature does NOT verify for a different address", !validForWrongAddress);

const tamperedMessage = messageForChallenge(account.address, "different-nonce");
const validForTamperedMessage = await verifyMessage({ address: account.address, message: tamperedMessage, signature });
check("a signature for one nonce does NOT verify against a message built with a different nonce — replay resistance", !validForTamperedMessage);

// --- validateAutomationConfig ---

const validDca = { chainKey: "ethereum", fromAsset: "USDC", toAsset: "ETH", amount: "10", intervalMs: 86_400_000 };
check("validateAutomationConfig accepts a real, valid DCA config", (() => {
  try {
    validateAutomationConfig("dca", validDca);
    return true;
  } catch {
    return false;
  }
})());

const validLimit = { chainKey: "ethereum", fromAsset: "ETH", toAsset: "USDC", amount: "1", watchedAsset: "ETH", triggerPriceUsd: 4000, triggerDirection: "above" };
check("validateAutomationConfig accepts a real, valid Limit config", (() => {
  try {
    validateAutomationConfig("limit", validLimit);
    return true;
  } catch {
    return false;
  }
})());

check("validateAutomationConfig rejects an unsupported chain — never silently accepts a chain this backend has no verified data for", (() => {
  try {
    validateAutomationConfig("dca", { ...validDca, chainKey: "some-made-up-chain" });
    return false;
  } catch {
    return true;
  }
})());

check("validateAutomationConfig rejects fromAsset === toAsset", (() => {
  try {
    validateAutomationConfig("dca", { ...validDca, toAsset: validDca.fromAsset });
    return false;
  } catch {
    return true;
  }
})());

check("validateAutomationConfig rejects a non-positive amount", (() => {
  try {
    validateAutomationConfig("dca", { ...validDca, amount: "0" });
    return false;
  } catch {
    return true;
  }
})());

check("validateAutomationConfig rejects a DCA interval under 1 minute — never schedules something aggressive enough to hammer the worker", (() => {
  try {
    validateAutomationConfig("dca", { ...validDca, intervalMs: 5000 });
    return false;
  } catch {
    return true;
  }
})());

check("validateAutomationConfig rejects a Limit order with an invalid triggerDirection", (() => {
  try {
    validateAutomationConfig("limit", { ...validLimit, triggerDirection: "sideways" });
    return false;
  } catch {
    return true;
  }
})());

check("validateAutomationConfig rejects a Limit order with a non-positive triggerPriceUsd", (() => {
  try {
    validateAutomationConfig("limit", { ...validLimit, triggerPriceUsd: -1 });
    return false;
  } catch {
    return true;
  }
})());

check("validateAutomationConfig rejects an unknown automation type", (() => {
  try {
    validateAutomationConfig("copy", validDca);
    return false;
  } catch {
    return true;
  }
})());

check("SUPPORTED_AUTOMATION_CHAINS matches exactly the 7 chains mango-mobile's own automationChains() offers — kept in sync by hand, this is the regression guard for that", (() => {
  const expected = new Set(["ethereum", "base", "bnb", "robinhood", "arbitrum", "avalanche", "unichain"]);
  return SUPPORTED_AUTOMATION_CHAINS.size === expected.size && [...expected].every((c) => SUPPORTED_AUTOMATION_CHAINS.has(c));
})());

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);

// scripts/verify-referral.mjs
//
// Offline checks for the referral system's signature-based auth and
// input validation — the parts that don't need a live Redis connection.
// claimReferral()'s actual point-crediting logic needs a real Upstash
// instance to exercise (not verified here, same honest boundary every
// other verify script in this repo draws for live-network-dependent
// code).

import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { buildReferralClaimMessage } from "../api/v1/referral/claim.js";
import { buildDailyClaimMessage } from "../api/v1/referral/daily.js";
import { isValidAddress } from "../api/referralStore.js";

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

const TEST_PRIVATE_KEY = `0x${"a1".repeat(32)}`;
const account = privateKeyToAccount(TEST_PRIVATE_KEY);
const referrer = "0x000000000000000000000000000000000000dEaD";

check("isValidAddress accepts a real checksummed address", isValidAddress(account.address));
check("isValidAddress accepts a lowercase address", isValidAddress(account.address.toLowerCase()));
check("isValidAddress rejects a malformed address", !isValidAddress("0x123"));
check("isValidAddress rejects a non-string", !isValidAddress(12345));

const message = buildReferralClaimMessage(account.address, referrer);
check(
  "buildReferralClaimMessage embeds both the claiming address and the referrer",
  message.includes(account.address.toLowerCase()) && message.includes(referrer.toLowerCase()),
);

const signature = await account.signMessage({ message });
const validForRealAddress = await verifyMessage({ address: account.address, message, signature });
check("a real signature verifies for the address that actually signed it", validForRealAddress);

const validForWrongAddress = await verifyMessage({ address: referrer, message, signature });
check("the same signature does NOT verify for a different address", !validForWrongAddress);

const tamperedMessage = buildReferralClaimMessage(account.address, account.address);
const validForTamperedMessage = await verifyMessage({ address: account.address, message: tamperedMessage, signature });
check("a signature over one message does NOT verify against a different (tampered) message", !validForTamperedMessage);

const dailyMessage = buildDailyClaimMessage(account.address);
const dailySignature = await account.signMessage({ message: dailyMessage });
const dailyValidForRealAddress = await verifyMessage({ address: account.address, message: dailyMessage, signature: dailySignature });
check("a daily check-in signature verifies for the address that actually signed it", dailyValidForRealAddress);

const dailyValidForWrongAddress = await verifyMessage({ address: referrer, message: dailyMessage, signature: dailySignature });
check("the same daily check-in signature does NOT verify for a different address", !dailyValidForWrongAddress);

check(
  "the referral claim message and the daily check-in message are distinct (no cross-endpoint replay)",
  message !== dailyMessage,
);

console.log(`\n${passed}/${passed + failed} checks passed.`);
if (failed > 0) {
  process.exit(1);
}

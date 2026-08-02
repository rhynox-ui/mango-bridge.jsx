# Mango Bridge Documentation

**Status:** Testnet. This document describes what is actually implemented today, distinguished clearly from what's planned. Nothing here should be read as describing a mainnet, audited, or production-ready product.

---

## Introduction

Mango Bridge is a unified cross-chain asset bridge that routes transfers through the most secure and appropriate protocol available for each supported network pair, rather than relying on one bridge mechanism for everything.

Users interact with a single interface. Underneath, Mango Bridge selects the underlying protocol based on the source chain, destination chain, and asset being transferred — CCTP for USDC, native rollup bridges for ETH on rollups, and Wormhole where no native option exists yet.

---

## Supported Protocols

### Circle CCTP

Circle's Cross-Chain Transfer Protocol enables native USDC transfers between supported chains via a burn-and-mint mechanism — no wrapped tokens.

**How it works**
1. USDC is burned on the source chain via the TokenMessenger contract.
2. Circle's attestation service observes the burn and signs an attestation.
3. The destination chain's MessageTransmitter contract verifies the attestation.
4. Canonical USDC is minted directly to the recipient.

**Why it matters:** there is no lock-and-mint vault to exploit, and the destination token is the same USDC issued by Circle everywhere else — not a bridge-specific derivative.

**Live routes:** Ethereum Sepolia ↔ Base Sepolia, Ethereum Sepolia ↔ Arc Testnet (USDC)

Note: TokenMessenger/MessageTransmitter contract addresses are *not* identical across every CCTP chain — Arc uses its own deployment, distinct from the address shared by Ethereum and Base. Always verify per-chain addresses against Circle's and the chain's own official docs rather than assuming reuse.

---

### Base Bridge (OP Stack)

Base's official canonical bridge for ETH between Ethereum and Base.

**Deposit (Ethereum → Base):** User → Ethereum bridge contract → Base. Finalizes in minutes.

**Withdrawal (Base → Ethereum):** Initiate → prove (once provable, ~1 hour later) → wait out a **7-day fraud-proof challenge window** → finalize. This delay is not a UI limitation — it's how OP Stack's security model works, giving anyone time to dispute a fraudulent withdrawal before funds release on L1.

**Live route:** Ethereum Sepolia ↔ Base Sepolia (ETH)

---

### Arbitrum Canonical Bridge

Used for Robinhood Chain, which is built on Arbitrum Orbit.

**Deposit (Ethereum → Robinhood Chain):** Fast, minutes.

**Withdrawal (Robinhood Chain → Ethereum):** Initiate → wait out a **~6.4–7 day challenge period** → execute (single finalization step, no separate "prove" transaction like OP Stack).

**Live route:** Ethereum Sepolia ↔ Robinhood Chain Testnet (ETH)

---

### Wormhole

Used for the one route with no native rollup bridge or CCTP support: BNB Chain.

**How it works**
1. Asset is locked on the source chain.
2. Wormhole's Guardian Network (a fixed set of ~19 validators) observes the transaction.
3. Guardians collectively sign a VAA (Verified Action Approval).
4. The destination chain verifies the VAA and mints a wrapped representation.

**Important distinction:** the destination asset is **Wormhole-wrapped**, not the native token — a different trust model than CCTP or the canonical rollup bridges, since you're trusting a fixed validator set rather than a fraud-proof window or a single accountable issuer.

**Live route:** Ethereum Sepolia → BNB Testnet (ETH only, one direction). The reverse direction is not yet implemented.

---

## Bridge Routing Logic

Mango Bridge determines the protocol automatically based on:
- Source chain
- Destination chain
- Asset being transferred

If a specific chain/asset pair doesn't have a real integration built yet, the interface clearly labels the transfer as **simulated** rather than silently pretending it's real. Users never need to pick a protocol manually.

---

## Security Model

Mango Bridge prioritizes canonical, native-asset bridges over wrapped-asset bridges wherever one exists for a given pair.

| Protocol | Trust Model | Wrapped Asset? |
|---|---|---|
| Circle CCTP | Circle's attestation service | No |
| Base Bridge (OP Stack) | Ethereum + fraud proofs | No |
| Arbitrum Bridge | Ethereum + fraud proofs | No |
| Wormhole | Guardian validator set | Yes |

Canonical bridges are used whenever available; Wormhole is used only where no native alternative exists yet, and this tradeoff is disclosed to the user in the interface itself, not just in this document.

---

## Transaction Lifecycle

1. Connect wallet
2. Select source and destination chain
3. Select asset
4. Mango Bridge determines the applicable protocol (or marks the route as simulated)
5. Review screen shows fees, estimated time, and protocol-specific disclosures
6. User signs the required transaction(s)
7. For instant routes (CCTP, deposits, Wormhole): the app tracks the transfer to completion in one session
8. For withdrawal routes (Base/Robinhood Chain → Ethereum): the app tracks a **pending withdrawal** across the required real-world waiting period, with a dedicated Withdrawals tab for checking status and completing the final step(s) later

---

## Fees

Every transfer may include:
- **Source chain gas** — paid to the network, not Mango Bridge
- **Destination chain gas** — where a destination-side transaction is required
- **1% protocol fee** — sent as its own visible on-chain transfer for real routes, so it's never hidden inside another transaction

All fees are itemized in the review screen before a user confirms.

---

## Supported Assets

- **ETH** — real on Ethereum↔Base, Ethereum↔Robinhood Chain, and Ethereum→BNB (Wormhole-wrapped)
- **USDC** — real on Ethereum↔Base and Ethereum↔Arc via CCTP
- **USDT, WBTC** — interface present, not yet wired to any real protocol (simulated only)

---

## Current Limitations (read before assuming a route is real)

- Only pairs explicitly listed above under "Live route" execute real on-chain transactions. Every other chain/asset combination — including any direct Base↔Robinhood Chain or Base↔BNB route, and BNB→Ethereum in reverse — is simulated.
- Withdrawal routes take real, multi-day time. There is no way to speed this up; it's a property of the underlying rollup's security design.
- This entire app runs on testnets only. No mainnet deployment, audit, or legal/compliance review has occurred.

---

## Roadmap

- Additional EVM networks (evaluating Stable, pending confirmation of its cross-chain mechanism)
- Reverse Wormhole redemption (BNB → Ethereum)
- Non-Ethereum-hub direct routes between L2s/L3s
- Cross-chain **swaps** (different asset in ≠ asset out) — this is a distinct capability from bridging and likely requires a DEX+bridge aggregator (e.g. LI.FI) rather than more hand-built single-purpose integrations
- Security review of integration code prior to any mainnet consideration
- Legal/compliance review prior to any mainnet consideration

---

*This document describes the testnet implementation as of the current build. It is not a security audit, an offering document, or investment material.*

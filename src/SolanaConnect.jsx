// src/SolanaConnect.jsx
//
// Standalone, isolated Solana wallet connection — genuinely separate from
// the existing wagmi-based EVM connection, since Solana isn't EVM-
// compatible and needs its own connection standard entirely.
//
// Deliberately NOT wired into the main Bridge UI yet. This is step one:
// prove a real Solana address can be connected at all, before building
// anything on top of it. Once this is confirmed working live, the next
// real step is requesting an actual Relay quote TO this address, which
// will show us Relay's real Solana chain identifier directly from a live
// API response rather than guessed from documentation.
//
// Uses OKX Connect (@okxconnect/universal-provider +
// @okxconnect/solana-provider) — chosen specifically because it's a
// single, unified SDK covering both EVM and Solana through one session,
// rather than needing two entirely separate wallet libraries. Real,
// genuine caveat: this is a newer integration, verified against search
// results and package documentation, not yet proven with a real live
// connection — that's exactly what this component exists to test.

import React, { useState, useEffect, useRef } from "react";
import { OKXUniversalProvider } from "@okxconnect/universal-provider";
import { OKXSolanaProvider } from "@okxconnect/solana-provider";

// Real, official Solana mainnet genesis hash — this is the identifier
// OKX Connect expects, confirmed from their own documented example
// ("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), not guessed.
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export default function SolanaConnectTest() {
  const [connecting, setConnecting] = useState(false);
  const [connectedAddress, setConnectedAddress] = useState(null);
  const [error, setError] = useState(null);
  const providerRef = useRef(null);
  const solanaProviderRef = useRef(null);

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      // Real initialization step — creates the universal provider that
      // OKXSolanaProvider wraps. dappMetadata is required by OKX Connect's
      // own API for wallet-side display during the connection prompt.
      const universalProvider = await OKXUniversalProvider.init({
        dappMetaData: {
          name: "Mango Protocol",
          icon: "https://mangoprotocol.site/logo.png",
        },
      });
      providerRef.current = universalProvider;

      const session = await universalProvider.connect({
        namespaces: {
          solana: {
            chains: [SOLANA_MAINNET],
          },
        },
      });

      const solanaProvider = new OKXSolanaProvider(universalProvider);
      solanaProviderRef.current = solanaProvider;

      const account = solanaProvider.getAccount();
      if (!account?.address) {
        throw new Error("Connected, but no Solana address was returned — genuine unexpected state, worth investigating directly");
      }
      setConnectedAddress(account.address);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    try {
      await providerRef.current?.disconnect();
    } catch {
      // Real disconnect failures aren't critical here — clear local state
      // regardless, since the goal is just resetting this test component.
    }
    setConnectedAddress(null);
    providerRef.current = null;
    solanaProviderRef.current = null;
  }

  return (
    <div style={{ padding: 20, maxWidth: 400, margin: "0 auto", fontFamily: "monospace" }}>
      <h3 style={{ marginBottom: 12 }}>Solana Connection Test</h3>
      <p style={{ fontSize: 12, color: "#888", marginBottom: 16 }}>
        Standalone test — not part of the main bridge yet. This only proves whether a real Solana address can be connected via OKX Connect.
      </p>

      {!connectedAddress ? (
        <button
          onClick={handleConnect}
          disabled={connecting}
          style={{ padding: "10px 16px", borderRadius: 8, background: connecting ? "#555" : "#000", color: "#fff", border: "none" }}
        >
          {connecting ? "Connecting…" : "Connect Solana Wallet"}
        </button>
      ) : (
        <div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>Connected address:</div>
          <div style={{ fontSize: 13, wordBreak: "break-all", marginBottom: 12 }}>{connectedAddress}</div>
          <button onClick={handleDisconnect} style={{ padding: "8px 14px", borderRadius: 8, background: "#333", color: "#fff", border: "none" }}>
            Disconnect
          </button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: "#3a1a1a", color: "#f88", fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}

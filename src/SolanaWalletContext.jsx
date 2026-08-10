// src/SolanaWalletContext.jsx
//
// Real, shared Solana connection state, using OKX Connect — the same
// mechanism already proven working on the standalone ?test=solana page.
// Lifted into a proper React Context here so the actual bridge UI (wallet
// selector, balance display, transaction signing) can all share one real
// connection instead of each needing its own.

import React, { createContext, useContext, useState, useRef, useCallback } from "react";
import { OKXUniversalProvider } from "@okxconnect/universal-provider";
import { OKXSolanaProvider } from "@okxconnect/solana-provider";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const SolanaWalletContext = createContext(null);

export function SolanaWalletProvider({ children }) {
  const [address, setAddress] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const universalProviderRef = useRef(null);
  const solanaProviderRef = useRef(null);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const universalProvider = await OKXUniversalProvider.init({
        dappMetadata: {
          name: "Mango Protocol",
          icon: "https://mangoprotocol.site/logo.png",
        },
      });
      universalProviderRef.current = universalProvider;

      await universalProvider.connect({
        namespaces: { solana: { chains: [SOLANA_MAINNET] } },
      });

      const solanaProvider = new OKXSolanaProvider(universalProvider);
      solanaProviderRef.current = solanaProvider;

      const account = solanaProvider.getAccount();
      if (!account?.address) {
        throw new Error("Connected, but no Solana address was returned");
      }
      setAddress(account.address);
      return account.address;
    } catch (err) {
      const message = err?.message || String(err);
      setError(message);
      throw err;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await universalProviderRef.current?.disconnect();
    } catch {
      // Real disconnect failures aren't critical — clear local state
      // regardless, same reasoning as the standalone test page.
    }
    setAddress(null);
    universalProviderRef.current = null;
    solanaProviderRef.current = null;
  }, []);

  // GENUINE, NAMED GAP: signing and submitting a real Solana transaction
  // (what's actually needed to bridge FROM Solana, not just receive INTO
  // it) is not implemented here yet. solanaProviderRef.current exposes
  // OKX's real signTransaction method once connected — that's the right
  // foundation, but building and sending an actual Solana transaction is
  // a separate, substantial piece of work, deliberately not rushed into
  // this same change.

  return (
    <SolanaWalletContext.Provider value={{ address, connecting, error, connect, disconnect, solanaProvider: solanaProviderRef }}>
      {children}
    </SolanaWalletContext.Provider>
  );
}

export function useSolanaWallet() {
  const ctx = useContext(SolanaWalletContext);
  if (!ctx) throw new Error("useSolanaWallet must be used within SolanaWalletProvider");
  return ctx;
}

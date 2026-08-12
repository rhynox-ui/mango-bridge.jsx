// src/SolanaWalletContext.jsx
//
// Real, shared Solana connection state. Originally OKX Connect only; now
// also supports Phantom, Solflare, and Backpack via each wallet's own real,
// documented injected provider (window.phantom.solana, window.solflare,
// window.backpack.solana) — the same interface these wallets expose to
// every Solana dapp, not a fabricated stand-in. OKX keeps using its
// Universal Provider SDK (already proven working) since that's a
// QR/session-based connection rather than a browser-extension injection,
// so it doesn't fit the same detection pattern as the other three.
//
// GENUINE, NAMED GAP: signing and submitting a real Solana transaction
// (what's actually needed to bridge FROM Solana) has only been live-
// verified through OKX so far (see relaySdkSolanaExecution.js). Phantom,
// Solflare, and Backpack all expose the same `signTransaction(transaction)`
// shape, so the existing call site should work unchanged, but that's an
// expectation from documented interfaces, not a live-tested claim — flag
// this if a Phantom/Solflare/Backpack-sourced transfer is reported broken.

import React, { createContext, useContext, useState, useRef, useCallback } from "react";
import { OKXUniversalProvider } from "@okxconnect/universal-provider";
import { OKXSolanaProvider } from "@okxconnect/solana-provider";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

// Real, documented flags each wallet's injected provider sets on itself —
// used both to decide whether "Connect" should be clickable and to make
// sure we're talking to the wallet we think we are.
export function detectSolanaWallet(type) {
  if (typeof window === "undefined") return false;
  if (type === "okx") return true; // Universal Provider — no extension required
  if (type === "phantom") return !!window.phantom?.solana?.isPhantom;
  if (type === "solflare") return !!window.solflare?.isSolflare;
  if (type === "backpack") return !!window.backpack?.solana?.isBackpack;
  return false;
}

const SolanaWalletContext = createContext(null);

export function SolanaWalletProvider({ children }) {
  const [address, setAddress] = useState(null);
  const [walletType, setWalletType] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const universalProviderRef = useRef(null);
  const providerRef = useRef(null);

  const connectOkx = useCallback(async () => {
    const universalProvider = await OKXUniversalProvider.init({
      dappMetaData: {
        name: "Mango Protocol",
        icon: "https://mangoprotocol.site/logo.png",
      },
    });
    universalProviderRef.current = universalProvider;

    await universalProvider.connect({
      namespaces: { solana: { chains: [SOLANA_MAINNET] } },
    });

    const solanaProvider = new OKXSolanaProvider(universalProvider);
    const account = solanaProvider.getAccount();
    if (!account?.address) {
      throw new Error("Connected, but no Solana address was returned");
    }
    providerRef.current = solanaProvider;
    return account.address;
  }, []);

  const connectInjected = useCallback(async (type) => {
    const provider =
      type === "phantom" ? window.phantom?.solana :
      type === "solflare" ? window.solflare :
      type === "backpack" ? window.backpack?.solana :
      null;

    if (!provider || !detectSolanaWallet(type)) {
      const label = type === "phantom" ? "Phantom" : type === "solflare" ? "Solflare" : "Backpack";
      throw new Error(`${label} wasn't detected. Install the ${label} extension and try again.`);
    }

    const resp = await provider.connect();
    const addr = resp?.publicKey?.toString() || provider.publicKey?.toString();
    if (!addr) {
      throw new Error("Connected, but no Solana address was returned");
    }
    providerRef.current = provider;
    return addr;
  }, []);

  const connect = useCallback(async (type = "okx") => {
    setConnecting(true);
    setError(null);
    try {
      const addr = type === "okx" ? await connectOkx() : await connectInjected(type);
      setAddress(addr);
      setWalletType(type);
      return addr;
    } catch (err) {
      const message = err?.message || String(err);
      setError(message);
      throw err;
    } finally {
      setConnecting(false);
    }
  }, [connectOkx, connectInjected]);

  const disconnect = useCallback(async () => {
    try {
      if (walletType === "okx") {
        await universalProviderRef.current?.disconnect();
      } else {
        await providerRef.current?.disconnect?.();
      }
    } catch {
      // Real disconnect failures aren't critical — clear local state
      // regardless, same reasoning as the standalone test page.
    }
    setAddress(null);
    setWalletType(null);
    universalProviderRef.current = null;
    providerRef.current = null;
  }, [walletType]);

  return (
    <SolanaWalletContext.Provider value={{ address, walletType, connecting, error, connect, disconnect, solanaProvider: providerRef }}>
      {children}
    </SolanaWalletContext.Provider>
  );
}

export function useSolanaWallet() {
  const ctx = useContext(SolanaWalletContext);
  if (!ctx) throw new Error("useSolanaWallet must be used within SolanaWalletProvider");
  return ctx;
}

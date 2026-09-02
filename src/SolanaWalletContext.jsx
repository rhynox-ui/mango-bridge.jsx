// src/SolanaWalletContext.jsx
//
// Real, shared Solana connection state. OKX Connect remains the dedicated
// signing path for Solana-sourced transfers, while Reown AppKit supplies
// the address/provider for Solana wallets connected through its adapter.
// The context exposes the ACTIVE Solana address so consumers that only need
// a recipient do not accidentally fall back to an EVM address.
//
// OKX stays on its own path rather than being folded into AppKit's Solana
// adapter because the actual Solana-sourced execution path has only been
// exercised against OKX's provider shape. AppKit Solana is still supported
// for destination-side wallet state and for the provider passed through
// App.jsx's existing effectiveSolanaWallet adapter.
//
// GENUINE, NAMED GAP: signing and submitting a real Solana transaction
// (what's actually needed to bridge FROM Solana, not just receive INTO
// it) is not implemented here yet. solanaProvider exposes OKX's real
// signTransaction method once connected — that's the right foundation,
// but building and sending an actual Solana transaction is a separate,
// substantial piece of work, deliberately not rushed into this same
// change.

import React, { createContext, useContext, useState, useRef, useCallback } from "react";
import { OKXUniversalProvider } from "@okxconnect/universal-provider";
import { OKXSolanaProvider } from "@okxconnect/solana-provider";
import { useAppKitAccount, useDisconnect as useAppKitDisconnect } from "@reown/appkit/react";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const SolanaWalletContext = createContext(null);

export function SolanaWalletProvider({ children }) {
  const [address, setAddress] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const universalProviderRef = useRef(null);
  const solanaProviderRef = useRef(null);
  const { address: appKitAddress } = useAppKitAccount({ namespace: "solana" });
  const { disconnect: disconnectAppKit } = useAppKitDisconnect();

  // One active Solana address for consumers that need an address only.
  // OKX wins when it is connected; otherwise AppKit's Solana account is
  // the active address. This mirrors App.jsx's existing activeSolanaAddress
  // selection without changing the underlying provider ownership.
  const activeAddress = address || appKitAddress || null;

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const universalProvider = await OKXUniversalProvider.init({
        dappMetaData: {
          name: "Mango Protocol",
          icon: "https://mangoprotocol.site/logo.png",
        },
      });
      universalProviderRef.current = universalProvider;

      // Real bug fix, live-reported ("This account is already linked,
      // change your account in Mango Wallet"): OKXUniversalProvider's
      // own init() unconditionally tries to silently restore a cached
      // session from storage before this function ever gets a chance
      // to run (confirmed directly from the installed
      // @okxconnect/universal-provider package's own source —
      // initialize() always calls tryToReconnect() -> checkStorage(),
      // which reads a persisted "connectSession" and attempts
      // restoreconnect() on it). When that stored session is stale or
      // mismatched, the restore fails — and the SDK's OWN failure
      // handler calls cleanup(false), which explicitly does NOT clear
      // the broken session from storage (cleanSession is hardcoded
      // false there, with a leftover commented-out line showing that
      // was apparently supposed to be conditional). The result: the
      // exact same broken session gets retried and fails again on
      // every future connect attempt, indefinitely, until storage is
      // cleared by hand — which is what "already linked" kept
      // reappearing on repeat taps actually was.
      //
      // Fix: explicitly finish the cleanup the SDK's own failure path
      // left half-done, on every connect (not just after a detected
      // failure — connect() only ever runs from an explicit user tap
      // here, never automatically, so there's no silent session to
      // preserve; same "only ever connect from an explicit click, no
      // silent reuse" fix already shipped for the separate AppKit
      // wallet-connect path in appkit.js). cleanup isn't part of this
      // SDK's documented public API surface, but is a real, callable
      // method on the instance init() returns — guarded with a
      // property check and swallowed failure since it's best-effort
      // hardening on top of the real connect() call below, never a
      // reason to block it.
      if (typeof universalProvider.cleanup === "function") {
        await universalProvider.cleanup(true).catch(() => {});
      }

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
      if (address) {
        await universalProviderRef.current?.disconnect();
      } else if (appKitAddress) {
        await disconnectAppKit({ namespace: "solana" });
      }
    } catch {
      // Real disconnect failures aren't critical — clear local state
      // regardless, same reasoning as the standalone test page.
    }
    setAddress(null);
    universalProviderRef.current = null;
    solanaProviderRef.current = null;
  }, [address, appKitAddress, disconnectAppKit]);

  return (
    <SolanaWalletContext.Provider value={{ address: activeAddress, connecting, error, connect, disconnect, solanaProvider: solanaProviderRef }}>
      {children}
    </SolanaWalletContext.Provider>
  );
}

export function useSolanaWallet() {
  const ctx = useContext(SolanaWalletContext);
  if (!ctx) throw new Error("useSolanaWallet must be used within SolanaWalletProvider");
  return ctx;
}

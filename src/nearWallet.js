// src/nearWallet.js
//
// The user's NEAR wallet, through HOT Labs' near-connect (HOT, Meteor,
// Intear, Ledger, MyNearWallet, OKX, NEAR Mobile, Nightly…). Shared by
// the Bridge tab's "Receive on NEAR" panel (reads the account only) and
// the Swap tab's NEAR panel (also signs swaps). near-connect is loaded
// only when one of those panels is opened; each wallet's own code runs
// in near-connect's sandboxed iframe.

import { useEffect, useState } from "react";

const NEAR_WALLET_FLAG = "mango:near-wallet-connected";
const ACCOUNT_ID = /^([0-9a-f]{64}|0x[0-9a-f]{40}|(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+)$/;

let connectorPromise = null;
export function getNearConnector() {
  if (!connectorPromise) {
    connectorPromise = import("@hot-labs/near-connect")
      .then(({ NearConnector }) => new NearConnector({ network: "mainnet" }))
      .catch((err) => {
        connectorPromise = null;
        throw err;
      });
  }
  return connectorPromise;
}

async function firstAccountId(wallet) {
  const accounts = await wallet.getAccounts({ network: "mainnet" });
  const id = accounts?.[0]?.accountId;
  return typeof id === "string" && id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id) ? id : null;
}

function readFlag() {
  try {
    return localStorage.getItem(NEAR_WALLET_FLAG) === "1";
  } catch {
    return false;
  }
}
function writeFlag(on) {
  try {
    if (on) localStorage.setItem(NEAR_WALLET_FLAG, "1");
    else localStorage.removeItem(NEAR_WALLET_FLAG);
  } catch {
    // per-browser convenience only
  }
}

/**
 * { account: {accountId, name} | null, status, error, connect, disconnect,
 *   signAndSendTransactions(transactions) }
 */
export function useNearWallet() {
  const [account, setAccount] = useState(null);
  const [state, setState] = useState({ status: "idle" });

  useEffect(() => {
    if (!readFlag()) return;
    let cancelled = false;
    getNearConnector()
      .then(async (connector) => {
        connector.on("wallet:signOut", () => {
          setAccount(null);
          writeFlag(false);
        });
        const { wallet } = await connector.getConnectedWallet();
        const accountId = await firstAccountId(wallet);
        if (!cancelled && accountId) setAccount({ accountId, name: wallet.manifest?.name });
      })
      .catch(() => writeFlag(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function connect() {
    setState({ status: "connecting" });
    try {
      const connector = await getNearConnector();
      const wallet = await connector.connect();
      const accountId = await firstAccountId(wallet);
      if (!accountId) throw new Error("That wallet didn't share a NEAR account.");
      setAccount({ accountId, name: wallet.manifest?.name });
      writeFlag(true);
      setState({ status: "idle" });
    } catch (e) {
      const msg = e?.message || "";
      // Closing the picker is not an error worth showing.
      setState(/reject|cancel|clos/i.test(msg) ? { status: "idle" } : { status: "error", error: msg || "Couldn't connect a NEAR wallet." });
    }
  }

  async function disconnect() {
    setAccount(null);
    writeFlag(false);
    try {
      const connector = await getNearConnector();
      await connector.disconnect();
    } catch {
      // already disconnected
    }
  }

  async function signAndSendTransactions(transactions) {
    const connector = await getNearConnector();
    const wallet = await connector.wallet();
    return wallet.signAndSendTransactions({ network: "mainnet", signerId: account?.accountId, transactions });
  }

  return { account, status: state.status, error: state.error, connect, disconnect, signAndSendTransactions };
}

// src/nearWallet.js
//
// The user's NEAR wallet, through HOT Labs' near-connect (HOT, Meteor,
// Intear, Ledger, MyNearWallet, OKX, NEAR Mobile, Nightly…). One shared
// connection for the whole site: the header's Connect Wallet window lists
// the NEAR wallets next to EVM and Solana, and the Bridge "Receive on
// NEAR" / "Send from NEAR" panels and the Swap tab's NEAR panel all read
// the same account. near-connect is loaded only when NEAR is actually
// used; each wallet's own code runs in near-connect's sandboxed iframe.

import { useEffect, useSyncExternalStore } from "react";

const NEAR_WALLET_FLAG = "mango:near-wallet-connected";
const ACCOUNT_ID = /^([0-9a-f]{64}|0x[0-9a-f]{40}|(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+)$/;
// Listed by near-connect but not something a person signs in a browser with.
const HIDDEN_WALLETS = new Set(["near-cli"]);

let connectorPromise = null;
export function getNearConnector() {
  if (!connectorPromise) {
    connectorPromise = import("@hot-labs/near-connect")
      .then(({ NearConnector }) => {
        const connector = new NearConnector({ network: "mainnet" });
        connector.on("wallet:signOut", () => {
          writeFlag(false);
          setState({ account: null });
        });
        return connector;
      })
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

// ---------------------------------------------------------------------
// Shared state

let state = { account: null, status: "idle", error: null };
const listeners = new Set();
function setState(patch) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const getSnapshot = () => state;

let restoreStarted = false;
function restoreOnce() {
  if (restoreStarted || !readFlag()) return;
  restoreStarted = true;
  getNearConnector()
    .then(async (connector) => {
      const { wallet } = await connector.getConnectedWallet();
      const accountId = await firstAccountId(wallet);
      if (accountId && !state.account) setState({ account: { accountId, name: wallet.manifest?.name, icon: wallet.manifest?.icon } });
    })
    .catch(() => writeFlag(false));
}

/** NEAR wallets to offer, as { id, name, icon }. Loads near-connect. */
export async function listNearWallets() {
  const connector = await getNearConnector();
  await connector.whenManifestLoaded.catch(() => {});
  return connector.availableWallets
    .map((w) => w.manifest)
    .filter((m) => m && !HIDDEN_WALLETS.has(m.id) && m.features?.signAndSendTransactions !== false && m.features?.mainnet !== false)
    .map((m) => ({ id: m.id, name: m.name, icon: m.icon }));
}

/** Connects a specific wallet (or opens near-connect's own picker when no id). Resolves to the account or null. */
export async function connectNearWallet(walletId) {
  setState({ status: "connecting", error: null });
  try {
    const connector = await getNearConnector();
    const wallet = await connector.connect(typeof walletId === "string" ? { walletId } : undefined);
    const accountId = await firstAccountId(wallet);
    if (!accountId) throw new Error("That wallet didn't share a NEAR account.");
    const account = { accountId, name: wallet.manifest?.name, icon: wallet.manifest?.icon };
    writeFlag(true);
    setState({ account, status: "idle" });
    return account;
  } catch (e) {
    const msg = e?.message || "";
    // Closing the wallet's window is not an error worth showing.
    setState(/reject|cancel|clos/i.test(msg) ? { status: "idle" } : { status: "error", error: msg || "Couldn't connect a NEAR wallet." });
    return null;
  }
}

export async function disconnectNearWallet() {
  setState({ account: null, status: "idle", error: null });
  writeFlag(false);
  try {
    const connector = await getNearConnector();
    await connector.disconnect();
  } catch {
    // already disconnected
  }
}

async function signAndSendNearTransactions(transactions) {
  const connector = await getNearConnector();
  const wallet = await connector.wallet();
  return wallet.signAndSendTransactions({ network: "mainnet", signerId: state.account?.accountId, transactions });
}

/**
 * { account: {accountId, name, icon} | null, status, error, connect,
 *   disconnect, signAndSendTransactions(transactions) } — the same
 * account everywhere on the page.
 */
export function useNearWallet() {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    restoreOnce();
  }, []);
  return { account: s.account, status: s.status, error: s.error, connect: connectNearWallet, disconnect: disconnectNearWallet, signAndSendTransactions: signAndSendNearTransactions };
}

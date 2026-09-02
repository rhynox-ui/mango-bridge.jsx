// src/solanaWalletStandard.js
//
// Shared fallback signer, extracted from relaySdkSolanaExecution.js's
// own fix (see that file's own header for the full live-reported bug
// this closes): solanaWallet.solanaProvider (App.jsx's
// effectiveSolanaWallet) falls back to AppKit's own
// useAppKitProvider("solana") whenever OKX isn't the one connected —
// but that hook reads a Valtio snapshot that can stay null even after
// AppKit's own connect flow already reported a real, connected
// address. Confirmed live against the site's own Mango Wallet
// extension, a real, spec-correct Wallet Standard implementation, not
// a third-party unknown.
//
// Rather than accept that as a permanent "only OKX works" limitation
// in every Solana-signing call site, this bypasses AppKit's own
// provider snapshot entirely and talks to the Wallet Standard directly
// — the same open, published spec both AppKit's WalletStandardProvider
// (confirmed by reading its installed source:
// @reown/appkit-adapter-solana/dist/esm/src/providers/
// WalletStandardProvider.js) and this app's own extension
// (extension/src/inpage.js) already correctly implement independently
// of each other. getWallets().get() (@wallet-standard/app, the same
// package AppKit's own watchStandard.js already uses internally) lists
// every currently-registered standard wallet regardless of whatever
// AppKit's internal state happens to think is active right now;
// matching by the real, already-known connected address finds the
// right one directly, with no dependency on AppKit's own reactive
// timing.
//
// Used by relaySdkSolanaExecution.js (the main Relay-sourced-from-
// Solana execution path) and pumpfun.js/pumpswap.js (the direct-route
// short-circuits App.jsx tries first for a same-chain native-SOL
// trade) — all three read solanaWallet.solanaProvider.current the same
// way and hit the exact same gap for a non-OKX Wallet Standard wallet.
export async function resolveWalletStandardSigner(address) {
  if (!address) return null;
  let getWallets;
  try {
    ({ getWallets } = await import("@wallet-standard/app"));
  } catch {
    return null;
  }
  const wallets = getWallets().get();
  const wallet = wallets.find(
    (w) => w.features?.["solana:signTransaction"] && w.accounts?.some((acc) => acc.address === address),
  );
  if (!wallet) return null;
  const account = wallet.accounts.find((acc) => acc.address === address);
  const feature = wallet.features["solana:signTransaction"];
  return {
    async signTransaction(transaction) {
      // Same serialize-unsigned -> Uint8Array -> feature call ->
      // reconstruct shape WalletStandardProvider.signTransaction
      // already uses (its own installed source, read directly) — kept
      // identical so every caller's own signed.serialize() call right
      // after this resolves works unchanged either way.
      const serialized = transaction.serialize({ verifySignatures: false });
      const [result] = await feature.signTransaction({ account, transaction: new Uint8Array(serialized) });
      if (!result?.signedTransaction) {
        throw new Error("The connected wallet returned no signed transaction.");
      }
      const { Transaction, VersionedTransaction } = await import("@solana/web3.js");
      // Same version-detection convention @solana/wallet-adapter-base's
      // own isVersionedTransaction uses ('version' in transaction) —
      // confirmed directly from that installed package's source, not
      // guessed, since WalletStandardProvider.js imports it from there.
      return "version" in transaction
        ? VersionedTransaction.deserialize(result.signedTransaction)
        : Transaction.from(result.signedTransaction);
    },
  };
}

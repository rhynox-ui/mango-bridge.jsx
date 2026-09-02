import {useEffect} from "react";
import {useAppKitAccount, useAppKitProvider} from "@reown/appkit/react";
import {useConnect, useConfig} from "wagmi";

// AppKit owns the connection modal/session. Wagmi owns the account state
// consumed throughout App.jsx. With automatic reconnect disabled, an
// explicit AppKit connection must still be reflected into wagmi immediately
// without calling connect() (which could open another approval prompt).
export function WalletConnectionSync() {
  const config = useConfig();
  const {connectors} = useConnect();
  const {address, isConnected} = useAppKitAccount({namespace: "eip155"});
  const {walletProvider} = useAppKitProvider("eip155");
  const normalizedAddress = address?.toLowerCase();

  useEffect(() => {
    let cancelled = false;
    let retryTimer;
    let attempts = 0;
    const maxAttempts = 12;

    async function sync() {
      if (cancelled) return;

      // AppKit is disconnected: clear only wagmi's EVM state. Solana uses a
      // separate provider and is deliberately untouched here.
      if (!isConnected || !normalizedAddress) {
        if (config.state.status !== "disconnected" || config.state.connections.size > 0) {
          config.setState((state) => ({
            ...state,
            connections: new Map(),
            current: null,
            status: "disconnected",
          }));
        }
        return;
      }

      // AppKit's EIP-1193 provider is the authoritative provider for the
      // connection that was just approved. Read it first so we do not depend
      // on a wagmi connector having already appeared in React's connector
      // list. Mango Wallet is an EIP-6963 provider, and AppKit can finish its
      // connection before wagmi receives the late connector registration.
      let providerAccounts = [];
      let chainId;
      try {
        if (walletProvider?.request) {
          const rawAccounts = await walletProvider.request({method: "eth_accounts"});
          providerAccounts = Array.isArray(rawAccounts) ? rawAccounts : [];
          const rawChainId = await walletProvider.request({method: "eth_chainId"});
          chainId = Number(rawChainId);
        }
      } catch {
        // The provider may not be ready on the first render after approval.
      }

      if (!providerAccounts.some((account) => String(account).toLowerCase() === normalizedAddress)) {
        scheduleRetry();
        return;
      }
      if (!Number.isInteger(chainId) || chainId <= 0) {
        scheduleRetry();
        return;
      }

      // Find the wagmi connector that owns the exact AppKit provider. If
      // connector registration is still in flight, retry briefly rather than
      // calling connect() or reopening the wallet approval flow.
      for (const connector of connectors) {
        if (cancelled) return;
        try {
          const provider = await connector.getProvider();
          if (!provider?.request) continue;

          const sameProvider = walletProvider && provider === walletProvider;
          let accounts = providerAccounts;
          if (!sameProvider) {
            const rawAccounts = await provider.request({method: "eth_accounts"});
            accounts = Array.isArray(rawAccounts) ? rawAccounts : [];
          }
          if (!accounts.some((account) => String(account).toLowerCase() === normalizedAddress)) continue;

          const currentConnection = config.state.connections.get(connector.uid);
          if (
            config.state.status === "connected" &&
            config.state.current === connector.uid &&
            currentConnection?.chainId === chainId &&
            currentConnection?.accounts?.some((account) => String(account).toLowerCase() === normalizedAddress)
          ) return;

          config.setState((state) => ({
            ...state,
            connections: new Map(state.connections).set(connector.uid, {
              accounts,
              chainId,
              connector,
            }),
            current: connector.uid,
            status: "connected",
            chainId,
          }));
          return;
        } catch {
          // Read-only provider discovery can fail for an unavailable connector.
          // Skip it; never call connect() and never trigger another approval.
        }
      }

      scheduleRetry();
    }

    function scheduleRetry() {
      if (cancelled || attempts >= maxAttempts) return;
      attempts += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void sync();
      }, 250);
    }

    void sync();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [config, connectors, normalizedAddress, isConnected, walletProvider]);

  return null;
}

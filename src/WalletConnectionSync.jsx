import {useEffect} from "react";
import {useAppKitAccount} from "@reown/appkit/react";
import {useConnect, useConfig} from "wagmi";

// AppKit owns the connection modal/session. Wagmi owns the account state
// consumed throughout App.jsx. With automatic reconnect disabled, an
// explicit AppKit connection must still be reflected into wagmi immediately
// without calling connect() (which could open another approval prompt).
export function WalletConnectionSync() {
  const config = useConfig();
  const {connectors} = useConnect();
  const {address, isConnected} = useAppKitAccount({namespace: "eip155"});
  const normalizedAddress = address?.toLowerCase();

  useEffect(() => {
    let cancelled = false;

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

      // Do not use AppKit's multi-wallet connection registry here. That API is
      // intended for the optional multi-wallet feature. The account hook is
      // sufficient to tell us which address AppKit has actually connected.
      //
      // Resolve the wagmi connector from its live EIP-1193 provider instead of
      // connector.getAccounts(). Some EIP-6963/mobile connectors only expose
      // their account through the provider until wagmi has a connection; that
      // was the circular dependency that left the UI stuck on Connect.
      for (const connector of connectors) {
        if (cancelled) return;
        try {
          const provider = await connector.getProvider();
          if (!provider?.request) continue;

          const providerAccounts = await provider.request({method: "eth_accounts"});
          const accounts = Array.isArray(providerAccounts) ? providerAccounts : [];
          if (!accounts.some((account) => account.toLowerCase() === normalizedAddress)) continue;

          const rawChainId = await provider.request({method: "eth_chainId"});
          const chainId = typeof rawChainId === "string" ? Number(rawChainId) : Number(rawChainId);
          if (!Number.isInteger(chainId) || chainId <= 0) continue;
          if (cancelled) return;

          const currentConnection = config.state.connections.get(connector.uid);
          if (
            config.state.status === "connected" &&
            config.state.current === connector.uid &&
            currentConnection?.chainId === chainId &&
            currentConnection?.accounts?.some((account) => account.toLowerCase() === normalizedAddress)
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
    }

    void sync();
    return () => {
      cancelled = true;
    };
  }, [config, connectors, normalizedAddress, isConnected]);

  return null;
}

import {useEffect} from "react";
import {useAppKitAccount} from "@reown/appkit/react";
import {useConfig} from "wagmi";

// AppKit owns the connection modal/session. Wagmi owns the account state
// consumed throughout App.jsx. With automatic reconnect disabled, an
// explicit AppKit connection must still be reflected into wagmi immediately
// without calling connect() (which could open another approval prompt).
export function WalletConnectionSync() {
  const config = useConfig();
  const {address, isConnected} = useAppKitAccount({namespace: "eip155"});

  useEffect(() => {
    let cancelled = false;

    async function sync() {
      if (cancelled) return;

      // AppKit is disconnected: clear only wagmi's EVM state. This keeps the
      // UI honest after an explicit disconnect and never opens a connection.
      if (!isConnected || !address) {
        if (config.state.status !== "disconnected" || config.state.connections.size > 0) {
          config.setState(state => ({
            ...state,
            connections: new Map(),
            current: null,
            status: "disconnected",
          }));
        }
        return;
      }

      // Already synchronized to this exact AppKit address.
      if (config.state.status === "connected" && config.state.current) {
        const current = config.state.connections.get(config.state.current);
        if (current?.accounts?.some(account => account.toLowerCase() === address.toLowerCase())) return;
      }

      // Never call wagmi's connect() here. eth_accounts/eth_chainId are
      // read-only and cannot create a new wallet approval flow.
      for (const connector of config.connectors) {
        if (cancelled) return;
        try {
          const accounts = await connector.getAccounts();
          const connectedAddress = accounts?.find(account => account.toLowerCase() === address.toLowerCase());
          if (!connectedAddress) continue;

          const chainId = await connector.getChainId();
          if (cancelled) return;

          config.setState(state => ({
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
          // A connector that cannot expose its already-authorized account is
          // skipped. Do not call connect() and risk another approval prompt.
        }
      }
    }

    void sync();
    return () => {
      cancelled = true;
    };
  }, [config, address, isConnected]);

  return null;
}

import {useEffect} from "react";
import {useAppKitAccount, useAppKitConnections, useAppKitState} from "@reown/appkit/react";
import {useConfig} from "wagmi";

// AppKit owns the connection modal/session. Wagmi owns the account state
// consumed throughout App.jsx. With automatic reconnect disabled, an
// explicit AppKit connection must still be reflected into wagmi immediately
// without calling connect() (which could open another approval prompt).
export function WalletConnectionSync() {
  const config = useConfig();
  const {address, isConnected, allAccounts} = useAppKitAccount({namespace: "eip155"});
  const {connections} = useAppKitConnections("eip155");
  const {open} = useAppKitState();

  const normalizedAddress = address?.toLowerCase();
  const appKitConnection = normalizedAddress
    ? connections.find((connection) =>
        connection.accounts.some((account) => account.address.toLowerCase() === normalizedAddress)
      )
    : undefined;
  const appKitConnectorId = appKitConnection?.connectorId;
  const appKitAccount = normalizedAddress
    ? allAccounts.find((account) => account.address.toLowerCase() === normalizedAddress)
    : undefined;
  const appKitChainId = appKitAccount?.chainId;

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

      // AppKit has not finished publishing its connection record yet. The
      // account/connection hooks will re-run this effect when it appears.
      if (!appKitConnection || !appKitConnectorId) return;

      const connector = config.connectors.find((candidate) => candidate.id === appKitConnectorId);
      if (!connector) return;

      // The AppKit connection record is authoritative for the already-approved
      // account. Do NOT call connector.getAccounts() here: some EIP-6963/mobile
      // connectors only expose their account after wagmi has been connected,
      // which creates the exact circular dependency that caused this bug.
      const accounts = appKitConnection.accounts.map((account) => account.address);
      if (!accounts.length || !accounts.some((account) => account.toLowerCase() === normalizedAddress)) return;

      let chainId = typeof appKitChainId === "number" ? appKitChainId : Number(String(appKitChainId || "").split(":").pop());
      if (!Number.isInteger(chainId) || chainId <= 0) {
        try {
          chainId = await connector.getChainId();
        } catch {
          return;
        }
      }
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
    }

    void sync();
    return () => {
      cancelled = true;
    };
  }, [config, normalizedAddress, isConnected, appKitConnection, appKitConnectorId, appKitChainId, open]);

  return null;
}

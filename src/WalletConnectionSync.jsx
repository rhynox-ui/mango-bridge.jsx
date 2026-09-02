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
      if (cancelled || !isConnected || !address) return;
      if (config.state.status === "connected" && config.state.current) return;

      // Never call wagmi's connect() here. That is exactly the operation that
      // can create another wallet approval and was responsible for the loop
      // this component is designed to prevent. eth_accounts/eth_chainId are
      // read-only and therefore safe after AppKit reports a successful
      // explicit connection.
      const connector = config.connectors.find(candidate => {
        try {
          return candidate.isAuthorized ? true : candidate.id !== "";
        } catch {
          return false;
        }
      });
      if (!connector) return;

      try {
        const accounts = await connector.getAccounts();
        if (cancelled || !accounts?.length) return;
        const chainId = await connector.getChainId();
        if (cancelled) return;

        config.setState(state => ({
          ...state,
          connections: new Map(state.connections).set(connector.uid, {
            accounts: accounts,
            chainId,
            connector,
          }),
          current: connector.uid,
          status: "connected",
          chainId,
        }));
      } catch {
        // AppKit remains the source of truth. If the connector cannot expose
        // its already-authorized account without prompting, leave wagmi
        // untouched rather than risking another wallet approval.
      }
    }

    void sync();
    return () => {
      cancelled = true;
    };
  }, [config, address, isConnected]);

  return null;
}

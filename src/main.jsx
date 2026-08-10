import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.jsx";
import SolanaConnectTest from "./SolanaConnect.jsx";
import { SolanaWalletProvider } from "./SolanaWalletContext.jsx";
import { config } from "./wagmi.js";
import "./index.css";

const queryClient = new QueryClient();

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    // In production, wire this up to a real error-tracking service (Sentry, etc.)
    console.error("Mango Bridge crashed:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "12px",
            background: "#0A0C10",
            color: "#D7DBE2",
            fontFamily: "Inter, sans-serif",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: "18px", fontWeight: 600, color: "#F2F4F7" }}>
            Something went wrong
          </div>
          <div style={{ fontSize: "14px", color: "#8B95A1", maxWidth: "360px" }}>
            The app hit an unexpected error. No funds or wallet actions were affected.
            Try reloading the page.
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: "8px",
              padding: "10px 20px",
              borderRadius: "10px",
              background: "#D6FA3C",
              color: "#10130A",
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Genuinely isolated test route — visiting ?test=solana loads ONLY the
// standalone connection test, completely separate from the main app.
// Nothing here touches App.jsx or the existing, working bridge UI.
const isTestRoute = new URLSearchParams(window.location.search).get("test") === "solana";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <SolanaWalletProvider>
            {isTestRoute ? <SolanaConnectTest /> : <App />}
          </SolanaWalletProvider>
        </ErrorBoundary>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);

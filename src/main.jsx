import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, info) {
    console.error("Mango Bridge crashed:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "12px", background: "#0A0C10", color: "#D7DBE2", fontFamily: "Inter, sans-serif", padding: "24px", textAlign: "center" }}>
          <div style={{ fontSize: "18px", fontWeight: 600, color: "#F2F4F7" }}>Something went wrong</div>
          <div style={{ fontSize: "14px", color: "#8B95A1", maxWidth: "360px" }}>
            The app hit an unexpected error. No funds or wallet actions were affected. Try reloading the page.
          </div>
          <button onClick={() => window.location.reload()} style={{ marginTop: "8px", padding: "10px 20px", borderRadius: "10px", background: "#D6FA3C", color: "#10130A", fontWeight: 600, border: "none", cursor: "pointer" }}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

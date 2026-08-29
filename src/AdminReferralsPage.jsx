// src/AdminReferralsPage.jsx
//
// Operator dashboard for api/v1/referral/admin-export.js — the same
// data that endpoint already serves as raw JSON/CSV, now with a real
// table view and a one-click CSV download, so checking or exporting
// the referral points ledger for a reward run doesn't need curl or a
// terminal at all. Reachable at
// https://www.mangoprotocol.site/?admin-referrals=1 (see App.jsx's own
// ?docs=1 deep-link for the identical pattern) — deliberately not
// linked from anywhere in the app's own nav. The real gate is the
// ADMIN_API_SECRET this page asks for (same secret admin-export.js's
// own header documents setting up in Vercel), not the URL's obscurity
// — this page is exactly as safe to stumble onto as the raw endpoint
// already was.
//
// The secret is kept in sessionStorage only (cleared when the tab
// closes, never written to localStorage or a cookie) — enough to
// survive a page refresh without re-typing it, short of a real
// "remember forever" credential store this app has no use for
// anywhere else.
//
// Always fetches from https://www.mangoprotocol.site/... explicitly,
// never the bare apex — see admin-export.js's own header for the real
// live bug this avoided: the apex redirects to www, and curl -L (a
// real client this exact endpoint was debugged against) strips
// Authorization across that hop. The browser's own fetch() wouldn't
// exhibit that specific curl behavior on same-origin calls anyway, but
// pinning the host here keeps this file correct regardless of which
// one it happens to be loaded from, and matches the one proven-working
// URL rather than leaving that to chance again.

import React, { useEffect, useMemo, useState } from "react";
import { PALETTE, LIME, LIME_DEEP, fmt } from "./theme.js";

const SECRET_STORAGE_KEY = "mango_admin_secret";
const API_URL = "https://www.mangoprotocol.site/api/v1/referral/admin-export";

function csvFor(records) {
  const header = "address,points,referralCount,referredBy,createdAt\n";
  const rows = records
    .map((r) => [r.address, r.points, r.referralCount, r.referredBy ?? "", r.createdAt ?? ""].join(","))
    .join("\n");
  return header + rows + (records.length > 0 ? "\n" : "");
}

function downloadCsv(records) {
  const blob = new Blob([csvFor(records)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mango-referrals-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const COLUMNS = [
  { key: "address", label: "Address", sortable: false },
  { key: "points", label: "Points", sortable: true },
  { key: "referralCount", label: "Referrals", sortable: true },
  { key: "referredBy", label: "Referred by", sortable: false },
  { key: "createdAt", label: "Joined", sortable: true },
];

export function AdminReferralsPage({ onClose }) {
  // Light, matching the rest of the site's own default — MangoBridge's
  // own theme state (App.jsx) starts as useState("light") with no
  // persisted preference, so light is the real default a visitor
  // actually sees, not an assumption.
  const P = PALETTE.light;
  const [secret, setSecret] = useState(() => {
    try {
      return sessionStorage.getItem(SECRET_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  });
  const [secretInput, setSecretInput] = useState("");
  const [records, setRecords] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sortKey, setSortKey] = useState("points");

  async function load(useSecret) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(API_URL, { headers: { Authorization: `Bearer ${useSecret}` } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || `Request failed: ${res.status}`);
      }
      setRecords(json.data.records);
      try {
        sessionStorage.setItem(SECRET_STORAGE_KEY, useSecret);
      } catch {
        // sessionStorage unavailable — the secret just won't survive a
        // refresh, nothing else breaks.
      }
      setSecret(useSecret);
    } catch (err) {
      setError(err?.message || "Could not load referral data.");
      setRecords(null);
    } finally {
      setLoading(false);
    }
  }

  // Auto-loads once on mount if a secret already survived from a prior
  // visit this tab — never fires again on a later re-render, so typing
  // a wrong guess into the login form can't accidentally trigger a
  // second, unrelated fetch.
  useEffect(() => {
    if (secret) load(secret);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(e) {
    e.preventDefault();
    if (!secretInput.trim() || loading) return;
    load(secretInput.trim());
  }

  function handleLogout() {
    try {
      sessionStorage.removeItem(SECRET_STORAGE_KEY);
    } catch {
      // best-effort
    }
    setSecret("");
    setRecords(null);
    setSecretInput("");
    setError("");
  }

  const sorted = useMemo(() => {
    if (!records) return [];
    const copy = [...records];
    copy.sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));
    return copy;
  }, [records, sortKey]);

  const totalPoints = useMemo(() => (records || []).reduce((sum, r) => sum + (Number(r.points) || 0), 0), [records]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: P.bg }}>
      <div className="flex items-center justify-between px-5 py-4 shrink-0" style={{ borderBottom: `1px solid ${P.panelBorder}` }}>
        <span className="font-display text-[16px] font-semibold" style={{ color: P.textPrimary }}>
          Referral admin
        </span>
        <div className="flex items-center gap-4">
          {!!secret && (
            <button onClick={handleLogout} className="text-[12px] font-medium" style={{ color: P.textMuted }}>
              Log out
            </button>
          )}
          {!!onClose && (
            <button onClick={onClose} className="text-[16px]" style={{ color: P.textMuted }}>
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-8">
        {!secret ? (
          <form onSubmit={handleSubmit} className="max-w-sm mx-auto flex flex-col gap-3 mt-16">
            <span className="text-[13px]" style={{ color: P.textMuted }}>
              Enter the admin secret to view referral data.
            </span>
            <input
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder="ADMIN_API_SECRET"
              autoCapitalize="none"
              autoCorrect="off"
              autoFocus
              className="w-full px-3.5 py-3 rounded-xl text-[13px] font-mono"
              style={{ background: P.input, border: `1px solid ${P.panelBorder}`, color: P.textPrimary }}
            />
            {!!error && (
              <span className="text-[12px]" style={{ color: "#D92D20" }}>
                {error}
              </span>
            )}
            <button
              type="submit"
              disabled={loading || !secretInput.trim()}
              className="w-full py-3 rounded-xl text-[13px] font-semibold"
              style={{ background: loading || !secretInput.trim() ? P.pillBg : LIME, color: loading || !secretInput.trim() ? P.textMuted : "#0A0A0B" }}
            >
              {loading ? "Checking…" : "View data"}
            </button>
          </form>
        ) : (
          <div className="max-w-3xl mx-auto flex flex-col gap-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-6">
                <div>
                  <div className="text-[22px] font-semibold" style={{ color: P.textPrimary }}>
                    {records ? records.length : "—"}
                  </div>
                  <div className="text-[11px]" style={{ color: P.textMuted }}>
                    wallets
                  </div>
                </div>
                <div>
                  <div className="text-[22px] font-semibold" style={{ color: P.textPrimary }}>
                    {fmt(totalPoints, 0)}
                  </div>
                  <div className="text-[11px]" style={{ color: P.textMuted }}>
                    total points
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => load(secret)}
                  disabled={loading}
                  className="px-3.5 py-2 rounded-lg text-[12.5px] font-semibold"
                  style={{ background: P.pillBg, color: P.textPrimary }}
                >
                  {loading ? "Refreshing…" : "Refresh"}
                </button>
                <button
                  onClick={() => records && downloadCsv(records)}
                  disabled={!records || records.length === 0}
                  className="px-3.5 py-2 rounded-lg text-[12.5px] font-semibold"
                  style={{ background: `${LIME}1A`, color: LIME_DEEP }}
                >
                  Download CSV
                </button>
              </div>
            </div>

            {!!error && (
              <div className="text-[12.5px]" style={{ color: "#D92D20" }}>
                {error}
              </div>
            )}

            {records && records.length === 0 && !loading && (
              <div className="text-[13px] text-center py-10" style={{ color: P.textMuted }}>
                No referral records yet.
              </div>
            )}

            {records && records.length > 0 && (
              <div className="overflow-x-auto rounded-xl" style={{ border: `1px solid ${P.panelBorder}` }}>
                <table className="w-full text-[12.5px]" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: P.panel }}>
                      {COLUMNS.map((col) => (
                        <th
                          key={col.key}
                          onClick={() => col.sortable && setSortKey(col.key)}
                          className="text-left px-3.5 py-2.5 font-semibold whitespace-nowrap"
                          style={{ color: P.textMuted, cursor: col.sortable ? "pointer" : "default" }}
                        >
                          {col.label}
                          {sortKey === col.key ? " ↓" : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r) => (
                      <tr key={r.address} style={{ borderTop: `1px solid ${P.panelBorder}` }}>
                        <td className="px-3.5 py-2.5 font-mono whitespace-nowrap" style={{ color: P.textPrimary }}>
                          {r.address.slice(0, 8)}…{r.address.slice(-6)}
                        </td>
                        <td className="px-3.5 py-2.5 font-semibold" style={{ color: LIME_DEEP }}>
                          {fmt(r.points, 0)}
                        </td>
                        <td className="px-3.5 py-2.5" style={{ color: P.textSecondary }}>
                          {r.referralCount}
                        </td>
                        <td className="px-3.5 py-2.5 font-mono whitespace-nowrap" style={{ color: P.textMuted }}>
                          {r.referredBy ? `${r.referredBy.slice(0, 6)}…${r.referredBy.slice(-4)}` : "—"}
                        </td>
                        <td className="px-3.5 py-2.5 whitespace-nowrap" style={{ color: P.textMuted }}>
                          {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

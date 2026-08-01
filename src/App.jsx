return (
    <div className="min-h-screen w-full" style={{ background: "#0A0C10", fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .font-display { font-family: 'Space Grotesk', sans-serif; }
        .font-mono { font-family: 'IBM Plex Mono', monospace; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        input:focus { outline: none; }
      `}</style>

      <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid #15181E" }}>
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${LIME}, ${LIME_DEEP})` }}>
            <Citrus size={15} color="#10130A" />
          </div>
          <span className="font-display text-[16px] font-semibold" style={{ color: "#F2F4F7" }}>Mango Bridge</span>
        </div>
        {connected ? (
          <button onClick={() => setConnected(false)} className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-semibold" style={{ background: `${LIME}1A`, border: `1px solid ${LIME}40`, color: LIME }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: LIME }} />
            {address}
          </button>
        ) : (
          <button onClick={() => setConnected(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13.5px] font-semibold" style={{ background: LIME, color: "#10130A" }}>
            <Link2 size={14} /> Connect wallet
          </button>
        )}
      </div>

      <div className="flex justify-center px-4 py-10">
        <div className="w-full max-w-[420px]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex gap-1 p-1 rounded-xl" style={{ background: "#12151B" }}>
              {["bridge", "history"].map((t) => (
                <button key={t} onClick={() => setTab(t)} className="px-4 py-1.5 rounded-lg text-[13px] font-medium capitalize" style={{ background: tab === t ? "#20242D" : "transparent", color: tab === t ? "#F2F4F7" : "#5B6472" }}>
                  {t}
                </button>
              ))}
            </div>
            {tab === "bridge" && (
              <div className="flex items-center gap-1.5">
                <button className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                  <RefreshCw size={14} color="#5B6472" />
                </button>
                <button className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                  <Settings2 size={14} color="#5B6472" />
                </button>
              </div>
            )}
          </div>

          {tab === "history" ? (
            <HistoryTab history={history} onReset={resetHistory} />
          ) : (
            <>
              <div className="rounded-2xl p-4" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[12.5px] font-medium" style={{ color: "#8B95A1" }}>You send</span>
                  <span className="text-[11.5px]" style={{ color: "#4A515D" }}>Balance: {fmt(availableBalance, asset.decimals)} {asset.symbol}</span>
                </div>
                <div className="flex items-center justify-between mb-3">
                  <ChainDropdown value={from} exclude={to} onChange={handleFromChange} />
                </div>
                <div className="flex items-center justify-between rounded-xl px-3.5 py-3" style={{ background: "#0E1116", border: `1px solid ${insufficient ? "#7A2E2E" : "#1E232B"}` }}>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0"
                    className="font-display bg-transparent text-[24px] font-semibold w-full"
                    style={{ color: "#F2F4F7" }}
                  />
                  <button onClick={setMax} className="text-[10.5px] font-bold px-2 py-1 rounded-md mr-2 shrink-0" style={{ background: `${LIME}1A`, color: LIME }}>MAX</button>
                  <AssetDropdown assetIdx={assetIdx} setAssetIdx={setAssetIdx} chainId={from} />
                </div>
                {insufficient && <div className="text-[11.5px] mt-1.5" style={{ color: "#E5726B" }}>Insufficient balance on {CHAINS[from].name}</div>}
              </div>

              <div className="flex justify-center -my-3 relative z-10">
                <button onClick={swap} className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "#181C24", border: "1px solid #262C36" }}>
                  <ArrowUpDown size={15} color={LIME} />
                </button>
              </div>

              <div className="rounded-2xl p-4 mt-3" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[12.5px] font-medium" style={{ color: "#8B95A1" }}>You receive</span>
                  <span className="text-[11.5px]" style={{ color: "#4A515D" }}>Balance: {fmt(balances?.[to]?.[asset.symbol] ?? 0, asset.decimals)} {asset.symbol}</span>
                </div>
                <div className="flex items-center justify-between mb-3">
                  <ChainDropdown value={to} exclude={from} onChange={handleToChange} />
                </div>
                <div className="flex items-center justify-between rounded-xl px-3.5 py-3" style={{ background: "#0E1116", border: "1px solid #1E232B" }}>
                  <span className="font-display text-[24px] font-semibold" style={{ color: amtNum > 0 ? "#F2F4F7" : "#3A414C" }}>{amtNum > 0 ? fmt(received, 4) : "0"}</span>
                  <AssetDropdown assetIdx={assetIdx} setAssetIdx={setAssetIdx} chainId={to} />
                </div>
              </div>

              <button onClick={() => setDetailsOpen((o) => !o)} className="w-full flex items-center justify-between mt-3 px-4 py-2.5 rounded-xl" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                <span className="text-[12.5px] font-medium flex items-center gap-1.5" style={{ color: LIME }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: LIME }} /> Fee ${fmt(fee, 2)}
                </span>
                <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: "#8B95A1" }}>
                  ETA: {etaLabel}
                  <ChevronDown size={13} color="#5B6472" style={{ transform: detailsOpen ? "rotate(180deg)" : "none" }} />
                </span>
              </button>
              {detailsOpen && (
                <div className="mt-2 px-4 py-3 rounded-xl flex flex-col gap-2" style={{ background: "#0E1116", border: "1px solid #1E232B" }}>
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: "#5B6472" }}>Route</span><span style={{ color: "#D7DBE2" }}>{CHAINS[from].name} → {CHAINS[to].name}</span></div>
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: "#5B6472" }}>Source gas</span><span className="font-mono" style={{ color: "#D7DBE2" }}>${fmt(CHAINS[from].baseFee, 2)}</span></div>
                  <div className="flex items-center justify-between text-[12.5px]"><span style={{ color: "#5B6472" }}>Destination gas</span><span className="font-mono" style={{ color: "#D7DBE2" }}>${fmt(CHAINS[to].baseFee, 2)}</span></div>
                </div>
              )}

              <div className="mt-3 rounded-xl p-3.5" style={{ background: "#12151B", border: "1px solid #1E232B" }}>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={sendToOther} onChange={(e) => setSendToOther(e.target.checked)} className="w-4 h-4 rounded" style={{ accentColor: LIME }} />
                  <span className="text-[12.5px] font-medium" style={{ color: "#D7DBE2" }}>Send to another address</span>
                </label>
                {sendToOther && (
                  <input
                    value={destAddress}
                    onChange={(e) => setDestAddress(e.target.value)}
                    placeholder={`Enter ${CHAINS[to].name} address`}
                    className="w-full mt-2.5 px-3 py-2.5 rounded-lg text-[13px] font-mono"
                    style={{ background: "#0E1116", border: "1px solid #1E232B", color: "#F2F4F7" }}
                  />
                )}
              </div>

              <button
                disabled={!connected || !canBridge}
                onClick={() => setShowModal(true)}
                className="w-full mt-4 py-3.5 rounded-xl font-display font-semibold text-[15px]"
                style={{
                  background: !connected ? "#1E232B" : canBridge ? LIME : "#1E232B",
                  color: !connected ? "#4A515D" : canBridge ? "#10130A" : "#4A515D",
                  cursor: connected && canBridge ? "pointer" : "not-allowed",
                }}
              >
                {!connected ? "Connect wallet" : from === to ? "Choose different chains" : amtNum <= 0 ? "Enter an amount" : insufficient ? "Insufficient balance" : sendToOther && destAddress.trim().length <= 4 ? "Enter destination address" : "Bridge assets"}
              </button>

              <div className="text-center mt-4 text-[11.5px]" style={{ color: "#3A414C" }}>
                Prototype UI — wallet and balances are simulated for this session.
              </div>
            </>
          )}
        </div>
      </div>

      {showModal && (
        <BridgeModal
          from={from} to={to} amount={amount} asset={asset.symbol} fee={fee} etaLabel={etaLabel} received={received}
          destination={sendToOther ? destAddress : null}
          onClose={() => setShowModal(false)}
          onComplete={handleComplete}
        />
      )}
    </div>
  );
}
// sdk/mango-sdk.js
//
// Mango Protocol SDK — a thin, honest wrapper around the real REST API.
// Every function here just calls the live endpoints and returns their
// real response; nothing here is simulated or mocked.
//
// IMPORTANT, non-negotiable design principle: this SDK NEVER signs or
// submits transactions on your behalf. Mango Protocol is non-custodial —
// getBridgeQuote() and the launchpad read functions return real data;
// where a real transaction is involved, this SDK hands back the actual
// unsigned transaction data for YOUR OWN wallet to sign and send. If you
// see a function here that seems to promise "does the trade for you"
// without you providing a signer, that would be a bug, not a feature.

const DEFAULT_BASE_URL = "https://mangoprotocol.site/api/v1";

export class MangoSDK {
  constructor({ baseUrl = DEFAULT_BASE_URL } = {}) {
    this.baseUrl = baseUrl;
  }

  async _get(path, params = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
    const res = await fetch(url.toString());
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || `Request to ${path} failed with status ${res.status}`);
    return json;
  }

  // ── Launchpad ──────────────────────────────────────────────────────

  /** Real, live list of every launchpad token currently on the verified Hook. */
  async getLaunchpadTokens() {
    const { data } = await this._get("/launchpad/tokens");
    return data;
  }

  /** Real detail for a single token — market data, trades, and holders. */
  async getLaunchpadToken(address) {
    if (!address) throw new Error("getLaunchpadToken requires a token address.");
    const { data } = await this._get("/launchpad/token", { address });
    return data;
  }

  /**
   * Real, live trade quote for a launchpad token — reads the pool's
   * actual current price on-chain.
   *
   * @param {object} params
   * @param {string} params.tokenAddress
   * @param {"buy"|"sell"} params.side
   * @param {number} [params.slippagePercent] - default 5
   */
  async getLaunchpadQuote({ tokenAddress, side, slippagePercent }) {
    if (!tokenAddress || !side) throw new Error("getLaunchpadQuote requires: tokenAddress, side.");
    const { data } = await this._get("/launchpad/quote", { tokenAddress, side, slippagePercent });
    return data;
  }

  /**
   * Real, unsigned transaction data for launching a new token. Does NOT
   * launch anything itself — sign and send the returned {to, data,
   * value, chainId} with your own wallet on Robinhood Chain.
   *
   * @param {object} params
   * @param {string} params.name
   * @param {string} params.symbol
   * @param {string} params.creator - your wallet address
   * @param {string|number} [params.devBuyEth] - ETH to buy at launch, default 0
   */
  async getLaunchTransaction({ name, symbol, creator, devBuyEth }) {
    if (!name || !symbol || !creator) throw new Error("getLaunchTransaction requires: name, symbol, creator.");
    const { data } = await this._get("/launchpad/launch", { name, symbol, creator, devBuyEth });
    return data;
  }

  // ── Bridge ─────────────────────────────────────────────────────────

  /** Every chain and asset combination this app has a verified contract address for. */
  async getBridgeChains() {
    const { data } = await this._get("/bridge/chains");
    return data;
  }

  /**
   * Real, live bridge quote. Returns fee, ETA, and the actual unsigned
   * transaction steps — sign and submit those with your own wallet.
   * This function does NOT execute anything.
   *
   * @param {object} params
   * @param {string} params.from - source chain key (e.g. "base")
   * @param {string} params.to - destination chain key (e.g. "solana")
   * @param {string} params.fromAsset - source asset symbol (e.g. "ETH")
   * @param {string} params.toAsset - destination asset symbol (e.g. "SOL")
   * @param {string|number} params.amount - human-readable amount (e.g. "0.1")
   * @param {string} params.userAddress - your connected wallet's address
   * @param {string} [params.recipient] - optional different recipient; defaults to userAddress
   */
  async getBridgeQuote({ from, to, fromAsset, toAsset, amount, userAddress, recipient }) {
    if (!from || !to || !fromAsset || !toAsset || !amount || !userAddress) {
      throw new Error("getBridgeQuote requires: from, to, fromAsset, toAsset, amount, userAddress.");
    }
    const { data } = await this._get("/bridge/quote", { from, to, fromAsset, toAsset, amount, userAddress, recipient });
    return data;
  }
}

// Real, honest usage example — not aspirational, this is exactly what
// calling the SDK actually does:
//
// import { MangoSDK } from "mango-sdk";
// const mango = new MangoSDK();
//
// const tokens = await mango.getLaunchpadTokens();
// const quote = await mango.getBridgeQuote({
//   from: "base", to: "solana", fromAsset: "ETH", toAsset: "SOL",
//   amount: "0.05", userAddress: "0xYourRealAddress",
// });
// // quote.steps contains the real, unsigned transaction data.
// // Your own wallet (wagmi, ethers, whatever you're using) signs and
// // sends it — this SDK never does that part for you.

export default MangoSDK;

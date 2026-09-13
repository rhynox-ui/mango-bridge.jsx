# Mango Protocol API & SDK

A real, public REST API and JavaScript SDK for Mango Protocol's bridge and launchpad. Every endpoint here returns live, on-chain data — nothing is mocked or simulated.

**Base URL:** `https://mangoprotocol.site/api/v1`

## The one non-negotiable design principle

**This API is read-only where it comes to signing.** Mango Protocol is non-custodial — no endpoint here can sign or submit a transaction on your behalf, because that would require holding a private key, which breaks the entire non-custodial premise of this protocol. Where a real transaction is involved (bridging), the API returns the actual unsigned transaction data. Your own wallet signs and sends it.

---

## REST API

### `GET /launchpad/tokens`

Every launchpad token currently on the verified Hook — the same data the app's own Explore page shows.

```
curl https://mangoprotocol.site/api/v1/launchpad/tokens
```

```json
{ "data": [ { "tokenAddress": "0x...", "name": "...", "symbol": "...", "marketCapUsd": 0, "graduated": false, ... } ], "cached": true }
```

### `GET /launchpad/token?address=0x...`

Full detail for one token — market data, real trades, real holders.

```
curl "https://mangoprotocol.site/api/v1/launchpad/token?address=0x..."
```

```json
{ "data": { "token": { ... }, "trades": [ ... ], "holders": [ ... ] } }
```

### `GET /bridge/chains`

Every chain and asset combination this app has an independently verified contract address for.

```
curl https://mangoprotocol.site/api/v1/bridge/chains
```

```json
{ "data": [ { "chain": "base", "chainId": 8453, "nativeAsset": "ETH", "supportedAssets": ["ETH", "USDC", "USDT", "WBTC"], "isSolana": false }, ... ] }
```

### `GET /bridge/quote`

A real, live quote — fee, ETA, and the actual unsigned transaction steps to execute the transfer.

| Parameter | Required | Description |
|---|---|---|
| `from` | yes | source chain key, e.g. `base` |
| `to` | yes | destination chain key, e.g. `solana` |
| `fromAsset` | yes | source asset symbol, e.g. `ETH` |
| `toAsset` | yes | destination asset symbol, e.g. `SOL` |
| `amount` | yes | human-readable amount, e.g. `0.1` |
| `userAddress` | yes | your connected wallet's address |
| `recipient` | no | different recipient; defaults to `userAddress` |

```
curl "https://mangoprotocol.site/api/v1/bridge/quote?from=base&to=solana&fromAsset=ETH&toAsset=SOL&amount=0.05&userAddress=0x..."
```

**A note specific to Solana routes:** if either side is Solana, `userAddress`/`recipient` need to be the correctly-typed address for whichever side they're on — an EVM address for an EVM side, a Solana address for the Solana side. The quote itself will fail with a clear error if given the wrong format for a given chain, same validation the app itself uses.

### `GET /launchpad/quote`

A real, live trade quote for a launchpad token — reads the pool's actual current price on-chain.

| Parameter | Required | Description |
|---|---|---|
| `tokenAddress` | yes | the launchpad token's address |
| `side` | yes | `buy` or `sell` |
| `slippagePercent` | no | default `5` |

```
curl "https://mangoprotocol.site/api/v1/launchpad/quote?tokenAddress=0x...&side=buy"
```

**Honest limitation:** this is the pool's spot price, not a full swap simulation — a reasonable estimate for small trades relative to pool depth, less precise for large ones.

### `GET /launchpad/launch`

Real, unsigned transaction data for launching a new token on the deployed Factory — the same call the app's own launch flow makes.

| Parameter | Required | Description |
|---|---|---|
| `name` | yes | token name |
| `symbol` | yes | token symbol |
| `creator` | yes | your wallet address |
| `devBuyEth` | no | ETH to buy at launch, default `0` |

```
curl "https://mangoprotocol.site/api/v1/launchpad/launch?name=Test&symbol=TEST&creator=0x..."
```

Returns `{ to, data, value, chainId }` — sign and send this with your own wallet on Robinhood Chain (chain ID `4663`). Confirmed the endpoint itself returns real, well-formed data — correct Factory address, correctly-encoded call data. What hasn't been separately confirmed: actually signing and submitting that data through this specific API path to verify a real token deploys — the app's own launch flow has done that successfully, this endpoint's output hasn't been signed and sent yet.

---

## SDK

```bash
npm install mango-sdk   # placeholder — not yet published; import sdk/mango-sdk.js directly for now
```

```js
import { MangoSDK } from "./sdk/mango-sdk.js";

const mango = new MangoSDK();

const tokens = await mango.getLaunchpadTokens();
const token = await mango.getLaunchpadToken("0x...");
const chains = await mango.getBridgeChains();

const tradeQuote = await mango.getLaunchpadQuote({ tokenAddress: "0x...", side: "buy" });

const launchTx = await mango.getLaunchTransaction({ name: "Test", symbol: "TEST", creator: "0xYourRealAddress" });
// launchTx = { to, data, value, chainId } — sign and send with your own wallet.

const quote = await mango.getBridgeQuote({
  from: "base", to: "solana",
  fromAsset: "ETH", toAsset: "SOL",
  amount: "0.05",
  userAddress: "0xYourRealAddress",
});
// quote contains the real, unsigned transaction steps.
// Sign and send them with your own wallet — the SDK never does this part.
```

---

## Honest status — what's here and what isn't yet

**Built, deployed, and confirmed working end to end** — every endpoint below was tested directly against the live API at `mangoprotocol.site/api/v1/`, not just built and assumed: launchpad token listing, detail, and trade quotes; launchpad launch (real, correctly-encoded unsigned tx data, verified against the deployed Factory's actual ABI); bridge chain listing; bridge quotes including a real Solana chain ID and real Relay-returned transaction steps.

**No published npm package yet** — `sdk/mango-sdk.js` is a real, working file in this repo; it just isn't distributed as an installable package yet.

## Contact

API questions, bug reports, or integration help: mango@mangoprotocol.site.

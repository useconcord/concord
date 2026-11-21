# Troubleshooting Indexing Errors

Concord continuously syncs on-chain events for watched assets via background indexer passes (`CONCORD_SYNC_INTERVAL`). When an error occurs during an indexing pass, Concord records the sanitized description in `assets.sync_error` and surfaces it in the dashboard asset overview banner, the `/api/overview` API response, and CLI status output.

This guide lists every indexing error message produced by the chain layer (`services/api/src/chain.ts`) and the synchronization coordinator (`services/api/src/concord.ts#runSync`), explaining the root cause, whether the condition self-heals, and what action operators should take.

---

## Quick Reference Table

| Error Message | Cause | Self-heals? | Operator Action |
|---|---|:---:|---|
| `<label> is not answering; trying again in <N>s` | All endpoints are temporarily resting in cooldown | **Yes** | **Wait** for cooldown to expire or configure backup endpoints |
| `<label> is unavailable (<failures>)` | All endpoints failed or 90s budget ran out | **Sometimes** | **Rotate endpoint** or check upstream provider status |
| `HTTP 400` / `HTTP 404` / `HTTP 422` | Provider rejected malformed query or URL path | **No** | **Verify endpoint configuration** |
| `Stellar RPC <method>: <message>` | Provider rejected JSON-RPC parameters | **No** | **Rotate endpoint** or check Soroban RPC compatibility |
| `Stellar RPC <method> returned no result` | Provider returned empty response without error | **No** | **Rotate endpoint** or inspect provider health |
| `Stellar RPC getHealth did not report its ledger range` | Node health missing `latestLedger`/`oldestLedger` | **No** | **Rotate endpoint** to a fully synced node |
| `invalid cursor: <cursor>` | Unparseable or malformed event cursor from RPC | **No** | **Rebuild history** |
| `Indexing was paused for longer than the network keeps events...` | Indexer was offline longer than RPC retention (~7 days) | **No** | **Rebuild history** (`pnpm concord rebuild`) |
| `This asset's saved indexing position is unreadable...` | Corrupted cursor in local SQLite database | **No** | **Rebuild history** (`pnpm concord rebuild`) |
| `The <network> ledger is now behind this asset's history: the network was reset...` | Testnet or local network was reset/wiped | **No** | **Stop watching** the asset and re-add |
| `this asset has no starting ledger yet` | Asset sync initiated before baseline was saved | **No** | **Rebuild history** |
| `opening balances are only available for classic assets` | Baseline mode requested for contract token | **No** | **Watch in window mode** |
| `ledger <N> is older than the RPC retains (oldest <M>); use a baseline` | Fixed start ledger is pruned by RPC | **No** | **Use baseline mode** or window mode |
| `Indexing stopped on an unexpected error.` | Unhandled internal exception during pass | **Sometimes** | **Check server logs** for details |

---

## Endpoint and Network Errors (`chain.ts`)

### 1. `<label> is not answering; trying again in <N>s`
- **Example:** `Stellar RPC (mainnet) is not answering; trying again in 30s`
- **Cause:** Every configured endpoint for the network recently encountered a rate limit (HTTP 429 / JSON-RPC rate limit) or consecutive network failures, and all endpoints are currently in their cooldown rest period (`services/api/src/chain.ts#L254-L258`).
- **Self-heals:** **Yes.** Concord pauses calls to rested endpoints and will automatically resume attempts as soon as the first endpoint's cooldown expires in `<N>` seconds.
- **Action:** **Wait**. If this occurs frequently, configure additional endpoint URLs in `CONCORD_MAINNET_RPC_URLS` or `CONCORD_TESTNET_RPC_URLS` to spread traffic across providers, or obtain dedicated API keys with higher rate limits.

### 2. `<label> is unavailable (<failures>)`
- **Example:** `Stellar RPC (mainnet) is unavailable (rpc1.example: timed out; rpc2.example: HTTP 502)`
- **Cause:** Concord attempted requests across all awake endpoints and either every endpoint failed (after up to 2 attempts per endpoint), or the overall 90-second operation budget (`BUDGET_MS = 90_000`) was exhausted (`services/api/src/chain.ts#L281-L284`).
- **Self-heals:** **Sometimes.** If caused by a brief transient internet outage or temporary upstream load spike, subsequent scheduled sync passes will retry once endpoints awake.
- **Action:** **Rotate endpoint or check provider status**. If an endpoint shows `bad API key`, verify credentials configured in `CONCORD_RPC_HEADERS`. If an endpoint shows `unreachable` or repeated `timed out`, check network connectivity or remove the failing host.

### 3. `HTTP 400`, `HTTP 404`, or `HTTP 422`
- **Cause:** The remote HTTP server returned a client error status code (`services/api/src/chain.ts#L348`). This indicates the configured URL path does not expose a standard Soroban RPC or Horizon endpoint.
- **Self-heals:** **No.** Client errors represent terminal configuration rejections and are neither retried nor failed over.
- **Action:** **Verify endpoint configuration**. Ensure the URL points to the root of a valid Soroban RPC endpoint (e.g. `https://mainnet.sorobanrpc.com`) or Horizon endpoint (e.g. `https://horizon.stellar.org`).

### 4. `Stellar RPC <method>: <message>`
- **Example:** `Stellar RPC getEvents: -32602 Invalid params`
- **Cause:** The RPC node responded with a standard JSON-RPC error code (e.g. invalid arguments or unparseable query) that does not represent a transient server issue (`services/api/src/chain.ts#L406`).
- **Self-heals:** **No.**
- **Action:** **Rotate endpoint**. Check that the node supports standard Stellar Soroban RPC methods and is running a compatible software release.

### 5. `Stellar RPC <method> returned no result`
- **Cause:** The RPC server returned an HTTP 200 JSON-RPC response with neither a `result` object nor an `error` object (`services/api/src/chain.ts#L409`).
- **Self-heals:** **No.**
- **Action:** **Rotate endpoint**. The upstream RPC node or proxy is returning malformed JSON-RPC bodies.

### 6. `Stellar RPC getHealth did not report its ledger range`
- **Cause:** Concord queries `getHealth` to determine the retention window of the network (`oldestLedger` and `latestLedger`). The provider returned a health check response omitting these mandatory fields (`services/api/src/chain.ts#L442`).
- **Self-heals:** **No.**
- **Action:** **Rotate endpoint**. The node is either initializing, desynchronized from the network, or not a compliant Soroban RPC instance.

### 7. `invalid cursor: <cursor>`
- **Cause:** An event cursor returned by the RPC node could not be parsed into a valid ledger sequence and index (`services/api/src/chain.ts#L647`).
- **Self-heals:** **No.**
- **Action:** **Rebuild history**. Rebuilding resets the cursor to the baseline ledger.

---

## Indexing Lifecycle and Gap Errors (`concord.ts`)

### 8. `Indexing was paused for longer than the network keeps events...`
- **Full Message:** `Indexing was paused for longer than the network keeps events, so movements in between are missing. Rebuild this asset to start again from fresh opening balances.`
- **Cause:** Standard Soroban RPC nodes prune historical events older than approximately seven days (`head.oldest`). If Concord was stopped, crashed, or disconnected from the network for longer than this retention window, events that occurred during the outage have been permanently pruned from RPC (`services/api/src/concord.ts#L579-L583`). Concord detects this gap and halts indexing to prevent recording incomplete balances.
- **Self-heals:** **No.** The events cannot be retrieved from standard RPC.
- **Action:** **Rebuild history**. In the dashboard asset Settings, click **Rebuild history**, or run:
  ```sh
  pnpm concord rebuild <ASSET_CODE_OR_ID>
  ```
  Rebuilding captures a fresh Horizon baseline snapshot at the current ledger and resumes streaming forward. All previously uploaded register CSVs, journals, instructions, corporate actions, and sign-offs are preserved.

### 9. `This asset's saved indexing position is unreadable...`
- **Full Message:** `This asset's saved indexing position is unreadable. Rebuild this asset to start again from fresh opening balances.`
- **Cause:** The cursor stored in `assets.cursor` in SQLite could not be parsed by `cursorLedger()` (`services/api/src/concord.ts#L575-L577`). This typically occurs only if the SQLite file was directly edited or damaged.
- **Self-heals:** **No.**
- **Action:** **Rebuild history** via the CLI or dashboard Settings.

### 10. `The <network> ledger is now behind this asset's history: the network was reset...`
- **Full Message:** `The testnet ledger is now behind this asset's history: the network was reset. Stop watching it.`
- **Cause:** The latest ledger reported by the network is more than 1,000 ledgers *behind* the events already stored in Concord's database (`services/api/src/concord.ts#L584-L588`). This indicates that the target blockchain network was completely reset or rolled back (frequent on testnets and local development environments).
- **Self-heals:** **No.** The historical events recorded in Concord belong to a destroyed ledger chain.
- **Action:** **Stop watching** the asset. Remove the watched asset and re-watch it on the fresh network.

### 11. `this asset has no starting ledger yet`
- **Cause:** Internal state inconsistency where `syncPass` was invoked before `prepare` set the asset's initial `startLedger` (`services/api/src/concord.ts#L607`).
- **Self-heals:** **No.**
- **Action:** **Rebuild history** or re-watch the asset.

### 12. `opening balances are only available for classic assets`
- **Cause:** Attempted to establish opening balances via `startMode: "baseline"` on a Soroban contract token (`services/api/src/concord.ts#L437`). Contract tokens do not have Horizon trustline accounts.
- **Self-heals:** **No.**
- **Action:** **Watch in window mode**. Contract tokens must be watched using window mode (`startMode: "window"`).

### 13. `ledger <N> is older than the RPC retains (oldest <M>); use a baseline`
- **Cause:** The asset was configured to start indexing from a specific historical ledger (`startMode: "ledger"`), but that ledger has already been pruned by the RPC node (`services/api/src/concord.ts#L461-L465`).
- **Self-heals:** **No.**
- **Action:** For classic assets, watch using **baseline mode** (`startMode: "baseline"`). For contract tokens, watch using **window mode** (`startMode: "window"`).

### 14. `Indexing stopped on an unexpected error.`
- **Cause:** An unhandled error or filesystem exception occurred during the pass (`services/api/src/concord.ts#L220`).
- **Self-heals:** **Sometimes.**
- **Action:** **Check server logs** (`console.error` logs the stack trace) to identify database locks, file permission issues, or uncaught system faults.

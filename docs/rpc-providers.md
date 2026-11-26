# Connect a paid Stellar RPC provider

Choose a Stellar **mainnet RPC** endpoint from your provider. Copy its URL and check how it
expects the API key. In the example below, the first provider puts its key in the URL path.
The second expects an `X-API-Key` header. Replace the example hosts, keys and header name
with your provider's values in the root `.env` or your deployment's secret settings.

```dotenv
CONCORD_MAINNET_RPC_URLS=https://primary.example/rpc/EXAMPLE_PATH_KEY,https://secondary.example:8443/rpc
CONCORD_RPC_HEADERS='{"secondary.example:8443":{"X-API-Key":"EXAMPLE_HEADER_KEY"}}'
```

The quotes around the JSON are for `.env` or a shell. In a hosting dashboard, enter the JSON
object itself. Keep both the full path-key URL and the header value private. Restart Concord
after updating the settings.

Concord tries the comma-separated endpoints in order and moves to the next available one on
failure or rate limiting. Supply endpoints on the same network. For testnet use
`CONCORD_TESTNET_RPC_URLS`. Headers apply to every configured endpoint matching their host,
including Horizon. Use a dedicated provider host for a key.

Use a bare hostname for standard HTTPS, such as `secondary.example`, and `host:port` for a
specific non-default port. An exact port match takes precedence over a hostname entry.
On builds before [the hostname fallback fix](https://github.com/useconcord/concord/pull/1124),
a hostname-only key on a non-default port can cause a 401 or 403. Include the port as shown above.

## Check both endpoints

Run these probes privately with the same URLs and credentials you configured. Each should
return `result.status` equal to `healthy`. A 401 or 403 is a reason to check the key, header
name and port. For repeated 429s, check the provider quota and consider increasing
`CONCORD_SYNC_INTERVAL` (seconds between background passes).

```sh
probe() {
  curl --silent --show-error --fail-with-body --max-time 10 \
    --header 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$@"
}
probe 'https://primary.example/rpc/EXAMPLE_PATH_KEY'
probe --header 'X-API-Key: EXAMPLE_HEADER_KEY' 'https://secondary.example:8443/rpc'
```

Compare `oldestLedger` and `latestLedger` in the two responses. Stellar RPC typically keeps
about seven days of events, and each provider sets its own window. If both have pruned a
ledger, switching providers cannot recover its events. See the [Stellar getHealth response](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getHealth)
and [Concord's history limits](./limits.md).

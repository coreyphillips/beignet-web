# Beignet web

A Lightning-first wallet with two modes:

- **On this browser:** the Beignet engine runs in a dedicated worker. Keys and live channel state persist in this browser, with an optional password.
- **Connect a host:** control a wallet on your own Beignet host using a temporary connection token.

The same Wallet, Send, Receive, Activity, details and Settings screens work in both modes. `/?demo=1` opens an isolated preview with no real keys or spendable money.

## Static hosting (experiment)

This branch also runs as plain static files, with no companion service on the app's origin. The workflow in `.github/workflows/pages.yml` publishes it to GitHub Pages at `https://coreyphillips.github.io/beignet-web/` on every push to `static-pages`. The build honours `BEIGNET_BASE_PATH` for the path prefix and `NEXT_PUBLIC_MANUAL_TRANSPORT=1` to let the user name the network connection instead of asking the origin for one.

A browser cannot open TCP or Tor connections, so a static wallet needs a WebSocket door to the network. On first run, and later in **Settings → Network & servers**, the wallet takes one of two connections:

- **Direct to your node.** The primary node's own WebSocket listener carries the Lightning peer connection (Beignet's `websocketPort`, or CLN's `bind-addr=ws:`). The chain comes from either an Electrum server reachable over WebSocket, or a block explorer API in the Esplora style (`https://mempool.space/api` by default on mainnet and testnet). The explorer path is an Electrum server emulated inside the worker: it answers the engine's Electrum calls from REST, takes new blocks from mempool.space's push socket, and polls subscribed scripts, so incoming on-chain detection is slower than a real Electrum subscription and depends on a third party.
- **Through a relay.** A `beignet-relay` you operate, entered as its URL and access token. This is the same byte relay the companion embeds.

From the HTTPS site only loopback addresses may be plain `ws://`; anything else needs `wss://` with a certificate the browser trusts, and the primary must accept WebSocket connections from the site's origin. The primary URI keeps its `pubkey@host:port` form; the WebSocket URL is a separate field. A browser tab is still not an always-on node.

On regtest the local stack already has what direct mode needs: the Docker CLN listens for WebSocket peers on `ws://127.0.0.1:19847`, and `npm run bridge` puts a loopback WebSocket door (`ws://127.0.0.1:60004`) in front of the TCP electrs on 60001. `npm run test:worker:direct` runs the production worker bundle through that path: create a regtest wallet, reach CLN over its WebSocket listener, fund an address, see the deposit move into a dual-funded home channel, lock it in with a Lightning balance, and reopen from the saved connection after a cold restart. `BEIGNET_TEST_TRANSPORT=relay` runs the same steps through the relay. `npm run test:esplora:online` is a read-only smoke of the emulated Electrum server against mempool.space.

One finding from that run: CLN's WebSocket listener drops the connection when a maximum-size Lightning message (65,569 bytes) arrives as a single frame, so the direct peer socket sends large writes as 16 KiB frames; the far side reads frames as a byte stream, so this is invisible to the protocol.

## Develop

From the parent `beignet-projects` directory, `npm run web` starts or reuses the local companion and then starts this app. If running this directory’s `npm run dev` directly, start `npm run host` from the parent in a separate terminal.

```sh
npm --prefix ../beignet-engine ci
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. Predev builds the local engine fork and copies SQLite WASM. The fork is a local file dependency; rebuilding it updates the implementation used by the app.

## Independent wallet

1. Start the sibling `beignet-host` and open `http://127.0.0.1:8787`. The companion provides the transport automatically and starts/reuses Tor for the supplied onion primary. No host wallet pairing or wallet API credential is needed in browser mode.
2. Choose **On this browser**. Leave **Add a password** off to continue without one, or enable it and choose any nonempty password. There is no minimum length. Without a password, anyone with access to this browser/profile can open the wallet. Existing password-protected wallets still require their original password.
3. Press **Continue**. The wallet is created with the supplied primary and `ssl://bitkit.to:9999`, and its recovery phrase is shown. No relay URL, token, or server fields are part of normal setup.
4. Keep the wallet open for receiving and channel monitoring. **Lock & disconnect** stops its engine and terminates the worker. Reopen from the same browser profile and site origin.

**Settings → Network & servers** switches between mainnet, testnet, and regtest, with a saved Electrum default and primary for each. The default testnet server is `ssl://electrum.blockstream.info:60002`; regtest uses `tcp://127.0.0.1:60001`. New network wallets reuse the original browser wallet's recovery phrase, while channels, balance, history, and databases remain separate. Switching no longer generates another phrase or backup prompt. Wallets created by older versions keep their existing phrases and channel state; Settings identifies networks whose separate backups must be retained. The original phrase stays inside the vault and worker during creation. Testnet/regtest require their own primary node and a server following the same chain as that node. **Save default** preserves a preference; **Reconnect wallet** or **Switch** applies it. Network settings remain available when a failed connection prevents loading balances. Host mode selects/creates matching-network wallets with their own phrases; its defaults apply to new host wallets.

Local mode requires a secure context (HTTPS or localhost), WebAssembly and synchronous OPFS handles in workers. The app checks these capabilities, rejects simultaneous opens in another tab, and requests persistent storage. The browser may deny persistence or clear site data. Clearing site data removes the local wallet. A phrase alone does not contain the latest channel state; see [recovery boundaries](../ARCHITECTURE.md).

No wallet engine host is involved in independent mode. The companion transport remains a network access dependency and can observe Electrum queries and traffic metadata. Background tabs may be suspended; the browser is not an always-on Lightning service.

## Host wallet

Start `../beignet-host`, choose **Connect a host**, enter its URL and token, then select or create an LFBW. Host tokens remain in this tab's memory. Locking the app removes the token while the host continues operating. A development app on port 5173 needs that exact origin allowed by the host. Remote hosts require HTTPS.

## Production and offline files

```sh
npm run build
```

Serve `dist/client` through the companion host, or route `/api/browser-config` and `/transport/*` to the companion behind the same HTTPS origin. The sibling host serves the app at `http://127.0.0.1:8787`; its wallet API is optional. Static files alone cannot provide browser TCP/Tor connectivity; see the static hosting section for the connections a static build can use. Serve `.wasm` as `application/wasm` and `.js` as JavaScript. No Cloudflare account, server database, extension or WebUSB is required.

The build includes SQLite WASM and an app-only service-worker cache. Once installed, cached app files can load without the static server. Payments still require network access. Wallet state, transport credentials, and API responses never enter this cache. Close older app tabs and reopen after an update so the waiting app version can activate. Updates wait for open tabs to close; no update forcibly replaces an active engine. Initial loading, offline installation and a browser/version matrix have not been interactively tested.

## Payment behavior

Send accepts BOLT11 and Bitcoin/BIP21 requests, quotes fees, and requires explicit confirmation. Reviews expire and are consumed once. Uncertain outcomes are not retried automatically. Receive combines an address, Lightning invoice and direct-funding request when supported. Activity retains pending, failed, completed and uncertain states separately.

Primary selection has no mandatory trust checkbox. The selected primary retains the existing instant, zero-confirmation funding policy. Unconfirmed Bitcoin deposits remain Awaiting; trusted Lightning funding may become available before its funding transaction confirms. Splices preserve existing available funds while added funds wait for the engine's locking conditions. Removing the checkbox does not impose a new all-funding-must-confirm policy. Failed primary setup now displays bounded connection diagnostics, including refused ports and wrong-network servers.

Settings updates keep the current settings screen visible. Primary changes, connection retries and network changes show progress and a persistent result in the relevant card, while conflicting actions are disabled. A saved setting with an unreachable node is reported as saved with a connection warning. Failed edits retain their draft; background refreshes do not overwrite edits. A network switch clears the previous wallet's balance before showing another wallet, and stays in Settings. The browser worker returns the persisted primary after applying a change.

If your primary is a Beignet Umbrel wallet, enable **Edit → Liquidity provider → Provide inbound capacity to lightning-first wallets (JIT receive)** on that primary. A connected Lightning node can still have this service disabled; ordinary Umbrel wallets start with it off. Pairing an external node address does not change its provider role. Without the service, a wallet needing incoming capacity cannot obtain a quote. Receive now explains a missing reply, keeps the amount and description for retry, and shows a spinner while checking capacity or creating the invoice. It never bypasses fee review or substitutes an invoice without the required capacity.

Receive watches both the Lightning invoice and exact Bitcoin outputs to its address. Incoming Bitcoin replaces the QR with **Payment detected — awaiting confirmation**. Confirmed receipts show **Payment received**, the amount and a brief confetti animation (disabled for reduced motion). Partial payments show the unpaid remainder; status-check failures retain the receipt while retrying. Requests cannot be shared again from the receipt screen. Unpaid invoice entries are labeled **Payment request** in Activity.

BOLT12 sending, LNURL/Lightning addresses, camera scanning, background push delivery and automatic financial fallback are not implemented. Optional WebMCP only navigates screens; it cannot send payments or reveal secrets.

## Checks

```sh
npm test
npm run typecheck
npm run lint
npm run build
# Requires the documented local regtest Electrum and CLN stack:
npm run test:worker
# For an explicitly supplied Beignet regtest provider with JIT enabled:
BEIGNET_TEST_ELECTRUM='tcp://REGTEST_HOST:PORT' \
BEIGNET_TEST_PRIMARY='PUBKEY@PRIMARY_HOST:PORT' npm run test:worker:jit
```

`test:worker` executes the actual production worker bundle in an isolated browser-like JavaScript realm without Node globals. Disk-backed OPFS test handles and real WebSockets exercise the vault, portable engine and relay. This does not substitute for Safari/Firefox/Chrome device testing. See [VALIDATION.md](../VALIDATION.md) for actual results.

`test:worker:jit` creates a separate temporary wallet with no channels, obtains a real 10,000-sat receive quote, and creates a signed regtest invoice. It does not fund channels or send payments, and removes its temporary wallet afterward. It requires the running local companion and a production build; the companion must allow the supplied regtest profile.

## Offline receiving

Receiving offline is an opt-in on the Receive form ("Receive offline", off by default), shown when the engine advertises it. The ordinary request is paid over the home channel or provisioned by the primary just in time. With the box on, a fixed amount of at least 354 sats is required and the primary prepares a durable reservation: the wallet can be closed after sharing the request, reopening discovers settled receipts and updates the balance and Activity, and unpaid requests remain payable until expiry.

An offline receive is only for a channel that already exists with the primary and has room for the amount; it never has the primary open one. The primary must run Beignet 0.21.8 or newer with settlement enabled. The app reports unsupported preparation without silently issuing an online-only invoice.

See [FFOR validation](FFOR-VALIDATION.md) for simulator and funded regtest evidence, commands, and deployment limits.

The pre-implementation web app and shared sources are backed up in `../backups/web-before-automatic-receive-20260918.tar.gz` (SHA-256 `509af130491eea206a41dfb83eb4672ee5b8f4f5acd37b6d7b5f55d913a89a8d`). Run `npm run build` followed by `node tests/worker-ffor-regtest.mjs` for the funded production-worker lifecycle test.

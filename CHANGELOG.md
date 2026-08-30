# Changelog

All notable changes to this project are documented in this file. Versioning is
driven by the root [`VERSION`](./VERSION) file (see README → Releases & images).

## [Unreleased]

## [0.20.3]

### Fixed

- **WebSocket is served on every jsonrpc / tendermintrpc endpoint, and the
  console now says so.** The ws capability chip, the WSS url on the endpoint
  sheet and the Try-me HTTP/WS toggle all keyed off a `ws://` / `wss://`
  node-url in the mounted values file — so an endpoint whose upstreams are all
  HTTPS showed no WebSocket at all, while the router was answering handshakes
  on it. Both listeners register `/ws` and `/websocket` unconditionally, so ws
  availability is a property of the interface: `ifaceServesWs` is what those
  three surfaces read now. The endpoint sheet also stops looking for a separate
  `websocket` listen port that the router has no concept of — the upgrade rides
  the interface's own address, path-scoped.

  The upstream `wss://` url keeps its own meaning: it is the leg
  **subscriptions** ride. With none configured the router refuses every
  `*_subscribe` while plain calls over the same socket relay normally, so the
  Try-me drawer flags subscription methods with `no ws upstream` instead of
  hiding the transport that works.

## [0.20.2]

### Fixed

- **An upstream with no traffic is no longer an upstream we know nothing
  about.** The Upstreams roster read the QoS gauge the router's *routing* path
  writes (`rpc_endpoint_selection_score`), which only exists once a relay has
  been routed — and a backup sits in a pool the router consults only on
  failover, so it never appeared there. The roster then folded the QoS column
  into the "No recent traffic" cell anyway, discarding the score even where one
  existed. So a configured backup showed as a blank row, while the router was
  in fact scoring it every few seconds.

  `/api/metrics/upstreams` now reads `rpc_optimizer_selection_score` first, per
  row, falling back to the old gauge. Both gauges are filled by ONE optimizer
  computation, so this is the same number on a schedule that does not wait for
  traffic: the router's probe loop scores every configured upstream, backups
  included. New `scoreSource` field names which gauge a row used, and a
  fallback score that may be out of date is dimmed, with the reason on hover.

  A row with no traffic also stops being a special case in the roster: `0`
  requests and three em dashes say it in the table's own language, where the
  sentence that used to span those four cells broke the column alignment and
  repeated the BACKUP badge two columns to its left.

### Added

- **Block polls are reported per upstream** — `polls: {ok, failed}` on
  `/api/metrics/upstreams`, from `rpc_endpoint_fetch_latest_{success,fails}`,
  surfaced on the upstream deep-dive (not in the roster, where it was a
  sentence in a numeric table).
  The router's chain tracker polls every configured upstream on the chain's own
  cadence whatever the traffic, so this is a liveness signal an idle row still
  has. Both counters at zero is reported as "not polled in this window", never
  as healthy: a poll gate suppresses polls that served traffic or a peer pod's
  poll already made redundant.

### Changed

- **The upstream empty state reports what the router did, instead of asserting
  what it did not.** It claimed "probes are passing" and "Probes healthy ·
  standing by as backup" as static text on every upstream, whatever its real
  health and whatever its role — a probe result nothing had read, on the one
  panel that exists because we have no measured numbers to show. It now shows
  the upstream's health, its live QoS, its block polls and its latest block,
  each omitted when the router does not report it.
- The Availability tooltip on the upstream deep-dive said "successful synthetic
  probes"; the figure is the success rate of real requests routed to that
  upstream. Reworded, and it now points at the poll counts for the probe-side
  answer.

## [0.20.1]

### Fixed

- **The Metrics page no longer answers before it has heard back.** Its seven
  reads take a few seconds, and every panel treated "no data yet" and "this
  build does not emit that" as the same state — so a loading page asserted
  `cache not enabled on this build`, `retry counters not emitted by this build
  yet`, `across 0 upstreams`, `No upstreams configured yet.`, `consistency
  check failed — response behind seen head`, and, worst, a green tick reading
  **No errors on this chain in the selected window**. Those are claims about
  the deployment, made while the question was still in flight; an operator
  opening the page mid-incident was told everything was fine. Panels now show
  a ghost of their own content until the answer arrives, and the honest-empty
  wording appears only once there is an answer to be honest about.

### Added

- **One loading vocabulary, in `components/gateway/Skel.tsx`.** Content-shaped
  ghosts sized to the value they replace, sharing a single keyframe and
  duration: mounted in the same frame they sweep in phase, so the page reads as
  one surface settling rather than seven spinners. Nothing moves when the data
  lands — the hero cards measure the same in both states. Ghosts render on the
  first load only, never on the 15s poll; a refetch that already has numbers
  keeps them and shows a breathing dot instead, which is also the first cue
  that a window change is re-reading under the old figures.

## [0.20.0]

### Added

- **The Try-it method picker searches.** A customer opened a ticket for
  `eth_getBlockByHash`, which the catalog has carried for ETH1 and 42 other EVM
  chains all along — behind "Show all", under a native `<select>` whose popup
  covers the very button that would have said so. Typing a method name now
  finds it whatever list it is in, across every tier: `getblockbyhash`,
  `get block by hash` and `eth_getblockby` all reach the same command, and
  `bank balances` reaches `/cosmos/bank/v1beta1/balances` past the version
  segment that stops a contiguous match. A query that matches nothing says so
  instead of showing a blank list.

### Changed

- **The picker says how much of the list it is showing, and what the rest is.**
  Twelve entries read as a complete list. The short list is now headed
  `Ready to send · showing 12 of 52`, "Show all N methods" is the last row
  INSIDE the list rather than a button underneath it, and expanding splits the
  tier into `Ready to send` / `Needs params` / `Not verified` with counts. The
  short list itself is unchanged — it is a promise that everything in it runs
  as-is, and a Cosmos LCD's hundred paths are why it exists.
- **A command the catalog cannot classify now says so.** `ready` and
  `needsInput` are claims the generator can prove; a command with neither is
  one nobody has checked. That third state rendered as silence, which reads as
  "safe to send" — it is how `eth_getBlockByHash` came to fire `[]` at a node
  and fail with an unexplained RPC error. It carries a neutral `not verified`
  tag, deliberately distinct from the amber `needs params`: we know one takes
  input, and we do not know about the other.

### Removed

- **`TENANT_ID` is no longer read into config.** The api never named its own
  org: the multi-tenant store pins `X-Scope-OrgID` from the credential that
  authenticated, so a config field holding a tenant name was an invitation to
  move the tenancy boundary into a values file. The chart still sets the env;
  nothing reads it.

## [0.19.0]

### Added

- **The api authenticates its Prometheus calls.** `PROMETHEUS_USERNAME` +
  `PROMETHEUS_PASSWORD` go out as `Authorization: Basic` on every query, and
  `PROMETHEUS_ORG_ID` as `X-Scope-OrgID` — what a per-tenant read path in front
  of a multi-tenant Mimir asks for. Both halves of the pair or no header: half a
  credential would turn every query into a 401 that reads, from the dashboard,
  exactly like "no data". Unset env is byte-identical to before.
- **Readiness is an instant query, not `-/ready`.** That route is
  bare-Prometheus only — Mimir's `/prometheus` API and a query-only proxy don't
  serve it, so against the real read path the pod would never have gone Ready.
  `vector(1)` also carries the credential, so a rejected one fails readiness
  instead of rendering as empty panels.

### Changed

- **Chain resync — lava-specs dropped 47 REST names shadowed by a
  placeholder-shape twin.** Across 26 Cosmos-family chains the Try-it
  catalog loses `/cosmos/auth/v1beta1/bech32/{address_bytes}` (×26),
  `/ibc/apps/transfer/v1/denom_hashes/{trace}` (×15) and one chain-specific
  path each on Canto, Stride, Elys (×3) and Lava. Every one of them was a
  "needs params" row whose concrete twin already sat in the list, so nothing
  runnable goes away. No chains arrived or left; map, explorers and roll-call
  files are unchanged.

## [0.18.5]

### Fixed

- **The REST names declared under two internal paths now say so.** TON declares
  `/estimateFee` and `/runGetMethod` under both v2 and v3. The catalog already
  marked them; the drawer shows it on the router leg, where the name resolves to
  one collection and the other is reachable only direct.

## [0.18.4]

### Fixed

- **Prefixed REST identifiers did not route.** 0.18.3 recomposed REST commands
  as internal path + api name (`/v2/getMasterchainInfo`) on the reasoning that
  the router owns internal-path routing. It does — but not by reading the path
  off the request. The router matches REST by api name alone
  (`matchSpecApiByName`) and then dials the node-url pinned to that name's
  collection, so a prefixed path matches nothing. Against a TON router:

  ```console
  $ curl -s localhost:3460/getMasterchainInfo     | head -c 48
  {"ok":true,"result":{"@type":"blocks.masterchainInfo"…
  $ curl -s localhost:3460/v2/getMasterchainInfo
  {"code":12,"message":"Not Implemented","details":[]}
  ```

  The path is metadata now (`ip`), never part of `m`. TON keeps all 51 methods
  and every one of them is sendable again. It also un-breaks the curated hints,
  which are keyed by spec api name and had stopped matching TON entirely.

### Added

- **The direct-to-upstream leg composes internal paths.** It addresses one
  upstream url by hand, so it reproduces what the router builds: prefix the
  path when the upstream serves the shared root (the router's
  `autoGenerateMissingInternalPaths` appends the same segment), leave it off
  when the url is already that version's root. Tatum's TON entries — v2 at the
  host root, v3 under `/api/v3`, each pinned with `internal_path` — were being
  sent `…/v2/v2/getMasterchainInfo` and `…/api/v3/v3/accountStates`.

  Picking a method from another internal path than the upstream is aimed at is
  refused before Send, the way a backup-tier pin is: no prefix reaches it, and
  relaying the vendor's 404 would read as a verdict on the request.

- **The command dropdown groups by internal path.** A chain that splits an
  interface across versions reads as versions instead of one alphabetical run,
  and the selected command carries its path as a tag — TON declares
  `/estimateFee` and `/runGetMethod` under **both** v2 and v3, and they are
  different calls. Those two are marked ambiguous in the catalog: the router's
  REST lookup is keyed by (name, verb) with no path, so one collection wins and
  the other is only reachable direct.

## [0.18.3]

### Fixed

- **The Try-it catalog kept one internal path per interface and dropped the
  rest, without saying so.** `pickPath()` preferred `""` and otherwise took the
  path with the most methods, so every other path vanished with no roll-call
  entry. AVAX had been missing its `/P` and `/X` methods on those grounds since
  it was added; TON made it visible, losing all 22 `/v3` methods the moment its
  `""` path went away.

  Every internal path is emitted now. REST identifiers are recomposed as
  internal path + api name (`/v2/getMasterchainInfo`) — the path a client sends
  through the router, which owns internal-path routing — so the two names TON
  repeats across v2 and v3 (`/estimateFee`, `/runGetMethod`) stop colliding.
  JSON-RPC names are left alone: the router resolves those by method name, so
  AVAX's `platform.*` and `avax.*` need no prefix.

  TON goes back to 51 methods, AVAX from 70 to 103.

## [0.18.2]

### Fixed

- **Two upstreams on the same host rendered as the same row.** lava-specs split
  TON's v2/v3 onto `internal_path` collections, so a provider can now pin one
  node-url per version — TON on Tatum serves v2 at the root and v3 under
  `/api/v3`. Both normalizers dropped the field, and `maskNodeUrl` reduces a url
  to scheme+host because upstream paths carry api keys, so the two node-urls
  arrived on screen identical with nothing to tell them apart.

  `RouterNodeEndpoint` now carries `internalPath`, both normalizers read it
  (`internal_path` in helm values, `internal-path` in an SR_CONFIG file), and the
  upstream row renders it as a badge. The direct relay has the same blind spot —
  it appends a caller-supplied path to the endpoint base, and the correct path
  now differs per node-url — but prefilling that path changes relay behaviour
  and is left for its own change.

### Changed

- **TON's try-it catalog went from 51 methods to 29.** The v2/v3 split removed
  the `""` internal path, and `pickPath()` keeps exactly one path per
  (interface, tier) — preferring `""`, else the path with the most methods — so
  it now keeps `/v2` and drops the 22 `/v3` methods. Same shape AVAX has always
  had, where `/P` and `/X` are absent for the same reason. Only 2 of the 51
  names collide once the version prefix is stripped, so a path-aware catalog
  could carry 49; making the generator and the try-it dialer internal-path aware
  is its own change.

## [0.18.1]

### Changed

- **Chain resync — two chains arrived upstream, and one of them took another's
  chain id.** lava-specs added `CELOS` (Celo Sepolia) and `SONICB` (Sonic
  Blaze), which is what the drift gate caught. Sonic renumbered its testnets in
  the process: `0xdede` (57054) is now Blaze and has its own spec, while
  `SONICT` became `0x3909` (14601).

  That matters because the curated Sonic testnet explorer had been verified
  against `0xdede`, so it belonged to Blaze — leaving it on `SONICT` would have
  pointed that chain at a different network, the same failure as Celo
  Alfajores below. The entry moved to `SONICB`, and `SONICT` gained
  `explorer.testnet.soniclabs.com`, watched rendering a height. `CELOS`
  resolves from chainlist to `celo-sepolia.blockscout.com`, also watched.

  247 chains, 205 with an explorer, 161 primaries linking a height.

### Fixed

- **A sweep of all 213 explorers found 23 dead, moved or wrong-network links.**
  The catalog had never been checked as a whole. Every primary explorer was
  loaded in a real browser: 141 worked, and the rest had rotted in the way
  registry data does — nobody updates a row when a host dies.

  **Celo Alfajores was pointing at a different chain.** `alfajores.celoscan.io`
  now redirects to `sepolia.celoscan.io`, so anyone checking an Alfajores height
  was reading Celo Sepolia. It moves to `celo-alfajores.blockscout.com`.

  **Hosts that no longer resolve**: `ftmscan.com` (Fantom's Sonic rebrand),
  `holesky.beaconcha.in`, `holesky.etherscan.io`, `sepolia.kakarotscan.org`,
  `explore-testnet.vechain.org`. Fantom mainnet moves to
  `explorer.fantom.network`, which serves `/blocks/<n>` — plural, so it takes
  the `blocks` kind.

  **Retired or moved deployments**: `agoric.explorers.guru` emptied out exactly
  as Lava's did (→ `atomscan.com/agoric`), Canto's neobase explorer answers
  "Deployment Paused" (→ `explorer.tcnetwork.io/canto`), Cronos `.org` → `.com`,
  Flow `flowscan.io` → `flow.com`, Mantle Sepolia → `sepolia.mantlescan.xyz`,
  Story → `www.datanetscan.io`, beaconcha.in Sepolia → `light-sepolia`,
  Avalanche P-Chain → `build.avax.network`.

  **Nine chains become recorded gaps** rather than dead links: Fantom testnet,
  Holesky beacon, Kakarot Sepolia, VeChain testnet, Secret and Stride testnets,
  Sei testnet and both Berachain bArtio entries.

  Coverage is 204 chains with an explorer and 41 recorded gaps; 159 primaries
  can still link a height.

  Left alone deliberately: five Mintscan entries whose only fault is a `www.`
  redirect, and 18 Cloudflare-challenged hosts where nothing is proven either
  way from a build network.

## [0.17.1]

### Fixed

- **Fourteen chains were home-only because nobody had tested them.** Hyperliquid
  rendered as plain text on the dashboard while `hyperevmscan.io/block/…` works
  perfectly in a browser. An audit of why each curated entry was home-only found
  24 of 36 labelled "home probed" — the home page answered and **the block page
  was never opened**. The rule said a shape must be watched; nothing enforced
  that watching was ever attempted.

  The tooling compounded it: Cloudflare-fronted explorers answer 403 to `fetch`,
  and those were recorded as unverifiable. A scripted Chromium with a real
  user-agent gets through most of them, so several "cannot be verified from this
  network" verdicts were an artifact of the check, not a fact about the site.

  Re-tested, each watched rendering the requested height: `HYPERLIQUID`,
  `SONICT`, `SPARK`, `ETHEREUMPOW`, `FUELNETWORK`, `MOVEMENT`, `MINA`, `MINAT`,
  `TON`, `TONT`, `STACKS` and `STACKST` gain a block link, and `SUI`, `SUIT` and
  `IOTA` gain one on `/checkpoint/<n>` — a new kind, since those chains count
  checkpoints and a checkpoint number is what the router reports as their latest
  block. `TRX` and the beacon chains upgrade from unverified to watched.

  **159 of 213 primaries can link a height, up from 145**, and the unverified
  count drops from 19 to 10.

- **Starknet Sepolia was shipping a link that renders nothing.** It pointed at
  `sepolia.voyager.online/block/<n>`, which answers 200 and shows no block —
  exactly the failure the catalog exists to prevent, carried in on an
  `unverified` label. It is home-only now.

- **The chains that really are home-only now say why**, from a test rather than
  an assumption: Avalanche P-Chain and Concordium render without the block,
  Casper answers "Nothing Found" because its block page takes a hash, Bittensor
  404s, VeChain rate-limited, XRPL testnet has the right route but pruned
  ledgers, and Sui devnet resets.

## [0.17.0]

### Added

- **Every block height on the Metrics pages links to that block on the chain's
  own explorer.** The catalog landed in 0.16.5 and nothing read it: a router's
  tip and each upstream's tip printed as bare numbers, and checking one against
  the public chain meant hand-typing a URL. Both `Latest block` columns — the
  Routers table and the Upstreams roster — are now links, and the chain icon or
  name opens the explorer's home page.

  The rule is **a value links to the block page, an identity links to the
  explorer home**, and it is forced by what the catalog can honestly offer: 145
  chains have a proven block-page shape, 68 have an explorer but no shape, and
  32 have neither. So Ethereum's height opens `etherscan.io/block/…` while
  Hyperliquid's stays plain text with its icon opening `hyperevmscan.io` —
  `ExplorerBlockLink` never falls back to a home page, because a click on a
  specific height that lands on a front page has misled the reader.

  It stays a table: same tabular figures, underline and pointer on hover only,
  opens in a new tab, and the title names the explorer before you click. Both
  `Latest block` column tips say a height is clickable and that chains without a
  verified block page show it plain — otherwise nobody finds it.

## [0.16.6]

### Changed

- **The Via router leg is struck through and turned off on a backup upstream.**
  Explaining why a pinned request can't reach a backup still left the control
  that fires it enabled, so the drawer went on offering a send whose only
  possible answer is `-32000 Selected provider not available`. It now reads as
  what it is — crossed out, dimmed, unclickable — and hovering it gives the
  one-line reason ("Backup upstream — the router reaches it only after every
  primary is exhausted, and picks the backup itself. Send it direct instead.").
  The full version stays in the banner.

  The hover lives on a wrapper rather than the button: a disabled control takes
  no pointer events, so a `title` on it would never be shown — and the point of
  turning this one off is that the reader can ask why.

  Everything that would fire the same doomed request goes with it: **Compare
  both** (a refusal beside a real answer measures nothing) and, on a row with
  no url the api can dial for the selected transport, **Send** itself, both
  carrying the same hint. A backup row also never renders the router leg as the
  selected one, even when the drawer has nowhere else to sit.

## [0.16.5]

### Fixed

- **31 explorer rows claimed a block link nobody had seen work** — 23 of them
  the primary, the one a UI would use. The generator matched a link-shape
  `kind` on a registry row's *transaction* and *address* templates and then let
  that kind contribute its own `block` shape on top, which is exactly the
  invention the catalog documents itself as refusing. On Lava's STAVR explorer
  the invented `/block/<height>` renders an empty shell; on AstroStake it falls
  through to the dashboard. A shape is now either supplied by the registry,
  **inherited from a proven shape on the same host**, or absent: `cosmos/chain-registry`
  spells out Mintscan's `/blocks/<height>` on COSMOSHUB and leaves it null on
  the twelve other Mintscan deployments, and those twelve now say `inherited`
  rather than passing as registry-asserted. Hosts that proved nothing anywhere
  are home-only.

- **Lava pointed at two dead explorers, and now links blocks like any other
  chain.** `explorer.finteh.org/lava` is unreachable, and `lava.explorers.guru`
  redirects to `explorers.guru`, whose catalog lists 10 mainnets and 5 testnets
  with Lava among none of them. Both shipped only for being first in
  `cosmos/chain-registry`'s list of eleven validator-run rows.

  `LAVA` and `LAV1` are now curated from
  [docs.lavanet.xyz/block-explorer](https://docs.lavanet.xyz/block-explorer/) —
  `lavacenter.xyz/lava` and `lavatest.mellifera.network/lava`, both watched
  rendering a requested height. Note for whoever owns those docs: the explorer
  the page calls **official** is the dead `lava.explorers.guru`.

  The resync rule now says to check a chain's own documentation before taking
  a registry's first row, since that is what a registry cannot tell you — and
  to treat the page as a lead rather than as truth, since Lava's still names a
  retired explorer.

- **Doubled slashes are normalised.** chain-registry hands LAV1
  `https://lava.explorers.guru//transaction/…`, which shipped verbatim.

### Changed

- **The catalog links a block height, and nothing else.** It stored three
  shapes per chain — block, transaction, address — while the dashboard holds
  exactly one value a public chain can confirm: a height. It has no
  transaction hash and no chain address anywhere (`provider_address` is an
  upstream's name, not an on-chain address). 321 templates addressed values
  that did not exist, and 18 chains — NEAR, MultiversX, LAV1, Celestia and
  others — carried nothing else, reading as covered while the UI could not
  build a single link from them. Those are honest home-only entries now.

  The API is `explorerBlockUrl(spec, height)` and `explorerHome(spec)`; the
  kind table drops from eleven three-ref shapes to seven block shapes.
  `explorerBlockUrl` also refuses anything that is not digits, so a hash passed
  by mistake cannot become a link. 143 of 213 primaries can link a height; the
  other 70 offer a home page and say so.

## [0.16.4]

### Changed

- **Chain resync — the explorer registries re-fetched from live.** The catalog
  shipped in 0.16.0 was built from a registry snapshot captured mid-development;
  this is the first full resync on top of it. Both registries were re-read
  (chainid.network, plus all 433 `chain.json` files in cosmos/chain-registry)
  and every generated catalog reproduced **byte-for-byte**. Nothing upstream had
  moved: the snapshot was already current, and coverage is not limited by it.

- **Three chains that had no explorer now have one**, each watched rendering in
  a browser rather than assumed:
  - **EOS** → EOS Authority, with a verified block link. It had been recorded as
    having none since bloks.io started redirecting to `explorer.xprnetwork.org`,
    a different chain.
  - **Tezos Shadownet** → the TzKT deployment for that network, block link
    verified.
  - **Ice Open Network** → its ION explorer, home page only; no deep-link shape
    was watched, so none is offered.

  Coverage is 213 of 245 chains, 61 of them hand-checked.

- **The remaining gaps carry evidence instead of a shrug.** Three that were
  re-tested this resync now say what was actually observed and when:
  Litecoin testnet (its explorer's routes exist but the deprecated testnet3
  backend answers 502 for block data), Monero testnet (the host resolves but
  errors on the block route), and Koii (its explorer serves a certificate for a
  different name, so no browser reaches it).

## [0.16.3]

### Fixed

- **Try now offered a pin the router can never honour.** `lava-select-provider`
  is matched against the router's primary pool only. A backup-tier upstream
  lives in a separate pool the router reaches solely when every primary is
  exhausted, and it picks among those by QoS itself — the header is never read
  on that path, so pinning a backup answers `-32000 Selected provider not
  available` however healthy the upstream is. The drawer pinned anyway and
  presented the refusal as if the upstream were at fault.

  A backup row now opens on **Direct to upstream** when the api can dial it —
  the one path that reaches a backup — wears a `backup` tag, and reads the
  reason instead of a failed request. Via router stays selectable, and the
  Comparison row labels its leg `pin refused` rather than `pinned to X`. The
  tier is read per endpoint row: one node can be primary on one chain and
  backup on another.
- **"Test connection" stopped offering a probe it knows can't land.** The modal
  pins to the upstream it names, so on a backup row it could only ever go red.
  It now explains the pool split and points at the drawer's direct mode. When a
  node is primary on one chain and backup on another, the probe picks the chain
  where the router will actually route to it.

## [0.16.2]

### Fixed

- **A gated upstream answered 401 on the direct leg while the router's leg
  answered 200.** A vendor key does not always live in the url: `auth-config`
  on a node url puts it in a header (`Authorization: Bearer …`) or a query
  string, and the router attaches it to every relay it sends there. The
  direct-to-upstream relay dialed the bare url, so for those endpoints the
  comparison read as an upstream fault — the one reading it cannot make, since
  the only difference was a header the dashboard never sent. The relay now
  sends the endpoint's `auth-config` headers (on the ws handshake too) and
  appends its `auth-query` the way the router's own `AddAuthPath` appends it,
  and `redactSecrets` scrubs that credential out of whatever the upstream
  echoes back.
- **A credential the values file names but doesn't carry now says so.** The
  chart runs `envsubst` over the rendered router config, so a token is often
  written `${VENDOR_TOKEN}` and handed to the router's container from
  `miscellaneous.routers.env`. Placeholders resolve against that block's
  literal `value:` entries — and only those; a `secretRef` lives in a
  Kubernetes Secret the dashboard doesn't mount, and the api's own environment
  is deliberately not a source (a values file could otherwise name
  `${AUTH_SECRET}` and have the relay carry the dashboard's signing key to an
  upstream host). What can't be resolved answers `422` naming the missing
  variable instead of dialing a literal `${VAR}`.
- **"Test connection" tested whichever upstream the router felt like.** The
  per-upstream modal POSTed through the router with no pin, so a green
  "Connection successful" said nothing about the upstream whose row opened it.
  It now sends `lava-select-provider`, like the Try-now drawer.
- **The relay resolves a node name the way the pin header is folded.** Exact
  match first, then lowercased with spaces to dashes — the chart's own folding.
  The two halves of the drawer address an upstream by one vocabulary whichever
  casing the caller holds, and a folded name two nodes answer to resolves to
  nothing rather than to a coin flip.

## [0.16.1]

### Fixed

- **The Routers table is a table of routers again.** It was keyed by chain, so
  two routers serving one chain collapsed into a single row — which then wore
  the first router's name (`.find(r => r.spec === …)`) beside the whole chain's
  upstream count, and the second router had no row at all. Rows are now keyed on
  the config router id, and the upstream count comes from the values file, so it
  is the router's own.

  What a row can honestly claim differs, and the row says which. No series
  carries a router: `smartrouter_*` is labelled with the chain. Where the
  collector reports a per-target label for a router, its chain-level numbers are
  re-read through that label and are genuinely its own. Where it does not and
  the chain has siblings, the rows show the shared chain-level figures marked
  **shared**, naming who else is counted in — two such rows carry the same
  numbers on purpose, and adding them up would double the deployment's traffic.

- **`GET /api/metrics/routers-rollup`** backs it. One chain-level read per spec
  is shared by every router that cannot be scoped, so the extra rows cost no
  extra queries.

### Changed

- **The Latest block column is the number alone.** The `39s behind · refresh
  17s · 2 ifaces` sub-line was a per-interface diagnostic in a rollup table. The
  per-upstream lag stays on the Metrics · Upstreams roster, and the full
  per-interface detail stays on `GET /api/metrics/block-heights`.

## [0.16.0]

### Added

- **Every chain now knows where its block explorer is.** `explorersFor(spec)` /
  `explorerUrl(spec, ref, value)` in `@sr/shared` resolve a Lava spec index to
  the chain's official explorer and to a deep link for a block height,
  transaction or address — the receipt for every number the dashboard prints
  about a chain. 210 of 245 chains are covered; the other 35 are recorded as
  deliberate gaps with a reason. No UI consumes this yet.

  The join key is the spec's own `chain-id` **verification** (`ETH1` → `0x1`,
  `COSMOSHUB` → `cosmoshub-4`), which makes 130 of the entries derivable from
  `ethereum-lists/chains` and `cosmos/chain-registry` instead of hand-written.
  Both registries are read from a **committed snapshot**, so the CI drift gate
  stays a lava-specs check and a third party editing an explorer url can never
  fail an unrelated PR.

  Link shapes are an eleven-row `kind` table rather than three URL templates
  per chain, and a kind is assigned only when the registry's own template
  proves it or a person watched the page render. Every row carries a
  `verified` field saying which of those happened — or, for 22 rows behind
  Cloudflare bot management, that it could not be checked and why.
  `explorerUrl()` returns **null** rather than a guessed URL, and a kind's
  `block` template always takes a height, so the hash-addressed explorers
  (NearBlocks, MultiversX, cspr.live) ship no block link at all.

  Two chains were wearing the wrong explorer before this landed and would have
  linked to the wrong chain entirely: chainlist has id collisions, and Astar
  Shibuya resolved to Japan Open Chain (both claim 81) while Hyperliquid
  resolved to Wanchain Testnet (both claim 999). The generator now prints every
  spec-vs-chainlist name mismatch on each run, and the overlay carries both
  corrections.

- **`apps/web/scripts/probe-explorers.mjs`** — checks that every explorer the
  dashboard would link is still up and has not started redirecting to another
  site. It classifies bot-management refusals (401/403/429) as *challenged*
  rather than failed, because a 403 is the script being turned away rather than
  evidence about the URL. Not wired into CI: it talks to several dozen third
  parties, whose flakiness must never fail a PR. It caught bloks.io redirecting
  to XPR Network, a different chain — EOS is now recorded as having no verified
  explorer instead of linking to one.

- **`docs/CHAINS.md`** — one reference for what the dashboard knows about a
  chain: the catalogs, the explorer join key and its traps, the kind table, the
  verification statuses, and how to add or correct an entry.

### Changed

- **The spec-drift gate covers five artifacts, not three.** The explorer
  catalog and its roll-call join the chain map, the method catalog and the
  no-runnable-defaults roll-call, so a chain arriving without an explorer fails
  the build rather than passing unnoticed. `chain-resync.md` carries the
  procedure.

## [0.15.0]

The dashboard opened on a day. The question people open it to answer is "what
is happening now".

### Changed

- **The default time window is 30 minutes.** Over a day, a chain that has been
  failing for ten minutes is 0.7% of the window judging it — the average absorbs
  the incident that made you open the page. The cost is honest and worth naming:
  uptime, availability and error rate ride far fewer samples over half an hour,
  so they swing more, and on a quiet deployment a 30-minute window can sit below
  the traffic floor and read `0` / `—` where the day view showed numbers. The
  window picker is unchanged and one click away.
- **One source of truth for it.** The default lived in three disconnected
  places, only one of which the UI read: `DEFAULT_WINDOW` (the api's parse path
  for an absent `window=`), a `useState("1d")` literal in `FiltersProvider`
  (what every page actually opened on), and ~18 `window = "1d"` parameter
  defaults across the PromQL builders. All three now read `DEFAULT_WINDOW`, so
  the next change to it is one line. A test pins the value on its own, so
  changing what the product opens on stays a deliberate edit.

Fixed short windows are left alone on purpose: the topbar status strip's own
`window=1h` call, the upstream deep-dive's 1h / 24h / 7d context boxes, and the
custom-range parser's fallback. None of them is "the default window".

## [0.14.0]

Which block is each router on, and how far behind is each upstream? Both gauges
were already on the wire and half-read: the upstream tip rendered with no
context, and the router tip was fetched by `/api/metrics/chains` and dropped.

### Added

- **A `Latest block` column on the Metrics · Routers table**, from
  `smartrouter_latest_block` — the tip the router itself has accepted, per api
  interface, leading with the furthest-ahead one. A Cosmos router serving
  jsonrpc, rest and tendermintrpc has three tips that can disagree, and the row
  says how many interfaces are behind the number.
- **A `Behind` column on the Metrics · Upstreams roster**, and `behindSec` +
  `stale` on `UpstreamMetrics` to back it. **The lag is stated in seconds**, not
  blocks: a block count means nothing across chains, where the same 1,038-block
  delta is 37 seconds on Aptos and would be four months on Bitcoin. Seen on one
  screen: 1 block behind on Ethereum is 12s, 2 blocks on Hyperliquid is 2s.
- **`GET /api/metrics/block-heights`** — every tip for every chain: per router
  deployment × interface, per upstream × interface, each against the chain's
  best upstream tip, in blocks and in seconds. Instant only; these are gauges,
  so there is no window. Takes both router axes.
- **A stale marker.** An upstream whose tip gauge hasn't moved in 15 minutes
  *while the chain kept producing blocks* is stuck, not slow — and the second
  half of that test is what keeps Bitcoin's ~9-minute blocks from reading as
  frozen on every poll.

### Changed

- **The router tip is judged against its own refresh rate, not the clock.**
  `smartrouter_latest_block` advances on accepted tip observations rather than
  on every poll, so it trails the upstream gauge by about one refresh interval
  however healthy the router is — on a fast chain that is thousands of blocks.
  A wall-clock threshold painted all six routers amber on first render. The
  cadence is now measured (`changes(smartrouter_latest_block[15m])`, surfaced as
  `refreshSec`) and the colour grades multiples of it, so a router reads normal
  at one refresh behind and red only when it falls further behind than its own
  update rate explains.
- **A tip that two routers share says so.** That gauge is labelled with the
  chain and never with the router, so two config routers on one chain share a
  single series unless the collector labels targets per router. The cell marks
  it `shared` rather than letting a router filter imply the number is that
  router's own — the same honesty as the roster's `+N shared`.

## [0.13.0]

Which router served this? The roster could only be sliced by chain — and a
chain can have several routers.

### Added

- **A router filter next to the chain one**, defaulting to all routers. Its
  options are the mounted config's routers, because that is the only place two
  routers on one chain are distinguishable: no series carries a router. Picking
  a chain narrows the list to the routers serving it, and picking a chain that
  excludes the selected router clears the selection rather than leaving a filter
  that has quietly stopped applying.
- **A Router column on the Metrics · Upstreams roster**, from `routerIds` on
  every upstream row (new on `UpstreamMetrics`, joined from the values file in
  the api). Two routers declaring one node name share a single series, so such a
  row is marked `+1 shared` — the numbers are both routers' traffic together,
  and splitting them would be an invention. Sortable, and it leads with the
  router you filtered on.
- **`GET /api/metrics/upstreams?routerId=`** — keeps one config router's rows.
  A different axis from the existing `?router=`, which narrows the PromQL by the
  collector's target label; the doc now has a table telling them apart.

- **The router filter reaches the error hotspots too** —
  `GET /api/metrics/errors?routerId=` filters the (chain × upstream) pairs
  through the same config join, since a hotspot names an upstream. The pivots
  behind "Error types" aggregate by chain / method / code and can't be
  attributed, so they are left alone rather than filtered to look narrowed.
- **A title on the Metrics page.** It had none, so the filters were the first
  thing on it and nothing said where you were.

### Changed

- **The chain and router filters belong to the page you set them on.** They
  narrow WHICH data a screen shows, and a narrowing that outlives its screen is
  a trap — you arrive somewhere showing a slice of reality with no memory of
  having asked for one. Navigating clears them (returning to a page too, not
  just leaving it), nothing is persisted, and tab switches within a page keep
  them because the tabs are one screen. The time window still persists: how far
  back you like to look isn't a claim about what you're looking at.
- **Picking a router picks its chain.** A config router serves exactly one, so
  this narrows the panels that aggregate by chain — the only way they can be
  narrowed at all — and the chain box says so instead of the page quietly
  filtering more than it shows.
- **A pair that failed nothing is no longer listed as a failing one.** The
  errors breakdown includes (chain × upstream) pairs whose upstream answered with
  JSON-RPC errors — served relays, not failures — and showed them as
  `0.00% · 0 errors`, which read as padding and made a chain filter look like it
  hadn't applied. Such a row now states the number it does have ("no failed
  relays · 3 answered with a node error"), stays out of the severity palette,
  sorts below the real failures, and is counted apart in the header.
- **"Error types" says what it counts.** Those are all classified error events,
  including the upstream replies the router recovered from, so they can exceed
  the failed-relay total above them — which looked like a contradiction with no
  line of text to explain it.
- **One router control instead of two.** The topbar's scope-only dropdown is
  gone; the header filter sets both axes — the config id always, and the label
  scope when the collector actually reports a matching target. Where it can't
  (no per-router target label, the common case), the page says so: the roster is
  filtered, the chain-level panels stay deployment-wide, because no metric
  records which router served a request.
- **The router list names routers, not chains.** The chain is shown only when
  the router's own name isn't already it — an SR_CONFIG mount names each router
  after the chain it serves, and repeating that turned the list into a list of
  chains.
- **The Upstreams page honours the router filter too**, in all three groupings,
  since the same selection is shared across the app.

## [0.12.0]

One page for the mounted config. The Endpoints tab is gone — the surface it
carried is the Upstreams page's third grouping, and its default.

### Added

- **A "By router" grouping on the Upstreams page, now the default.** One card
  per router in the values file, rows for the (router × interface) endpoints it
  publishes: the interface tag, the configured capabilities, the address to
  dial, the upstream count behind it, and the same click-through detail sheet.
  The page already carved this config three ways in prose — "what does this
  router publish", "who serves this chain", "what does this upstream serve" —
  and the first of them was the one living on its own tab.
- **The Metrics page's chain picker, on the Upstreams page too**, narrowing
  all three groupings: the routers publishing that chain, its own chain card,
  or just the upstreams behind it (a provider card drops the rows for chains
  the filter excludes rather than showing them under a narrowed page). It reads
  the chains the *config* declares, not the ones `/api/metrics/specs` reports —
  a configured chain nobody has called yet still has endpoints to show — and it
  hides itself on a single-chain deployment, where it could only ever restate
  the page. A selection that leaves the config reads as "All chains" instead of
  narrowing everything to nothing.
- **The Try-it console reads identically in the new grouping**, because it is
  the same call: the endpoint's own address, its ws upgrade when the config
  declares one, its upstreams' add-ons, and the chain's live health. Nothing is
  pinned to a single upstream there — the request goes to the router, exactly as
  it did on the Endpoints tab. The per-upstream Try-now in the chain and
  provider groupings still pins its relay, which is what those rows are about.

### Changed

- **One health vocabulary across every panel.** `HealthState` has three states
  and, until now, four wordings: the Upstreams roster said "healthy /
  degraded", the Routers table "Operational / Unhealthy", the upstream
  deep-dive "Live · up / Down", and the Try-it drawer printed the raw wire
  word — so one upstream read three different ways depending on which panel
  you looked at. `lib/health.ts` owns the words and colours now, `<HealthTag>`
  / `<HealthDot>` render them, and `UpstreamRow` carries a `HealthState`
  instead of its own parallel union. The Routers table's wording won, because
  it was the most prominent. `unknown` still means "no metrics in this window",
  never "down".
- **The chain filter is shared, and so is its list.** It lives on
  `FiltersProvider` next to the time window and the router scope, so both pages
  read one selection instead of each holding its own copy. (It is scoped to the
  page you set it on — see 0.13.0, which settled that.) Its options come from
  `useChainOptions()`: the union of the chains the config declares and the
  chains the metrics report traffic for, with each page dimming what it can't
  populate ("no traffic yet" on Metrics, "not in config" on Upstreams) instead
  of dropping it from the list.
- **The Upstreams page honours the shared time window**, with the same
  selector every metrics screen has. It pinned `1d` while already honouring the
  shared router scope, which made it the one screen where the absent selector
  was a silent override — its health figures come from the metrics in a window
  like everything else's.
- **"By provider" is "By upstream".** The product renamed providers to
  upstreams everywhere except that segment label and `ChainGroup.providers`.
- **The chain picker lists chains alphabetically**, on the Metrics page as well
  as the Upstreams page. Its callers' orders were accidents of their sources —
  whatever order Prometheus returns label values in, whatever order the values
  file happens to declare routers in — and neither helps someone hunting for a
  chain by name. Sorted in the component, so a third caller can't reintroduce
  an arbitrary order.
- **The sidebar brand goes home.** Clicking "Smart Router" navigates to `/`,
  which redirects to the default surface — so home stays defined in one place
  instead of being restated in the header.
- **Metrics moved under the "Smart Router" section label** in the sidebar,
  next to Upstreams, instead of floating above it unlabelled.

### Removed

- **The Endpoints tab** (`/endpoints`) and its view. The route is gone, not
  redirected — the same cards are one segmented-control click away, and the
  page's search and mainnet/testnet filters carry over to them.
- **The endpoint create sheet**, whose only entry point was that page's hidden
  "New endpoint" button. Endpoint creation is a Magma Cloud action; on a
  read-only config mount it never had anything to commit.
## [0.11.4]

### Fixed

- **The upstream roster called every provider by a name the router does not
  answer to.** The values file names upstreams for people — `Lava`,
  `Blockdaemon`, `Tatum` — and the chart folds that to
  `lower | replace " " "-"` on the way into the router's own config. The
  router registers the folded string, publishes it on the `provider_address`
  and `endpoint_id` Prometheus labels, and matches the `lava-select-provider`
  header against it exactly. The dashboard reflected the unfolded name, so it
  addressed `Lava` where everything downstream says `lava`, and two things
  broke quietly on the back of one mismatch: every upstream card read "no
  data" (the metrics join never matched, while the traffic sat right there
  under the lowercased label), and every "send this straight to the upstream"
  relay came back `-32000 Selected provider not available`.

  Helm node names are now folded the way the chart folds them. This is a
  stopgap — the router is being taught to match the header case-insensitively
  ([smart-router#285](https://github.com/Magma-Devs/smart-router/pull/285)),
  and the shim comes out once that ships. SR_CONFIG deployments are left
  verbatim: that file *is* the router's config, so its `name:` is already the
  registered provider name.

## [0.11.3]

### Fixed

- **Ethereum Classic wore Ethereum's logo.** `resolveIcon` falls back to the
  first segment of a chain's name slug, and `ethereum` exists — so ETC and
  ETCT rendered under the wrong chain's mark, the same silent borrowing that
  once gave CANTONT Canto's logo. Vendored `ethereum-classic.svg` from
  web3icons (`networks/mono` glyph on the `#01C853` of its `background`
  variant, with the `#111` glyph the house style calls for on a circle that
  light).
- **Arbitrum Nova's icon was the v1 one, unvouched for.** Nova keeps a
  separate mark — it is a separate chain, 42170, a production AnyTrust network
  next to Arbitrum One's 42161 — but the SVG carried over from v1 with no
  provenance entry. Re-vendored from web3icons `networks/mono/arbitrum-nova`
  on the `#EF8220` of its `background` variant: Nova's own orange, not
  Arbitrum One's navy. Arbitrum Sepolia, the real testnet, keeps inheriting
  `arbitrum-one` as it should.
  The map still classifies Nova as a testnet, because lava-specs names it
  "Arbitrum Nova Testnet" — fixed upstream in
  [lava-specs#112](https://github.com/Magma-Devs/lava-specs/pull/112); the
  next resync after that merges flips it to mainnet (115 mainnets / 130
  testnets) and CI's drift gate will require it.

## [0.11.2]

### Added

- **A RACE icon — every chain in the map now has one.** RACE and its testnet
  were the last two on `default.svg`, written off as "wordmark only, illegible
  at icon size". Its wordmark turns out to draw R-A-C-E as thin outlines of
  ascending height on a shared baseline: the outlines can't survive 24px, but
  the staircase can. The glyph is those four columns at the mark's measured
  proportions, and the circle takes a stop from the wordmark's own
  copper-to-peach gradient. `icons 245 matched a local SVG, 0 → default.svg`.

## [0.11.1]

### Changed

- **`generate-chain-map.mjs` names the chains that fell back to `default.svg`**,
  instead of only counting them. A chain with no vendored icon renders fine —
  which is exactly why nobody notices it arrived without its brand — so the
  resync procedure now has something to act on, and the chain-resync rule
  carries the sourcing steps (web3icons `mono` + its `background` colour →
  `tokens/mono` → cosmos/chain-registry → the project's own asset) alongside
  the house style. Leaving a chain on the fallback stays a legitimate choice;
  it just has to be a recorded one.

## [0.11.0]

Try-it defaults that work. Every command the drawer opens on can be sent
as-is, on every chain — and the ones that can't say so.

### Added

- **A runnability state on every catalog command.** `ready` (what ships with
  it is already a complete request), `needs params` (a placeholder, a hint
  that documents the argument instead of curating one, or the spec's own
  `block_parsing` naming a positional argument), or neither — unmarked,
  because the catalog doesn't know and won't guess. 1263 JSON-RPC, 2960 REST,
  405 Tendermint and 149 gRPC commands are runnable, covering 163 of the 170
  (spec × interface) pairs.
- **The dropdown opens on the runnable ones**, a dozen at most, curated names
  leading. A curated name no longer earns its place on its own:
  `eth_getTransactionByHash` leads on ETH1, where the hint carries a real tx
  hash, and sits behind "Show all" on every other EVM chain, where it
  doesn't. Everything behind "Show all" that needs input is labelled, in the
  list and on the selected command.
- **Runnable defaults for four surfaces that had none** — XRP Ledger (whose
  JSON-RPC takes `[{}]`, not `[]`), Monero, Avalanche P-chain and Celestia's
  node API. Verified against public endpoints except Celestia's, which is
  auth-gated.

### Fixed

- **CometBFT calls shipped an envelope that could only fail.** `params: []`
  is rejected by every Tendermint method with optional arguments ("expected 1
  parameters ([height]), got 0"), so `block`, `block_results`, `blockchain`,
  `validators`, `commit` and `header` errored on Send. An empty object is
  CometBFT's no-arguments call; all Tendermint params and the interface
  default are `{}` now.
- **Add-on tiers were offered on deployments that can't serve them.** The
  ETH1 spec declares `debug_*` and `trace_*`, so both tiers appeared against
  a router with no such upstream, where every send returns "No Providers For
  Addon". Tiers now follow the add-ons the mounted values file declares, the
  way archive already did.
- **REST commands were sent as GET whatever their verb said** — Tron's wallet
  API and EOS's chain API are POST, and the drawer's request line had been
  printing a verb it wasn't using. A REST POST goes out bodyless, since its
  arguments are in the path.
- **A subscription listed over plain HTTP selected to nothing**: the dropdown
  was built from the unfiltered tier while the selection was looked up in the
  transport-filtered list.

## [0.10.0]

Upstreams roster, grouped the way it gets read.

### Added

- **Group by chain (default) or by provider**, as a toggle beside the search
  and network filters. The roster only ever grouped one way — a card per
  config node, with the chains it serves compressed into its header as
  "Ethereum +4" — which answers "what does this upstream do" and hides "who
  serves this chain, and which of them is the backup". Both groupings read
  off the same rows, so they cannot disagree: a chain card names the chain,
  counts distinct upstreams (one serving http + ws is two rows but one
  upstream), and its rows carry the upstream identity that a provider card
  puts in its header. Chain grouping filters per row, so the search box
  matches either the chain or an upstream serving it.

### Removed

- **The latency / uptime / req-today strip on the upstream card header.**
  Latency was the worst p95 across every chain the upstream serves and
  uptime the most conservative minimum — aggregates that can't overstate,
  and therefore describe no single chain; req-today summed the same way over
  a fixed 1d window the card never named. The per-chain figures stay on the
  Metrics page, where they carry a window and a chain.

## [0.9.1]

### Fixed

- **The gRPC dial address the Try-it snippets print had no port on a
  Kubernetes deployment.** A published gateway hostname sits on the scheme's
  default port, so `publicUrls` carries no `:port` suffix — and grpcurl
  refuses a bare host (`missing port in address`), so every copied command
  from a deployed gRPC endpoint failed. The scheme's default is appended when
  the address carries none (`sui-testnet-grpc.<domain>:443`), an explicit port
  is left alone, and a path is dropped — a gRPC dial address has no room for
  one. Shipped in 0.9.0 the address was already scheme-stripped; this is the
  half of the same fix that only shows up against a Gateway, not a local
  listen port.

## [0.9.0]

Try-it console. Its Command dropdown named ~20 curated methods per interface
and printed raw ids for everything else, REST resolved no names at all, and a
gRPC-only endpoint had no console to open. This release makes the console read
the same on every interface, tier and transport.

### Added

- **A derived display name for every method.** Curated names still win; the
  rest are read out of the method id itself — namespace dropped, camelCase and
  snake_case split, acronyms kept whole, and a vocabulary segmenter for the
  run-together ids bitcoin-family and Tron use (`getblockcount` → "Get Block
  Count"). Covers 89% of the catalog's 1174 JSON-RPC ids, 97% of its gRPC ids
  and 91% of its 2817 REST paths. It fails closed: an id it can't read
  renders exactly as it did before, because a wrong name is worse than none.
- **Curated names for the debug and trace tiers** (11 + 16 entries), which
  were the only tiers with none — so those tiers now open on the methods
  worth trying instead of listing geth's full 75-method debug surface.
- **A HTTP / WebSocket toggle in the drawer.** A ws-capable endpoint is one
  endpoint with two transports (the router serves the upgrade on the base
  interface's address, path-scoped), and the console now drives both:
  the dial address, the request envelope and the subscription methods follow
  the toggle. The Endpoints page previously reached only HTTP and the
  Upstreams page only ws.
- **A real WebSocket reachability check.** On the ws transport the drawer's
  status tag is this browser's own handshake against the exact URL Send will
  use — not the chain's Prometheus health, which says nothing about whether
  the upgrade is served. Click it to re-check.
- **A console for gRPC endpoints with no method catalog.** Only 28 spec
  indices declare a gRPC collection; a deployment can publish a GRPCRoute for
  any chain (Tron's native API is gRPC). Those endpoints now open on server-
  reflection discovery — no borrowed methods from another chain's catalog.

### Fixed

- **REST commands were keyed by their HTTP verb.** A REST command's `method`
  is `GET`/`POST` and its path lives in the label, so every curated lookup
  asked for "GET" and missed: no REST name ever resolved, the curated subset
  was always empty (so the dropdown listed all 213 Cosmos paths at once
  behind a "Show all" button that did nothing), and the line under the
  dropdown showed a bare verb. Keys are now the path, and the request line
  reads `POST /wallet/getnowblock`.
- **gRPC snippets dialed a URL.** grpcurl, grpcio and grpc-go take
  `host:port`; they were handed the endpoint row's `http://host:port`, which
  grpcurl reads as part of the hostname. They also defaulted to TLS against
  plain-HTTP listen ports — all three now switch on the endpoint's scheme.

## [0.8.0]

Kubernetes endpoint addresses. With a helm-values mount the Endpoints,
Upstreams and Try-me surfaces printed `—` and offered no request console: they
resolved an endpoint's address from `localPorts`, which only a raw SR_CONFIG
mount fills in. A Kubernetes deployment has no listen ports — it has Gateway
hostnames — so the dashboard now derives them from the same values file.

### Added

- **`RouterTopology.publicUrls`** (api-interface → URL) on the helm-values
  path, mirroring the HTTPRoute / GRPCRoute hostname scheme those values
  describe: `<custom_url_prefix | id-lowered>` joined to the interface by `.`
  (the default) or `-` (`hostStructure: chain-interface`), on `base_domain`,
  over the Gateway's TLS listener — its HTTP listener when there is no TLS
  one, keeping non-default ports. Verified against a real 27-router values
  file.
- **Router id on the Endpoints card header** when several routers serve one
  chain (a staging + production pair on the same `network`), which is the only
  case where the chain name alone doesn't identify the card.

### Changed

- **Endpoint addresses resolve public URL → local port → nothing.** Endpoints
  rows/detail, the Upstreams try-URLs and the connection test all follow that
  order, so a Kubernetes deployment shows the hostname a user can actually dial and
  an SR_CONFIG mount is unchanged. Websocket URLs ride the same address,
  path-scoped (`/ws`, `/websocket`). Where neither format publishes an address
  the UI still renders `—` and the console stays hidden — nothing fabricated.

- **Router scope — `?router=` on every `/api/metrics/*` route**, so the
  numbers split per router deployment instead of only per chain. The router
  labels its series with the chain, so two routers serving one chain summed
  together; what separates them is the collector's per-target label
  (`service` under the Prometheus Operator = the router's Service name),
  named by the new `ROUTER_SCOPE_LABEL` env (default `service`).
  - **`GET /api/metrics/routers`** lists the values actually present, so the
    UI can offer exactly the routers this Prometheus can tell apart — `[]`
    meaning "can't split", never "no routers".
  - A **`<RouterSelect>`** in the topbar applies the scope to every panel
    (persisted as `sr:router`). It hides itself below two routers, and a
    selection that disappears resets to "All routers" rather than silently
    filtering every panel to nothing.
  - The matcher is injected into the finished PromQL by `applyScope`
    (`packages/shared/src/promql/scope.ts`) rather than threaded through ~40
    builders. It's a PromQL walker, not a regex: the naive version corrupts
    metric names quoted inside the `{__name__="…"}` presence probes. An
    absent or malformed `router` value reads cluster-wide rather than
    becoming a different query. `cache_*` stays cluster-wide by design — the
    relay cache is a shared sidecar carrying no router's label.

## [0.7.0]

Chain-coverage sync. The **Chain map ↔ lava-specs drift** gate went red again
when lava-specs added 23 chains; regenerating surfaced four more classification
bugs, all fixed in the generators rather than patched into the output.

### Added

- **23 chains** from lava-specs — Concordium, EOS, Hydration, Ice Open Network,
  Oasis, VeChain, X Layer, Zcash, Bitcoin Signet/Testnet4, Berachain Bepolia,
  Solana Devnet, Aptos Testnet, Ethereum Hoodi and Tron Nile (+ testnets). The
  chain map goes 215 → 238 entries and the try-me catalog with it, so each
  arrives with its real per-spec methods.
- **Eight chain icons** — `concordium`, `eos`, `hydration`, `ion`, `oasis`,
  `vechain`, `x-layer`, `zcash` — taking the map from 19 `default.svg` entries
  down to 2 (RACE and its testnet, unchanged). Same provenance rule as before:
  glyph from [@web3icons](https://github.com/0xa3k5/web3icons) (MIT), circle
  colour read from that icon's own backdrop.
- **Three chain-type families** — `concordium`, `eos`, `vechain`.
- **Curated try-me methods** for the surfaces that had none: EOS's nodeos chain
  API, VeChain Thor's REST, Concordium's `concordium.v2.Queries` gRPC and node
  REST, and the TON HTTP API — which also gives **TON itself** its first hints
  (its curated paths predated the toncenter `/v2` + tonindex `/v3` split, so
  they matched nothing). Four more substrate hints reach every polkadot-SDK
  chain, Hydration included.

### Fixed

- **Concordium classified as cosmos.** Serving gRPC counted as cosmos evidence;
  Concordium serves its own `concordium.v2.Queries` service over it. The cosmos
  test is now the cosmos-SDK surface itself (`/cosmos/…` paths, `cosmos.*`
  services) or a cosmos import.
- **Ice Open Network classified as EVM.** REST-only, no `eth_*` anywhere: it hit
  the generator's blanket `evm` fallback. It is a TON fork serving the identical
  `/v2` + `/v3` paths, and is now grouped with TON.
- **Native L1s labelled by their EVM compatibility layer.** EOS, VeChain and
  Tron Nile serve `eth_*` alongside a full native API (nodeos chain API, Thor
  REST, `/wallet/*`); the native identity is now the family — the same call the
  cosmos branch already made for Sei/Kava/Canto. Chains whose base surface is
  EVM (Oasis, X Layer, Berachain, Hydration) stay `evm`.
- **Bitcoin's Signet and Testnet4 flagged as mainnet.** "Signet" names no
  network the testnet regex knew, and `\btestnet\b` cannot match "Testnet4".
  Enjin's test network — branded "Canary Matrixchain" — is caught too, by
  pairing a `<mainnet-index>T` index with its parent.
- **BTC's genesis hash offered on its test networks.** `getblockheader`'s
  example param was scoped by index *prefix*, so BTCT/BTCS/BTCT4 all inherited a
  block hash their chain has never seen. Hints carrying single-network data are
  now scoped to an exact index.
- **Aptos descriptions on other chains' paths.** `/accounts/{address}` also
  belongs to VeChain, and `/` to Arweave and Stellar; the Aptos hints are now
  scoped, and VeChain has its own.
- **Differently-branded testnets missing their mainnet's icon.** Icon
  inheritance paired testnets by a trailing `T` only, so Berachain's Bepolia
  (`BERAB` ← `BERA`) fell to `default.svg`. It now walks index prefixes.
- **Arbitrum Sepolia rendered Arbitrum Nova's logo** — the v1 overlay had it on
  `arbitrum-nova.svg`. It is a testnet of Arbitrum One and now shows that icon.

## [0.6.0]

Chain-coverage refresh. The **Chain map ↔ lava-specs drift** gate had been red
on `main` since lava-specs added 89 chains; regenerating it surfaced three
correctness bugs in the generator that this release also fixes.

### Added

- **89 chains** from lava-specs — 0G, Akash, Aleo, Algorand, Arweave, Babylon,
  Bittensor, Cronos, dYdX, Ethereum Classic, Flare, Flow, Kava, Kusama, Linea,
  Mina, Monero, Moonbeam, Neutron, Plasma, Plume, Polkadot, Sei, Stacks, Story,
  THORChain, Unichain, XDC and more (+ testnets). The chain map goes 134 → 215
  entries and the try-me method catalog 126 → 215, so every new chain arrives
  with its real per-spec methods rather than a family fallback.
- **41 chain icons**. The 89 new chains would otherwise have arrived with 93
  entries on the `default.svg` fallback; 2 remain (RACE and its testnet, which
  publish only a wordmark — illegible at icon size). Glyphs
  come from [@web3icons](https://github.com/0xa3k5/web3icons) (MIT),
  [cosmos/chain-registry](https://github.com/cosmos/chain-registry) (Apache-2.0)
  and each project's own published asset; circle colours are read from the
  icon's own backdrop rather than chosen by hand. `public/chains/README.md` now
  documents the house style, provenance and how to add one.
- **Eight chain-type families** — `substrate`, `monero`, `aleo`, `algorand`,
  `arweave`, `mina`, `multiversx`, `stacks` — so chains that had no correct
  value in `ChainFamily` stop borrowing one.

### Fixed

- **Chains labelled EVM that answer no `eth_*` method.** `deriveFamily` ended in
  a blanket `return "evm"` with a hardcoded index-prefix list as its only
  non-EVM detection, so 26 map entries were wrong — Monero, Stacks, Algorand,
  Aleo, Arweave, Mina, MultiversX, Enjin, Polymesh, Dash, Kusama and Koii among
  them. Classification now follows `imports` transitively (Dash inherits from
  BTC, Koii from SOLANA) and reads the RPC surface actually served. Chains that
  serve `eth_*` *and* substrate RPC — Astar, Moonbeam, Moonriver, Bittensor —
  stay `evm`, since that is the surface the gateway offers. This also stopped
  the Try-it drawer offering `eth_blockNumber` for Monero in the window before
  the generated catalog chunk lands.
- **Lowercase display names.** lava-specs is inconsistent about casing —
  `"Ethereum Mainnet"` next to `"akash mainnet"` — and the raw name was passed
  through, so 50 chains rendered lowercase. Normalised per word, leaving
  deliberate casing intact (`zkSync Era`, `MultiversX`, `BSC`, `Cosmos SDK v50`).
- **Abstract base specs listed as chains.** `IBC`, `TENDERMINT`, `ETHERMINT`,
  `COSMOSWASM` and the four `COSMOSSDK*` specs are `enabled: false` upstream and
  exist only to be imported, but were emitted into `KNOWN_CHAINS`, which backs
  lists and pickers.
- **Testnets that are branded differently from their mainnet** — Astar's
  Shibuya, Polkadot's and Kusama's Westend — no longer fall back to the default
  icon; icon inheritance now pairs them by spec index.

## [0.5.0]

Metrics-correctness overhaul, verified against the live router with a
controlled ground-truth experiment (exact known load + idle fingerprint).

### Fixed

- **Client-scoped request counts.** "Requests served", per-chain/per-method
  requests and every RPS figure now read the end-to-end latency histogram
  `_count` — the only counter that increments once per client request.
  `smartrouter_requests_total` counts *relays* (cross-validation fan-out,
  cache hits as `provider_address="Cached"`, router tracker probes) and stays
  only behind per-upstream/relay lenses.
- **"Stale responses caught" semantics.** Now reads
  `consistency_failed_total` (checks that FAILED). It previously displayed
  `consistency_success_total` — checks that *passed* — so every healthy read
  counted as a caught stale response.
- **Cross-validation panel never lit up.** The catalog probed a
  `smartrouter_cross_validation_total` family that does not exist; the real
  families are `…cross_validation_{requests,success,failed,failures}_total`
  (+ per-provider agreements/disagreements).
- **Whole-number counts.** `round()` on every count query — request/error/
  retry counts no longer render as `increase()` extrapolation fractions
  ("12.2 retries", "111.7 requests").
- **WebSocket URLs.** The router serves ws only under `/ws` (jsonrpc) /
  `/websocket` (tendermint); Try-now and the endpoint sheets no longer emit
  bare `ws://host:port` URLs that 405.
- **Try-now examples that could never succeed** — placeholder tx hashes,
  a pruned Solana slot, pruned Cosmos heights, an estimateGas call that
  always reverted, `<blockhash>` literals. Subscribe methods are hidden on
  non-ws interfaces. 28/28 curated examples pass against the live stack.
- **Charts.** Availability y-axis can no longer exceed 100%; sub-1 RPS axis
  ticks keep decimals instead of rendering "0"; hotspot error trends use the
  real window timestamps (previously hardcoded −24h labels) and rounded
  buckets; method-table columns no longer collapse under long REST paths.
- **Config.** `dev-config/values.yml`: archive reads corroborate across
  tenderly + mevblocker (publicnode's archive claim removed — token-gated at
  relay despite passing the startup probe); broken cross-validation policies
  removed/corrected (REST method names are path patterns); comments slimmed.

### Added

- **Error-class breakdown** — real code / category / retryability pivots from
  the classified `smartrouter_errors_total{chain_id, error_category,
  error_name, retryable}` family (node/protocol/transport class split as the
  fallback), per-hotspot node-errors-by-method, and a node-vs-transport split
  (+ per-method list and cross-validation agree/disagree rate) in the
  upstream deep-dive.
- **Per-method P95** — the router histogram's method label is named
  `function`; the "no method label" design-doc gap was wrong.
- **Try-now relay badges** — `Lava-Retries` retry indicator and a
  cross-validated badge (agreeing/disagreeing providers from the CORS-exposed
  headers).
- **Upstream availability sub-windows** (fixed 1h/24h/7d) in the deep-dive.
- **WebSocket panel**: lifetime totals (windowed `increase()` misses a young
  counter's first increment), per-chain live connection counts, ws
  subscription examples in the Try-now catalog.
- **Sortable method-level breakdown table.**
- **Verified backup tier** in `dev-config/values.yml` for ETH1 (flashbots),
  HYPERLIQUID (purroofgroup) and COSMOSHUB rest (ecostake), alongside the
  existing tendermint backup — every entry passes router startup
  verification. No keyless distinct-vendor backup exists today for
  SOLANA / BTC / APT1 / COSMOSHUB grpc.
- **Docs**: `docs/METRICS-MAPPING.md` "Counter semantics — ground truth"
  section (relay- vs client-scoped counters, transport-success semantics,
  consistency counter meanings) + refreshed mapping tables.

### Changed

- Success-rate tiles/tooltips now state the transport semantics explicitly:
  an upstream answering with a JSON-RPC error object counts as a successful
  relay (it increments `node_errors_total`, not the failure rate).

## [0.4.1]

### Added

- **Optional relay cache.** An opt-in `cache` profile in both compose files runs
  the smart-router RAM relay cache sidecar (`:20100`, metrics `:5555`), mirroring
  `smart-router/docker/docker-compose.cache.yml`. The router connects via
  `cache-be: "cache:20100"` (commented out by default). Adds a `make up-cache`
  target and a Prometheus `smart-router-cache` scrape job.
- **Linting & formatting.** A root ESLint flat config (`typescript-eslint` +
  `eslint-plugin-react-hooks` + `@next/eslint-plugin-next`) and Prettier, wired
  as `pnpm lint` / `pnpm format`. The Quality Gate now runs `pnpm lint` before
  typecheck + tests. React-Compiler-strictness rules are surfaced as warnings so
  existing patterns are visible without blocking CI.
- **Contributor scaffolding.** `.env.example` (every runtime knob, from
  `config.ts`), `.nvmrc` (Node 24), `.editorconfig`, and an issue-template
  `config.yml` routing security reports and questions off the public tracker.
- README: a **Testing & CI** section, a pointer to the api's `/docs` OpenAPI
  explorer, and `.env.example` / `.nvmrc` references.

### Fixed

- **Router crash-loop.** `dev-config/values.yml` over-declared ETH1 addons
  (`debug`/`trace` on publicnode, which doesn't serve those namespaces); the
  router excluded the provider on startup, dropped ETH1 below the
  cross-validation `min-groups: 2` bar, and crash-looped — leaving the dashboard
  blank. Now advertises only what the upstream serves (`archive` + websocket).
- **Impossible metric values.** The UI showed a 103% success rate and a −2.40%
  error rate. `increase()`/`rate()` extrapolation pushed the success/total ratio
  above 1 on young counters — every availability ratio is now `clamp_max(…, 1)`.
  Also, `deploy/prometheus.yml` scraped the same router twice (`router:7779`
  **and** `host.docker.internal:7779`), so `sum()` double-counted every series;
  collapsed to a single target.
- **Web healthcheck.** Next standalone binds `HOSTNAME=localhost` (IPv6) while
  the Docker healthcheck probes IPv4 `127.0.0.1` → the container reported
  `unhealthy` while serving fine. Set `ENV HOSTNAME=0.0.0.0`.
- **Dependabot alerts.** Pinned transitive `esbuild` (≥0.25.0) and `postcss`
  (≥8.5.10) forward via `pnpm.overrides` to clear two medium build-time
  advisories.
- Root `package.json` `engines.node` was `>=22` while the Dockerfiles, CI, and
  README all target Node 24 — aligned to `>=24`.
- Removed a dead `next lint` script (no ESLint was installed for it), dead
  imports in `metrics-detail.ts` / `OverviewView.tsx`, and a mis-placed
  `eslint-disable` directive in `icons.tsx`; tidied two flagged issues in
  `json-display.tsx`.

## [0.4.0]

### Changed

- **The TypeScript monorepo is now the whole repo.** The `v2/` directory was
  promoted to the repo root — `apps/`, `packages/`, `dev-config/`, the compose
  files, and `Makefile` all live at the top level. The build publishes the api
  as `…/backend` and the web as `…/frontend`, the image names the smart-router
  helm chart already consumes, so no deployment change is needed.

### Removed

- **The legacy v1 stack** (`backend/` Python/FastAPI + `frontend/` Next.js) and
  its root `docker-compose*.yml` / `dev-config/`. The Quality Gate's v1
  `frontend`/`backend` jobs and the separate v2 build job are gone — a single
  build-and-push job remains. `REFACTOR-PLAN.md` (the completed rebuild plan)
  was removed.

### Added

- **Optional authentication** (`AUTH_MODE=enabled`): Auth.js v5 sign-in
  (email+password + conditional Google/GitHub/Discord), Postgres-backed users
  (new `@sr/db` package), HS256 JWT shared between web and api, idempotent
  `ADMIN_EMAIL`/`ADMIN_PASSWORD` bootstrap seed, `postgres:18` compose service
  under the `auth` profile. Default stays `disabled` (open dashboard).
  See `docs/AUTH.md`.
- **Live test: full lava-specs method catalog** — generator reads the
  [lava-specs](https://github.com/Magma-Devs/lava-specs) repo and emits
  126 chain indices across jsonrpc/rest/tendermint/grpc with real
  archive/debug/trace tiers (10,600+ methods).
- Repo standard: dual license (PolyForm Noncommercial + Enterprise),
  CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CODEOWNERS, PR/issue templates,
  dependabot, banner, CI quality-gate job.

### Changed (rebuild)

- Router service pulls `ghcr.io/magma-devs/smart-router:latest` and loads
  specs straight from the lava-specs GitHub repo (no local checkout, no
  spec volume mounts).
- Default dev config is multichain (8 endpoints across 6 chains) with
  cross-validation policies enabled.
- All packages bumped to latest stable; runtime images on `node:24-alpine`.
- Branding: Magma Devs only (Lava marks removed); new banner in the
  smart-router visual family.

## [0.3.1]

Last v1-era tag — Python/FastAPI backend + Next.js frontend with HTTP basic
auth, plus the initial v2 rebuild (Fastify + Next.js 16 monorepo).

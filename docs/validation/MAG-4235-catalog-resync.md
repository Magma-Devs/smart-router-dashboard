# MAG-4235 catalog resync — 2026-10-11

Resynced against [lava-specs commit 1c547bd](https://github.com/Magma-Devs/lava-specs/commit/1c547bd07207e9fac60e3f4c02abb1ee1dfe044c).
This is separate from the health change in PR #234.

- Added KATANA, KATANAT (Bokuto), QTUM and QTUMT.
- Updated SUI/SUID/SUIT interface metadata and TON's method catalog.
- Vendored web3icons MIT glyphs with sourced brand colours; both testnets
  inherit the corresponding mainnet icon. Provenance is in the icon README.
- Added four explorer links. Each `/block/1000` page was opened in a real
  headless Chrome browser and rendered the requested height and network's
  block details. The two Katana pages had network-specific titles; the Qtum
  pages showed different mainnet/testnet genesis-era block hashes.

| Chain | Explorer | Shape | Evidence |
| --- | --- | --- | --- |
| KATANA | https://explorer.katanarpc.com | `/block/<height>` | [Screenshot](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/KATANA-explorer.png) |
| KATANAT | https://explorer-bokuto.katanarpc.com | `/block/<height>` | [Screenshot](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/KATANAT-explorer.png) |
| QTUM | https://qtum.info | `/block/<height>` | [Screenshot](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/QTUM-explorer.png) |
| QTUMT | https://testnet.qtum.info | `/block/<height>` | [Screenshot](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/QTUMT-explorer.png) |

![New chain icons](https://raw.githubusercontent.com/Magma-Devs/smart-router-dashboard/a6e34036e4a20f87f6ea967d9591a097c07eb0e2/icons.png)

All five generated artifacts passed the live `check-spec-sync.mjs` guard.
`pnpm -r test` passed **2,399 tests**; all workspace typechecks and the web
production build passed. Lint had zero errors and 30 existing warnings.
The generator reports **292 chains**, **249 with an explorer**, and **202
primary explorers linking a block height**. No new gap was accepted in the
missing-explorer or runnable-default roll calls. The committed registry
snapshot was not refreshed, so existing unrelated explorer links did not move.

This validates catalog consistency, rendering and explorer links. It does
not claim that every RPC method was exercised against a live Katana or Qtum
provider. Existing family hints provide runnable defaults; methods needing
caller input keep that classification.

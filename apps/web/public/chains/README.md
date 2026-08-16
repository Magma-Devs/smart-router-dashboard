# Chain icons

One SVG per chain, named by the slug `generate-chain-map.mjs` resolves for that
spec (see `resolveIcon()`). `default.svg` is the neutral fallback used when a
chain has no vendored icon — the dashboard degrades to it gracefully, so a
missing file is never a rendering error.

## House style

24×24, a brand-coloured circle, and the glyph scaled to 0.72 and centred:

```svg
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="...">
  <circle cx="12" cy="12" r="12" fill="#BRAND"/>
  <g transform="translate(12 12) scale(0.72) translate(-12 -12)">…glyph…</g>
</svg>
```

The glyph is white on a dark circle, near-black (`#111`) on a light one. A glyph
whose own outline is square (e.g. `neutron`) is inset further than 0.72 so its
diagonal still clears the circle.

## Provenance

Most icons are derived from [`@web3icons`](https://github.com/0xa3k5/web3icons)
(MIT) — the `mono` variant supplies the glyph, and the circle colour is read
from that icon's own `background` variant backdrop, so no colour is invented.
Where web3icons has no `networks/` entry it has the chain's token: `concordium`
(CCD), `vechain` (VET), `zcash` (ZEC), `oasis` (ROSE), `hydration` (HDX) and
`ion` (ICE) come from `tokens/mono/`. When the backdrop is a gradient rather
than a flat fill (VET, HDX) the circle takes one of that gradient's own stops.
`neutron` and `babylon` come from
[`cosmos/chain-registry`](https://github.com/cosmos/chain-registry) (Apache-2.0).

Where web3icons has no entry at all, the glyph is reduced from the project's own
brand asset. `canton` is the swept-diamond "C" from
[canton.network](https://www.canton.network)'s logo, collapsed to its silhouette
— a 270° arc with the radial butt caps the diamond sweep produces — with the
circle taking that logo's own black, and the glyph its lime. `tsc` is the
silhouette of the Trusted Smart Chain gem traced from the mark on
[trustedsmartchain.com](https://trustedsmartchain.com); its logo is a gold-to-blue
gradient, so per the rule above the circle takes the blue stop.

`race` (and its testnet) are the only entries still on `default.svg` — the
project publishes a wordmark only, which is illegible at icon size.

Chain logos remain the trademarks of their respective projects and are used here
only to identify the chain.

## Adding one

Usually you are here because a chain resync brought in a chain with no icon —
`generate-chain-map.mjs` names them under `no icon` in its summary, and
[`.claude/rules/chain-resync.md`](../../../../.claude/rules/chain-resync.md)
covers where vendoring fits in that procedure.

Drop `<slug>.svg` in this directory following the house style, then re-run
`node apps/web/scripts/generate-chain-map.mjs` and commit the regenerated map.
Adding a **mainnet** icon is usually enough — testnet siblings inherit it, by
base name first and then by index prefix (`BERAB` → `BERA`), so a testnet with
its own brand ("Bepolia", "Shibuya", "Westend") is covered too.

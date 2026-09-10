# Treasury Market Simulator

An interactive, browser-based simulator of the US Treasury nominal coupon market
(2y, 3y, 5y, 7y, 10y, 20y, 30y): yield-curve dynamics, issuance and CUSIP
lifecycle, auction mechanics, on/off-the-run liquidity premia, the Treasury
buyback program, and stress regimes.

The engine is dependency-free TypeScript so the whole simulation runs client-side
and the site can be hosted on GitHub Pages with live sliders.

## Development

```bash
npm install
npm run dev      # local dev server
npm test         # vitest checkpoints
npm run build    # typecheck + production build
```

## Layout

- `src/engine/` — simulation engine (config, clock, rng, curve, bonds, issuance, auctions, liquidity, buybacks, stress, analytics)
- `src/ui/` — React dashboard
- `tests/` — one test file per build-plan checkpoint

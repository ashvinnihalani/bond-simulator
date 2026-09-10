# Treasury Market Simulator

An interactive, browser-based simulator of the US Treasury nominal coupon market
(2y, 3y, 5y, 7y, 10y, 20y, 30y) at a daily time step: yield-curve dynamics,
issuance and CUSIP lifecycle, auction mechanics, on/off-the-run liquidity premia,
the Treasury buyback program, and liquidity stress regimes. Bills exist only as a
funding channel.

The engine is dependency-free TypeScript, so the whole simulation runs client-side
in a Web Worker and the site is hosted on GitHub Pages with live sliders: change
an input, press **Rerun**, and every dependent chart updates.

## Running it

```bash
npm install
npm run dev        # local dev server
npm test           # checkpoint tests, one file per build-plan phase
npm run build      # typecheck + production bundle in dist/
npm run preview    # serve the production bundle
```

### Publishing to GitHub Pages

The workflow in `.github/workflows/deploy.yml` builds and deploys on every push
to `main`. One-time setup: in the repository settings open **Pages** and set the
source to **GitHub Actions**. The site is then served at
`https://<owner>.github.io/bond-simulator/` (the workflow sets the Vite base path
from the repository name).

## What the model does

| Module | File | Mechanism |
|---|---|---|
| Clock & RNG | `clock.ts`, `rng.ts` | SIFMA-style business-day calendar, quarterly refunding dates; xoshiro128** with one named substream per module, so any module can be switched off without perturbing the others' draws. |
| Curve | `curve.ts`, `policy.ts` | Nelson-Siegel zero curve; level/slope/curvature follow correlated mean-reverting AR(1) processes; the short end is pulled toward policy rate + spread; a term premium lifts the long end; par yields, discount factors, forwards and a par-yield bootstrap. |
| Bonds | `bond.ts` | ACT/ACT semi-annual coupon bonds: clean/dirty price, street-convention yield, accrued, duration, convexity, DV01; priced off the fitted curve with an idiosyncratic spread applied as a parallel zero shift; coupons rounded down to 1/8 at auction. |
| Issuance | `issuance.ts` | Auction calendar approximating the Treasury pattern (monthly 2/3/5/7; quarterly new 10/20/30 with two reopenings), when-issued window, CUSIP minting, status chain WI → OTR → old → double-old → off-run → retired, ledger and Treasury cash, 30-year history seeding. |
| Auctions | `auction.ts` | Demand curve in yield space; stop-out yield where cumulative demand meets supply; tail, bid-to-cover and take-down shares conditioned on supply-to-capacity and stress; tails pass through to the new OTR as a decaying shock. |
| Liquidity | `liquidity.ts` | Spread = −richness·e^(−age/h)·stress − repo-feedback + aging cheapness + AR(1) noise; repo specialness proportional to richness; daily OTR − old / double-old / fitted deltas; an off-the-run fitted curve as an alternative benchmark. |
| Buybacks | `buyback.ts` | Seven remaining-maturity buckets; quarterly liquidity-support schedule plus cash-management operations before tax dates; eligibility rules; dealer offers rising in cheapness; reverse auction ranked by cheapness to the curve under a reservation spread; supply reduction, spread compression, spillover richening, anticipation, bill/coupon funding with carry-forward. |
| Stress | `stress.ts` | Calm / elevated / crisis Markov chain with scripted overrides; multipliers on curve vol, dealer capacity, tails, OTR richness and offer volume. |
| Analytics | `analytics.ts` | 2s10s / 5s30s / butterfly, carry and roll-down per CUSIP, buyback metrics (savings vs curve, DV01 removed and funded), roll-down tracker with buyback probability, batch runner with quantile bands. |
| Calibration | `calibrate.ts`, `scripts/calibrate.ts` | Fit Nelson-Siegel factors and AR(1) dynamics to historical yields (FRED CSV) and buyback parameters to published operation results; compare simulated and historical moments. |

Every tunable input lives in `src/engine/config.ts` with documented defaults.
`makeConfig(overrides)` deep-merges a partial config onto them. The dashboard's
**Config JSON** export writes exactly the object that produced a run.

### Calibrating to history

```bash
# CSV from FRED with DGS1MO … DGS30 columns
npm run calibrate -- path/to/fred.csv 1.8 > calibration.json
```

The output contains historical moments and a config overlay for the curve
factors. Paste the overlay into `makeConfig()` or merge it into an exported
config.

## Layout

- `src/engine/` — simulation engine (no browser dependencies)
- `src/ui/` — React dashboard, Web Worker, chart builders, exports
- `tests/` — one Vitest file per build-plan checkpoint (`phase0` … `phase10`)
- `scripts/` — command-line calibration

## Core assumptions

No default risk, single currency, a smooth fitted curve always exists. The
liquidity premium is reduced-form rather than emergent from agents. Treasury's
buyback fair-value curve equals the simulator's fitted curve. Dealers offer
their cheapest holdings first. Buybacks change idiosyncratic spreads and supply
only, not macro curve factors. No taxes, settlement fails, seasonality, or
TIPS/FRN/STRIPS dynamics. Defaults are illustrative and roughly track 2025–26
issuance sizes; they are not calibrated to a specific period.

/**
 * Calibrate curve dynamics from a FRED CSV of constant-maturity yields.
 *
 *   npm run calibrate -- path/to/fred.csv [lambda] > calibration.json
 *
 * Download the CSV from https://fred.stlouisfed.org with series
 * DGS1MO, DGS3MO, DGS6MO, DGS1, DGS2, DGS3, DGS5, DGS7, DGS10, DGS20, DGS30.
 * The output is a partial config you can paste into makeConfig() or import
 * through the dashboard's config JSON.
 */
import { readFileSync } from "node:fs";
import { calibrateCurve, parseYieldCsv, moments } from "../src/engine";

const [, , file, lambdaArg] = process.argv;
if (!file) {
  console.error("usage: npm run calibrate -- <fred.csv> [lambda]");
  process.exit(1);
}
const history = parseYieldCsv(readFileSync(file, "utf8"));
const cal = calibrateCurve(history, lambdaArg ? Number(lambdaArg) : 1.8);
const y10 = history.map((h) => h.yields[10]).filter((v) => v !== undefined);
const y2 = history.map((h) => h.yields[2]).filter((v) => v !== undefined);
const spread = y10.map((v, i) => (v - y2[i]) * 1e4);
console.log(
  JSON.stringify(
    {
      observations: history.length,
      meanFitRmseBp: cal.series.rmseBp.reduce((a, b) => a + b, 0) / cal.series.rmseBp.length,
      historicalMoments: { y10Bp: moments(y10.map((v) => v * 1e4)), twosTensBp: moments(spread) },
      overlay: cal.overlay,
    },
    null,
    2,
  ),
);

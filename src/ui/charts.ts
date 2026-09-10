/**
 * Figure builders for every chart in Appendix B. Each takes the worker-built
 * ChartData plus theme tokens and returns Plotly traces + layout.
 */
import type { Data, Layout, Shape } from "plotly.js";
import { TENORS, type Tenor } from "../engine";
import type { ChartData } from "./dashboardData";
import type { Figure } from "./Plot";
import { baseLayout, LINE_WIDTH, MARKER_SIZE, SEQUENTIAL_BLUE, tenorColor, type Tokens } from "./theme";

const bp = (v: number) => v * 1e4;

function regimeShapes(d: ChartData, t: Tokens): Partial<Shape>[] {
  const shapes: Partial<Shape>[] = [];
  const r = d.curve.regime;
  let start = -1;
  let cur = 0;
  for (let i = 0; i <= r.length; i++) {
    const v = i < r.length ? r[i] : -1;
    if (v !== cur) {
      if (cur > 0 && start >= 0) {
        shapes.push({ type: "rect", xref: "x", yref: "paper", x0: d.meta.dates[start], x1: d.meta.dates[Math.min(i, r.length - 1)], y0: 0, y1: 1, fillcolor: cur === 2 ? t.crisis : t.elevated, line: { width: 0 }, layer: "below" });
      }
      start = i;
      cur = v;
    }
  }
  return shapes;
}

function line(name: string, x: ArrayLike<unknown>, y: ArrayLike<number>, color: string, extra: Partial<Data> = {}): Data {
  return { type: "scatter", mode: "lines", name, x: Array.from(x as ArrayLike<string>), y: Array.from(y), line: { color, width: LINE_WIDTH }, ...extra } as Data;
}

function endLabel(name: string, x: unknown, y: number, color: string): Data {
  return { type: "scatter", mode: "text", x: [x], y: [y], text: [name], textposition: "middle right", textfont: { color, size: 11 }, showlegend: false, hoverinfo: "skip" } as Data;
}

// 1. Fitted curve snapshot with OTR points (animated via day slider)
export function curveSnapshot(d: ChartData, t: Tokens, snap: number): Figure {
  const day = d.otr.dayIdx[snap];
  const k = d.meta.keyTenors.length;
  const par = Array.from(d.curve.parYields.subarray(day * k, day * k + k), bp);
  const otrX: number[] = [];
  const otrY: number[] = [];
  const otrText: string[] = [];
  TENORS.forEach((tenor, ti) => {
    const rem = d.otr.remYears[snap * 7 + ti];
    if (Number.isNaN(rem)) return;
    otrX.push(rem);
    otrY.push(bp(d.otr.ytm[snap * 7 + ti]));
    otrText.push(`${tenor}y OTR · ${d.otr.spreadBp[snap * 7 + ti].toFixed(1)}bp vs curve`);
  });
  const data: Data[] = [
    line("Fitted par curve", d.meta.keyTenors, par, t.series[0], { hovertemplate: "%{x:.2f}y · %{y:.1f}bp<extra></extra>" }),
    { type: "scatter", mode: "markers", name: "On-the-run", x: otrX, y: otrY, text: otrText, hovertemplate: "%{text}<extra></extra>", marker: { color: t.series[1], size: MARKER_SIZE, line: { color: t.surface, width: 2 } } } as Data,
  ];
  return {
    id: "curve-snapshot",
    title: `Fitted curve with on-the-run points — ${d.meta.dates[day]}`,
    data,
    layout: baseLayout(t, {
      xaxis: { title: { text: "Maturity (years)" }, type: "log", tickvals: [1 / 12, 0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30], ticktext: ["1m", "3m", "6m", "1y", "2y", "3y", "5y", "7y", "10y", "20y", "30y"] },
      yaxis: { title: { text: "Par yield (bp)" } },
      hovermode: "closest",
    }),
  };
}

// 2. Yield surface heatmap
export function yieldSurface(d: ChartData, t: Tokens): Figure {
  const k = d.meta.keyTenors.length;
  const stride = Math.max(1, Math.floor(d.meta.nDays / 400));
  const x: string[] = [];
  const z: number[][] = d.meta.keyTenors.map(() => []);
  for (let i = 0; i < d.meta.nDays; i += stride) {
    x.push(d.meta.dates[i]);
    for (let j = 0; j < k; j++) z[j].push(d.curve.parYields[i * k + j] * 100);
  }
  return {
    id: "yield-surface",
    title: "Yield surface: par yield (%) by tenor over time",
    data: [{ type: "heatmap", x, y: d.meta.keyTenors.map((v) => (v < 1 ? `${Math.round(v * 12)}m` : `${v}y`)), z, colorscale: SEQUENTIAL_BLUE.map((c, i) => [i / (SEQUENTIAL_BLUE.length - 1), c]), colorbar: { title: { text: "%" }, thickness: 10, tickfont: { color: t.muted } }, hovertemplate: "%{x} · %{y}: %{z:.2f}%<extra></extra>" } as Data],
    layout: baseLayout(t, { hovermode: "closest", yaxis: { type: "category", title: { text: "Tenor" } } }),
  };
}

// 3. Factor paths and policy rate
export function factorPaths(d: ChartData, t: Tokens): Figure {
  const x = d.meta.dates;
  const last = x.length - 1;
  return {
    id: "factors",
    title: "Nelson-Siegel factors and policy rate (bp)",
    data: [
      line("Level", x, Array.from(d.curve.level, bp), t.series[0]),
      line("Slope", x, Array.from(d.curve.slope, bp), t.series[1]),
      line("Curvature", x, Array.from(d.curve.curvature, bp), t.series[2]),
      line("Policy rate", x, Array.from(d.curve.policyRate, bp), t.ink2, { line: { color: t.ink2, width: LINE_WIDTH, dash: "dot" } }),
      endLabel("Level", x[last], bp(d.curve.level[last]), t.series[0]),
      endLabel("Policy", x[last], bp(d.curve.policyRate[last]), t.ink2),
    ],
    layout: baseLayout(t, { shapes: regimeShapes(d, t), yaxis: { title: { text: "bp" } } }),
  };
}

// 4. Curve spreads
export function curveSpreads(d: ChartData, t: Tokens): Figure {
  const x = d.meta.dates;
  return {
    id: "curve-spreads",
    title: "2s10s, 5s30s and 2s5s10s butterfly (bp)",
    data: [line("2s10s", x, d.curve.twosTens, t.series[0]), line("5s30s", x, d.curve.fivesThirties, t.series[1]), line("2s5s10s fly", x, d.curve.butterfly, t.series[2])],
    layout: baseLayout(t, { shapes: regimeShapes(d, t), yaxis: { title: { text: "bp" } } }),
  };
}

// 5. Per-tenor on/off deltas
export function onOffDeltas(d: ChartData, t: Tokens, which: "otrMinusOld" | "otrMinusFitted"): Figure {
  const x = d.meta.dates;
  const data: Data[] = TENORS.map((tenor) => line(`${tenor}y`, x, d.onOff[tenor][which], tenorColor(t, tenor)));
  return {
    id: which === "otrMinusOld" ? "onoff-old" : "onoff-fitted",
    title: which === "otrMinusOld" ? "On/off-the-run: OTR yield minus old (curve-adjusted, bp)" : "On/off-the-run: OTR yield minus fitted curve (bp)",
    data,
    layout: baseLayout(t, { shapes: regimeShapes(d, t), yaxis: { title: { text: "bp (negative = OTR rich)" } } }),
  };
}

// 6. Single-CUSIP lifecycle
export function lifecycle(d: ChartData, t: Tokens, bondId: string): Figure {
  const s = d.lifecycle.find((l) => l.id === bondId) ?? d.lifecycle[0];
  if (!s) return { id: "lifecycle", title: "CUSIP lifecycle", data: [], layout: baseLayout(t) };
  const x = Array.from(s.dayIdx, (i) => d.meta.dates[i]);
  const y = Array.from(s.spreadBp);
  const statusName = ["WI", "OTR", "old", "double-old", "off-run", "retired"];
  const marker = (name: string, days: number[], color: string, symbol: string): Data => ({
    type: "scatter",
    mode: "markers",
    name,
    x: days.map((i) => d.meta.dates[i]),
    y: days.map((i) => {
      const k = Array.from(s.dayIdx).findIndex((v) => v >= i);
      return k >= 0 ? y[k] : 0;
    }),
    marker: { color, size: MARKER_SIZE + 2, symbol, line: { color: t.surface, width: 2 } },
  }) as Data;
  const color = tenorColor(t, s.tenor);
  return {
    id: "lifecycle",
    title: `Lifecycle of ${s.id}: spread to fitted curve (bp) from WI onward`,
    data: [
      { type: "scatter", mode: "lines", name: "Spread to curve", x, y, line: { color, width: LINE_WIDTH }, text: Array.from(s.status, (v) => statusName[v]), hovertemplate: "%{x}<br>%{y:.2f}bp · %{text}<extra></extra>" } as Data,
      marker("Auction", [s.auctionDayIdx].filter((v) => v >= 0), t.series[0], "diamond"),
      marker("Reopening", s.reopenDayIdx.filter((v) => v >= 0), t.series[3], "square"),
      marker("Buyback", s.buybackDayIdx.filter((v) => v >= 0), t.series[6], "triangle-down"),
    ],
    layout: baseLayout(t, { shapes: regimeShapes(d, t), yaxis: { title: { text: "bp (negative = rich)" } }, hovermode: "closest" }),
  };
}

// 7. Auction dashboard (three small multiples on one axis system each)
export function auctionDashboard(d: ChartData, t: Tokens, field: "tailBp" | "bidToCover" | "dealerShare"): Figure {
  const titles = { tailBp: "Auction tails by tenor (bp, positive = weak)", bidToCover: "Bid-to-cover by tenor", dealerShare: "Dealer take-down share by tenor" };
  const data: Data[] = TENORS.map((tenor) => {
    const a = d.auctions.filter((x) => x.tenor === tenor);
    return {
      type: "scatter",
      mode: "markers",
      name: `${tenor}y`,
      x: a.map((x) => d.meta.dates[x.dayIdx]),
      y: a.map((x) => x[field]),
      text: a.map((x) => `${x.bondId}${x.isReopen ? " (reopen)" : ""} · size $${x.size.toFixed(0)}bn`),
      hovertemplate: "%{x} · %{text}<br>%{y:.2f}<extra></extra>",
      marker: { color: tenorColor(t, tenor), size: MARKER_SIZE - 1, symbol: tenor >= 10 ? "diamond" : "circle", line: { color: t.surface, width: 1.5 } },
    } as Data;
  });
  return { id: `auction-${field}`, title: titles[field], data, layout: baseLayout(t, { shapes: regimeShapes(d, t), hovermode: "closest", yaxis: { title: { text: field === "tailBp" ? "bp" : field === "bidToCover" ? "×" : "share" } } }) };
}

// 8. OTR repo specialness vs richness (10y)
export function specialness(d: ChartData, t: Tokens): Figure {
  const x = d.meta.dates;
  const s = d.onOff[10];
  return {
    id: "specialness",
    title: "10y OTR: repo specialness and richness (bp)",
    data: [line("Repo specialness", x, s.specialness, t.series[0]), line("Richness (−spread to curve)", x, Array.from(s.otrMinusFitted, (v) => -v), t.series[1])],
    layout: baseLayout(t, { shapes: regimeShapes(d, t), yaxis: { title: { text: "bp" } } }),
  };
}

export function specialnessScatter(d: ChartData, t: Tokens): Figure {
  const s = d.onOff[10];
  const idx = Array.from({ length: d.meta.nDays }, (_, i) => i).filter((i) => i % 3 === 0);
  return {
    id: "specialness-scatter",
    title: "10y OTR: specialness versus richness (each point one day)",
    data: [{ type: "scatter", mode: "markers", name: "Days", x: idx.map((i) => -s.otrMinusFitted[i]), y: idx.map((i) => s.specialness[i]), text: idx.map((i) => d.meta.dates[i]), hovertemplate: "%{text}<br>richness %{x:.1f}bp · special %{y:.1f}bp<extra></extra>", marker: { color: t.series[0], size: 6, opacity: 0.7 } } as Data],
    layout: baseLayout(t, { hovermode: "closest", xaxis: { title: { text: "Richness (bp)" } }, yaxis: { title: { text: "Specialness (bp)" } } }),
  };
}

// 9. Supply ladder with buyback retirements
export function supplyLadderFig(d: ChartData, t: Tokens, snap: number): Figure {
  const day = d.ladder.dayIdx[snap];
  return {
    id: "supply-ladder",
    title: `Outstanding by maturity year ($bn) — ${d.meta.dates[day]}`,
    data: [
      { type: "bar", name: "Outstanding", x: d.ladder.years, y: Array.from(d.ladder.outstanding[snap]), marker: { color: t.series[0] }, hovertemplate: "%{x}: $%{y:.0f}bn<extra></extra>" } as Data,
      { type: "bar", name: "Bought back", x: d.ladder.years, y: Array.from(d.ladder.boughtBack[snap]), marker: { color: t.series[6] }, hovertemplate: "%{x}: $%{y:.1f}bn bought back<extra></extra>" } as Data,
    ],
    layout: baseLayout(t, { barmode: "stack", bargap: 0.15, hovermode: "x", xaxis: { title: { text: "Maturity year" } }, yaxis: { title: { text: "$bn" } } }),
  };
}

// 10. Buyback operation results per bucket
export function buybackOps(d: ChartData, t: Tokens, field: "amounts" | "fill" | "spread"): Figure {
  const ops = d.buyback.operations;
  const x = ops.map((o) => d.meta.dates[o.dayIdx]);
  const text = ops.map((o) => `${o.bucketName} · ${o.kind}`);
  if (field === "amounts") {
    return {
      id: "buyback-amounts",
      title: "Buyback operations: offered versus accepted ($bn)",
      data: [
        { type: "scatter", mode: "markers", name: "Offered", x, y: ops.map((o) => o.offered), text, hovertemplate: "%{x} · %{text}<br>offered $%{y:.2f}bn<extra></extra>", marker: { color: t.surface, size: MARKER_SIZE, line: { color: t.series[0], width: 2 } } } as Data,
        { type: "scatter", mode: "markers", name: "Accepted", x, y: ops.map((o) => o.accepted), text, hovertemplate: "%{x} · %{text}<br>accepted $%{y:.2f}bn<extra></extra>", marker: { color: t.series[0], size: MARKER_SIZE, line: { color: t.surface, width: 1.5 } } } as Data,
      ],
      layout: baseLayout(t, { hovermode: "closest", yaxis: { title: { text: "$bn" }, rangemode: "tozero" } }),
    };
  }
  const buckets = d.meta.bucketNames;
  const data: Data[] = buckets.map((name, bi) => {
    const o = ops.filter((op) => op.bucket === bi && op.offered > 0);
    return {
      type: "scatter",
      mode: "markers",
      name,
      x: o.map((op) => d.meta.dates[op.dayIdx]),
      y: o.map((op) => (field === "fill" ? op.fillRate * 100 : op.weightedSpreadBp)),
      text: o.map((op) => `${op.kind} · accepted $${op.accepted.toFixed(2)}bn of $${op.offered.toFixed(2)}bn`),
      hovertemplate: "%{x} · %{text}<br>%{y:.1f}<extra></extra>",
      marker: { color: t.series[bi % t.series.length], size: MARKER_SIZE - 1, line: { color: t.surface, width: 1.5 } },
    } as Data;
  });
  return {
    id: field === "fill" ? "buyback-fill" : "buyback-spread",
    title: field === "fill" ? "Buyback fill rate by bucket (% of offered)" : "Buyback accepted spread to curve by bucket (bp)",
    data,
    layout: baseLayout(t, { hovermode: "closest", yaxis: { title: { text: field === "fill" ? "%" : "bp" } } }),
  };
}

// 11. Buyback on vs off
export function buybackCompare(d: ChartData, t: Tokens): Figure {
  const x = d.meta.dates;
  if (!d.compare) return { id: "compare", title: "Buybacks on vs off", data: [], layout: baseLayout(t) };
  return {
    id: "compare",
    title: "Aggregate off-the-run cheapness, 2y–10y buckets (bp): buybacks on vs off, same seed",
    data: [line("Buybacks on", x, d.compare.cheapnessOn, t.series[0]), line("Buybacks off", x, d.compare.cheapnessOff, t.series[1])],
    layout: baseLayout(t, { shapes: regimeShapes(d, t), yaxis: { title: { text: "bp (positive = cheap)" } } }),
  };
}

// 12. Stress vs on/off spread with dampening overlay
export function stressOverlay(d: ChartData, t: Tokens): Figure {
  const x = d.meta.dates;
  const data: Data[] = [];
  if (d.compare) {
    data.push(line("10y OTR − curve, buybacks on", x, d.compare.onOff10On, t.series[0]));
    data.push(line("10y OTR − curve, buybacks off", x, d.compare.onOff10Off, t.series[1]));
  } else {
    data.push(line("10y OTR − curve", x, d.onOff[10].otrMinusFitted, t.series[0]));
  }
  return {
    id: "stress",
    title: "Stress regime (shaded) versus 10y on/off spread (bp)",
    data,
    layout: baseLayout(t, { shapes: regimeShapes(d, t), yaxis: { title: { text: "bp (negative = OTR rich)" } } }),
  };
}

// 13. Roll-down tracker
export function rolldownFig(d: ChartData, t: Tokens, which: "rem" | "prob"): Figure {
  const p = d.rolldown.points;
  const realised = p.filter((q) => !q.projected);
  const projected = p.filter((q) => q.projected);
  const xr = realised.map((q) => q.ageYears);
  const xp = projected.map((q) => q.ageYears);
  const pick = (q: (typeof p)[0]) => (which === "rem" ? q.remYears : q.buybackProbPerOp * 100);
  const data: Data[] = [
    { type: "scatter", mode: "lines", name: "Realised", x: xr, y: realised.map(pick), line: { color: t.series[0], width: LINE_WIDTH }, text: realised.map((q) => `${d.meta.bucketNames[q.bucket] ?? "—"} · ${q.spreadBp.toFixed(1)}bp`), hovertemplate: "age %{x:.2f}y · %{y:.2f}<br>%{text}<extra></extra>" } as Data,
    { type: "scatter", mode: "lines", name: "Projected", x: xp, y: projected.map(pick), line: { color: t.series[0], width: LINE_WIDTH, dash: "dash" }, text: projected.map((q) => `${d.meta.bucketNames[q.bucket] ?? "—"} · ${q.spreadBp.toFixed(1)}bp`), hovertemplate: "age %{x:.2f}y · %{y:.2f}<br>%{text}<extra></extra>" } as Data,
  ];
  const shapes: Partial<Shape>[] = [];
  if (which === "rem") {
    const bucket = d.config.buyback.buckets[0];
    shapes.push({ type: "rect", xref: "paper", yref: "y", x0: 0, x1: 1, y0: bucket.lo, y1: bucket.hi, fillcolor: t.elevated, line: { width: 0 }, layer: "below" });
  }
  return {
    id: which === "rem" ? "rolldown-path" : "rolldown-prob",
    title: which === "rem" ? `Roll-down path of ${d.rolldown.bondId}: remaining maturity by age (1mo–2y bucket shaded)` : `Modeled buyback probability per operation for ${d.rolldown.bondId} (%)`,
    data,
    layout: baseLayout(t, { shapes, hovermode: "closest", xaxis: { title: { text: "Age (years)" } }, yaxis: { title: { text: which === "rem" ? "Remaining maturity (years)" : "% per operation" } } }),
  };
}

// 14. Carry and roll-down by CUSIP
export function carryFig(d: ChartData, t: Tokens): Figure {
  const rows = d.carry.rows;
  const x = rows.map((r) => r.id);
  return {
    id: "carry",
    title: `1-day carry and roll-down by CUSIP (per 100 face) — ${d.meta.dates[d.carry.dayIdx]}`,
    data: [
      { type: "bar", name: "Carry", x, y: rows.map((r) => r.carry), marker: { color: t.series[0] }, text: rows.map((r) => `${r.tenor}y · ${r.status} · ${r.remYears.toFixed(1)}y left`), hovertemplate: "%{x} · %{text}<br>carry %{y:.4f}<extra></extra>" } as Data,
      { type: "bar", name: "Roll-down", x, y: rows.map((r) => r.rolldown), marker: { color: t.series[2] }, text: rows.map((r) => `${r.tenor}y · ${r.status}`), hovertemplate: "%{x} · %{text}<br>roll-down %{y:.4f}<extra></extra>" } as Data,
    ],
    layout: baseLayout(t, { barmode: "stack", bargap: 0.1, hovermode: "closest", xaxis: { showticklabels: false, title: { text: "CUSIPs ordered by remaining maturity" } }, yaxis: { title: { text: "per 100" } } }),
  };
}

// 15. Fan charts
export function fanFig(d: ChartData, t: Tokens, which: "y10" | "onOff10" | "twosTens"): Figure {
  const titles = { y10: "10y yield across seeds (bp): median with 25–75% and 5–95% bands", onOff10: "10y on/off spread across seeds (bp): median with 25–75% and 5–95% bands", twosTens: "2s10s across seeds (bp): median with 25–75% and 5–95% bands" };
  if (!d.fans) return { id: `fan-${which}`, title: titles[which], data: [], layout: baseLayout(t) };
  const x = d.meta.dates;
  const bands = d.fans[which];
  const conv = which === "y10" ? bp : (v: number) => v;
  const band = (lo: Float64Array, hi: Float64Array, name: string, alpha: number): Data[] => [
    { type: "scatter", mode: "lines", x, y: Array.from(lo, conv), line: { width: 0 }, showlegend: false, hoverinfo: "skip" } as Data,
    { type: "scatter", mode: "lines", name, x, y: Array.from(hi, conv), fill: "tonexty", fillcolor: `rgba(42,120,214,${alpha})`, line: { width: 0 }, hoverinfo: "skip" } as Data,
  ];
  return {
    id: `fan-${which}`,
    title: `${titles[which]} · ${d.fans.seeds} seeds`,
    data: [...band(bands[0], bands[4], "5–95%", 0.16), ...band(bands[1], bands[3], "25–75%", 0.3), line("Median", x, Array.from(bands[2], conv), t.series[0]), line("This seed", x, which === "y10" ? Array.from(d.curve.parYields.filter((_, i) => i % d.meta.keyTenors.length === d.meta.keyTenors.indexOf(10)), bp) : which === "onOff10" ? d.onOff[10].otrMinusFitted : d.curve.twosTens, t.series[1], { line: { color: t.series[1], width: 1.5 } })],
    layout: baseLayout(t, { yaxis: { title: { text: "bp" } } }),
  };
}

// Off-run curve versus NS
export function offRunFitFig(d: ChartData, t: Tokens): Figure {
  const x = d.offRunFit.dayIdx.map((i) => d.meta.dates[i]);
  return {
    id: "offrun-fit",
    title: "Off-the-run fitted curve minus Nelson-Siegel curve at key tenors (bp)",
    data: [2, 5, 10, 30].map((tau, k) => line(`${tau}y`, x, d.offRunFit.deltaBp[tau], t.series[k])),
    layout: baseLayout(t, { yaxis: { title: { text: "bp" } } }),
  };
}

export function bucketCheapnessFig(d: ChartData, t: Tokens): Figure {
  const x = d.buyback.cheapness.dayIdx.map((i) => d.meta.dates[i]);
  return {
    id: "bucket-cheapness",
    title: "Mean off-the-run spread to curve by buyback bucket (bp)",
    data: d.buyback.cheapness.series.map((s, k) => line(d.meta.bucketNames[k], x, s, t.series[k % t.series.length])),
    layout: baseLayout(t, { shapes: regimeShapes(d, t), yaxis: { title: { text: "bp (positive = cheap)" } } }),
  };
}

export type { Tenor };

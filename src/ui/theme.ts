/**
 * Visual tokens: a validated categorical palette (fixed slot order), chart
 * chrome, and the Plotly layout template for light and dark surfaces.
 */
import type { Layout } from "plotly.js";
import type { Tenor } from "../engine";

export type Mode = "light" | "dark";

const CATEGORICAL: Record<Mode, string[]> = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

export const SEQUENTIAL_BLUE = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

export interface Tokens {
  mode: Mode;
  surface: string;
  page: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  border: string;
  series: string[];
  /** Regime shading (sequential gray). */
  elevated: string;
  crisis: string;
  good: string;
  critical: string;
}

export function tokens(mode: Mode): Tokens {
  const light = mode === "light";
  return {
    mode,
    surface: light ? "#fcfcfb" : "#1a1a19",
    page: light ? "#f9f9f7" : "#0d0d0d",
    ink: light ? "#0b0b0b" : "#ffffff",
    ink2: light ? "#52514e" : "#c3c2b7",
    muted: "#898781",
    grid: light ? "#e1e0d9" : "#2c2c2a",
    axis: light ? "#c3c2b7" : "#383835",
    border: light ? "rgba(11,11,11,0.10)" : "rgba(255,255,255,0.10)",
    series: CATEGORICAL[mode],
    elevated: light ? "rgba(137,135,129,0.14)" : "rgba(195,194,183,0.14)",
    crisis: light ? "rgba(137,135,129,0.32)" : "rgba(195,194,183,0.30)",
    good: light ? "#006300" : "#0ca30c",
    critical: "#d03b3b",
  };
}

/** Fixed slot per tenor: colour follows the entity, never its rank. */
const TENOR_SLOT: Record<Tenor, number> = { 2: 0, 3: 1, 5: 2, 7: 3, 10: 4, 20: 5, 30: 6 };

export function tenorColor(t: Tokens, tenor: Tenor): string {
  return t.series[TENOR_SLOT[tenor]];
}

export function baseLayout(t: Tokens, overrides: Partial<Layout> = {}): Partial<Layout> {
  const axis = {
    gridcolor: t.grid,
    zeroline: false,
    linecolor: t.axis,
    tickcolor: t.axis,
    tickfont: { color: t.muted, size: 11 },
    title: { font: { color: t.ink2, size: 12 } },
    automargin: true,
  };
  return {
    paper_bgcolor: t.surface,
    plot_bgcolor: t.surface,
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: t.ink2, size: 12 },
    margin: { l: 56, r: 24, t: 36, b: 44 },
    hovermode: "x unified",
    hoverlabel: { bgcolor: t.surface, bordercolor: t.axis, font: { color: t.ink, size: 12 } },
    legend: { orientation: "h", y: -0.18, x: 0, font: { color: t.ink2, size: 11 }, bgcolor: "rgba(0,0,0,0)" },
    xaxis: axis,
    yaxis: axis,
    ...overrides,
  } as Partial<Layout>;
}

export const LINE_WIDTH = 2;
export const MARKER_SIZE = 8;

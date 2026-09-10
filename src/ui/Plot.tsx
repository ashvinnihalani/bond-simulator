import { useEffect, useRef } from "react";
import Plotly from "plotly.js-cartesian-dist-min";
import type { Data, Layout } from "plotly.js";
import { registerFigure, unregisterFigure } from "./export";

export interface Figure {
  id: string;
  title: string;
  data: Data[];
  layout: Partial<Layout>;
  height?: number;
}

/** Thin wrapper around Plotly.react that keeps the figure registered for export. */
export function Plot({ fig }: { fig: Figure }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const layout = { ...fig.layout, height: fig.height ?? 340, title: undefined };
    void Plotly.react(el, fig.data, layout, {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
      toImageButtonOptions: { format: "png", filename: fig.id, scale: 2 },
    });
    registerFigure(fig.id, { title: fig.title, data: fig.data, layout });
    return () => unregisterFigure(fig.id);
  }, [fig]);
  return (
    <figure className="chart">
      <figcaption>{fig.title}</figcaption>
      <div ref={ref} />
    </figure>
  );
}

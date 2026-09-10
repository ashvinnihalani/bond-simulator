import { useEffect, useRef, useState } from "react";
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

const PLOT_CONFIG = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"] as ("lasso2d" | "select2d" | "autoScale2d")[],
};

/** Thin wrapper around Plotly.react that keeps the figure registered for export and offers a full-screen view. */
export function Plot({ fig }: { fig: Figure }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const layout = { ...fig.layout, height: fig.height ?? 340, title: undefined };
    void Plotly.react(el, fig.data, layout, { ...PLOT_CONFIG, toImageButtonOptions: { format: "png", filename: fig.id, scale: 2 } });
    registerFigure(fig.id, { title: fig.title, data: fig.data, layout });
    return () => unregisterFigure(fig.id);
  }, [fig]);

  return (
    <figure className="chart">
      <figcaption>
        <span>{fig.title}</span>
        <button type="button" className="expand" onClick={() => setExpanded(true)} title="Expand to full screen" aria-label={`Expand ${fig.title}`}>
          ⤢ Expand
        </button>
      </figcaption>
      <div ref={ref} />
      {expanded && <Lightbox fig={fig} onClose={() => setExpanded(false)} />}
    </figure>
  );
}

/** Full-viewport overlay rendering the same figure at window size. */
function Lightbox({ fig, onClose }: { fig: Figure; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const render = () => {
      const layout = { ...fig.layout, height: Math.max(300, window.innerHeight - 72), title: undefined, autosize: true, width: undefined };
      void Plotly.react(el, fig.data, layout, { ...PLOT_CONFIG, toImageButtonOptions: { format: "png", filename: fig.id, scale: 2 } });
    };
    render();
    window.addEventListener("resize", render);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    // Use the browser's full-screen mode when available; the overlay works without it.
    boxRef.current?.requestFullscreen?.().catch(() => undefined);
    return () => {
      window.removeEventListener("resize", render);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      Plotly.purge(el);
    };
  }, [fig, onClose]);

  useEffect(() => {
    // Leaving browser full-screen (e.g. via Escape handled by the browser) closes the overlay too.
    const onFs = () => {
      if (!document.fullscreenElement) onClose();
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [onClose]);

  return (
    <div className="lightbox" ref={boxRef} role="dialog" aria-modal="true" aria-label={fig.title}>
      <div className="lightbox-bar">
        <span>{fig.title}</span>
        <button type="button" onClick={onClose} aria-label="Close full-screen chart">✕ Close</button>
      </div>
      <div ref={ref} className="lightbox-plot" />
    </div>
  );
}

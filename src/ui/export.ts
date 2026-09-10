import type { Data, Layout } from "plotly.js";

interface Registered {
  title: string;
  data: Data[];
  layout: Partial<Layout>;
}

const figures = new Map<string, Registered>();

export function registerFigure(id: string, f: Registered): void {
  figures.set(id, f);
}
export function unregisterFigure(id: string): void {
  figures.delete(id);
}

export function downloadBlob(name: string, content: string | Blob, type = "text/plain"): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toPlain(v: unknown): unknown {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
  if (Array.isArray(v)) return v.map(toPlain);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = toPlain(x);
    return o;
  }
  return v;
}

/** Self-contained HTML with every currently rendered chart (Plotly from CDN). */
export function exportAllChartsHtml(title: string): void {
  const figs = [...figures.entries()].map(([id, f]) => ({ id, title: f.title, data: toPlain(f.data), layout: toPlain(f.layout) }));
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<script src="https://cdn.plot.ly/plotly-3.0.1.min.js"></script>
<style>body{font-family:system-ui,sans-serif;margin:24px;background:#f9f9f7;color:#0b0b0b}h1{font-size:20px}figure{margin:0 0 28px}figcaption{font-size:13px;color:#52514e;margin-bottom:4px}</style>
</head><body><h1>${escapeHtml(title)}</h1>
${figs.map((f) => `<figure><figcaption>${escapeHtml(f.title)}</figcaption><div id="${f.id}"></div></figure>`).join("\n")}
<script>
const figs = ${JSON.stringify(figs)};
for (const f of figs) Plotly.newPlot(f.id, f.data, f.layout, {responsive: true, displaylogo: false});
</script></body></html>`;
  downloadBlob("treasury-simulator-charts.html", html, "text/html");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CONFIG, makeConfig, type SimConfig } from "../engine";
import { applyUi, CONTROL_GROUPS, DEFAULT_UI, getPath, setPath, type ControlSpec, type UiSettings } from "./controls";
import type { ChartData } from "./dashboardData";
import type { WorkerRequest, WorkerResponse } from "./worker";
import { Plot, type Figure } from "./Plot";
import * as C from "./charts";
import { tokens, type Mode } from "./theme";
import { downloadBlob, exportAllChartsHtml } from "./export";
import "./styles.css";

function useMode(): [Mode, (m: Mode) => void] {
  const [mode, setMode] = useState<Mode>(() => {
    try {
      const saved = localStorage.getItem("tms-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* ignore */
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem("tms-theme", mode);
    } catch {
      /* ignore */
    }
  }, [mode]);
  return [mode, setMode];
}

const SECTIONS = [
  ["summary", "Summary"],
  ["curve", "Curve"],
  ["issuance", "Issuance"],
  ["auctions", "Auctions"],
  ["liquidity", "On/off-the-run"],
  ["buybacks", "Buybacks"],
  ["stress", "Stress"],
  ["bonds", "Bond analytics"],
  ["fans", "Across seeds"],
] as const;

export function App() {
  const [config, setConfig] = useState<SimConfig>(() => makeConfig());
  const [ui, setUi] = useState<UiSettings>(DEFAULT_UI);
  const [data, setData] = useState<ChartData | null>(null);
  const [status, setStatus] = useState<{ running: boolean; message: string; frac: number }>({ running: false, message: "", frac: 0 });
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useMode();
  const [curveSnap, setCurveSnap] = useState(0);
  const [ladderSnap, setLadderSnap] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [lifecycleId, setLifecycleId] = useState<string>("");
  const [rolldownId, setRolldownId] = useState<string>("");
  const workerRef = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const t = useMemo(() => tokens(mode), [mode]);

  // Worker lifecycle.
  useEffect(() => {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (m.id !== reqId.current) return;
      if (m.type === "progress") setStatus({ running: true, message: m.message, frac: m.frac });
      else if (m.type === "result") {
        setData(m.data);
        setStatus({ running: false, message: `Run ${(m.data.timing.runMs / 1000).toFixed(1)}s · compare ${(m.data.timing.compareMs / 1000).toFixed(1)}s · fans ${(m.data.timing.fanMs / 1000).toFixed(1)}s`, frac: 1 });
        setCurveSnap(0);
        setLadderSnap(0);
      } else if (m.type === "csv") downloadBlob("bond-daily.csv", m.csv, "text/csv");
      else if (m.type === "error") {
        setError(m.message);
        setStatus({ running: false, message: "Failed", frac: 0 });
      }
    };
    return () => w.terminate();
  }, []);

  const run = useCallback(
    (cfg: SimConfig, u: UiSettings) => {
      const w = workerRef.current;
      if (!w) return;
      setError(null);
      const id = ++reqId.current;
      setStatus({ running: true, message: "Starting…", frac: 0 });
      const req: WorkerRequest = { type: "run", id, config: applyUi(cfg, u), options: { compare: u.compare, fanSeeds: u.fanSeeds, rolldownBondId: rolldownId || undefined } };
      w.postMessage(req);
    },
    [rolldownId],
  );

  // First run on mount.
  useEffect(() => {
    run(config, ui);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Animation for the curve snapshot.
  useEffect(() => {
    if (!playing || !data) return;
    const id = setInterval(() => setCurveSnap((s) => (s + 1) % data.otr.dayIdx.length), 120);
    return () => clearInterval(id);
  }, [playing, data]);

  const exportCsv = () => {
    const id = reqId.current;
    workerRef.current?.postMessage({ type: "csv", id } satisfies WorkerRequest);
  };
  const exportConfig = () => downloadBlob("config.json", JSON.stringify(applyUi(config, ui), null, 2), "application/json");

  const updateControl = (spec: ControlSpec, value: unknown) => {
    if (spec.path.startsWith("ui.")) setUi((u) => ({ ...u, [spec.path.slice(3)]: value }));
    else setConfig((c) => setPath(c, spec.path, value));
  };

  const figures = useMemo(() => (data ? buildFigures(data, t, { curveSnap, ladderSnap, lifecycleId, rolldownId }) : null), [data, t, curveSnap, ladderSnap, lifecycleId, rolldownId]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>Treasury Market Simulator</h1>
          <p className="sub">Curve · issuance · auctions · liquidity premia · buybacks · stress</p>
        </div>
        <div className="run-row">
          <button className="primary" disabled={status.running} onClick={() => run(config, ui)}>
            {status.running ? "Running…" : "Rerun"}
          </button>
          <button onClick={() => { setConfig(makeConfig()); setUi(DEFAULT_UI); }}>Reset</button>
          <button onClick={() => setMode(mode === "light" ? "dark" : "light")} title="Toggle theme">
            {mode === "light" ? "Dark" : "Light"}
          </button>
        </div>
        <div className="status">
          <div className="bar"><div style={{ width: `${Math.round(status.frac * 100)}%` }} /></div>
          <span>{status.message}</span>
          {error && <span className="error">{error}</span>}
        </div>
        <details open>
          <summary>Comparison & fan charts</summary>
          <label className="row">
            <input type="checkbox" checked={ui.compare} onChange={(e) => setUi({ ...ui, compare: e.target.checked })} />
            <span>Run buybacks on/off side-by-side (same seed)</span>
          </label>
          <label className="slider">
            <span>Seeds for fan charts <b>{ui.fanSeeds}</b></span>
            <input type="range" min={1} max={100} step={1} value={ui.fanSeeds} onChange={(e) => setUi({ ...ui, fanSeeds: Number(e.target.value) })} />
          </label>
        </details>
        {CONTROL_GROUPS.map((g) => (
          <details key={g.title} open={g.title === "Run" || g.title === "Buybacks"}>
            <summary>{g.title}</summary>
            {g.controls.map((spec) => (
              <Control key={spec.path} spec={spec} value={spec.path.startsWith("ui.") ? (ui as unknown as Record<string, unknown>)[spec.path.slice(3)] : getPath(config, spec.path)} onChange={(v) => updateControl(spec, v)} />
            ))}
          </details>
        ))}
        <details>
          <summary>Export</summary>
          <div className="export">
            <button onClick={exportCsv} disabled={!data}>Bond-level CSV</button>
            <button onClick={exportConfig}>Config JSON</button>
            <button onClick={() => exportAllChartsHtml("Treasury Market Simulator")} disabled={!data}>All charts (HTML)</button>
            <p className="hint">Use the camera icon on any chart for a PNG.</p>
          </div>
        </details>
        <p className="hint">
          Reduced-form simulator of the US Treasury nominal coupon market. Everything runs in your browser; change a slider and press Rerun. Defaults roughly track 2025–26 issuance sizes and are not calibrated to any single period.
        </p>
      </aside>

      <main className="main">
        <nav className="sections">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`}>{label}</a>
          ))}
        </nav>
        {!data && <div className="empty">{status.running ? status.message : "Press Rerun to simulate."}</div>}
        {data && figures && (
          <>
            <section id="summary">
              <h2>Summary</h2>
              <Summary d={data} />
            </section>

            <section id="curve">
              <h2>Curve</h2>
              <div className="toolbar">
                <label className="slider wide">
                  <span>Snapshot day <b>{data.meta.dates[data.otr.dayIdx[curveSnap]]}</b></span>
                  <input type="range" min={0} max={data.otr.dayIdx.length - 1} value={curveSnap} onChange={(e) => setCurveSnap(Number(e.target.value))} />
                </label>
                <button onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
              </div>
              <Plot fig={figures.curveSnapshot} />
              <Plot fig={figures.yieldSurface} />
              <Plot fig={figures.factors} />
              <Plot fig={figures.curveSpreads} />
            </section>

            <section id="issuance">
              <h2>Issuance and supply</h2>
              <div className="toolbar">
                <label className="slider wide">
                  <span>Ladder date <b>{data.meta.dates[data.ladder.dayIdx[ladderSnap]]}</b></span>
                  <input type="range" min={0} max={data.ladder.dayIdx.length - 1} value={ladderSnap} onChange={(e) => setLadderSnap(Number(e.target.value))} />
                </label>
              </div>
              <Plot fig={figures.ladder} />
              <div className="toolbar">
                <label className="select">
                  <span>CUSIP</span>
                  <select value={lifecycleId || data.lifecycle[0]?.id} onChange={(e) => setLifecycleId(e.target.value)}>
                    {data.lifecycle.map((l) => (
                      <option key={l.id} value={l.id}>{l.id}</option>
                    ))}
                  </select>
                </label>
              </div>
              <Plot fig={figures.lifecycle} />
            </section>

            <section id="auctions">
              <h2>Auctions</h2>
              <Plot fig={figures.tails} />
              <Plot fig={figures.btc} />
              <Plot fig={figures.dealer} />
            </section>

            <section id="liquidity">
              <h2>On/off-the-run liquidity premium</h2>
              <Plot fig={figures.onOffFitted} />
              <Plot fig={figures.onOffOld} />
              <Plot fig={figures.specialness} />
              <Plot fig={figures.specialnessScatter} />
              <Plot fig={figures.offRunFit} />
            </section>

            <section id="buybacks">
              <h2>Buyback program</h2>
              <BuybackTable d={data} />
              <Plot fig={figures.bbAmounts} />
              <Plot fig={figures.bbFill} />
              <Plot fig={figures.bbSpread} />
              <Plot fig={figures.bucketCheapness} />
              {data.compare ? <Plot fig={figures.compare} /> : <p className="hint">Enable the side-by-side comparison to see buybacks on vs off.</p>}
            </section>

            <section id="stress">
              <h2>Stress regimes</h2>
              <Plot fig={figures.stress} />
            </section>

            <section id="bonds">
              <h2>Bond analytics</h2>
              <div className="toolbar">
                <label className="select">
                  <span>Note to track</span>
                  <select value={data.rolldown.bondId} onChange={(e) => { setRolldownId(e.target.value); }}>
                    {data.rolldown.candidates.map((id) => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </select>
                </label>
                <span className="hint">Rerun to recompute the tracker for a different note.</span>
              </div>
              <Plot fig={figures.rolldownPath} />
              <Plot fig={figures.rolldownProb} />
              <Plot fig={figures.carry} />
              <CarryTable d={data} />
            </section>

            <section id="fans">
              <h2>Across seeds</h2>
              {data.fans ? (
                <>
                  <Plot fig={figures.fanY10} />
                  <Plot fig={figures.fanOnOff} />
                  <Plot fig={figures.fan2s10s} />
                </>
              ) : (
                <p className="hint">Set the fan-chart seed count above 1 and rerun.</p>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function buildFigures(d: ChartData, t: ReturnType<typeof tokens>, sel: { curveSnap: number; ladderSnap: number; lifecycleId: string; rolldownId: string }) {
  return {
    curveSnapshot: C.curveSnapshot(d, t, Math.min(sel.curveSnap, d.otr.dayIdx.length - 1)),
    yieldSurface: C.yieldSurface(d, t),
    factors: C.factorPaths(d, t),
    curveSpreads: C.curveSpreads(d, t),
    ladder: C.supplyLadderFig(d, t, Math.min(sel.ladderSnap, d.ladder.dayIdx.length - 1)),
    lifecycle: C.lifecycle(d, t, sel.lifecycleId),
    tails: C.auctionDashboard(d, t, "tailBp"),
    btc: C.auctionDashboard(d, t, "bidToCover"),
    dealer: C.auctionDashboard(d, t, "dealerShare"),
    onOffFitted: C.onOffDeltas(d, t, "otrMinusFitted"),
    onOffOld: C.onOffDeltas(d, t, "otrMinusOld"),
    specialness: C.specialness(d, t),
    specialnessScatter: C.specialnessScatter(d, t),
    offRunFit: C.offRunFitFig(d, t),
    bbAmounts: C.buybackOps(d, t, "amounts"),
    bbFill: C.buybackOps(d, t, "fill"),
    bbSpread: C.buybackOps(d, t, "spread"),
    bucketCheapness: C.bucketCheapnessFig(d, t),
    compare: C.buybackCompare(d, t),
    stress: C.stressOverlay(d, t),
    rolldownPath: C.rolldownFig(d, t, "rem"),
    rolldownProb: C.rolldownFig(d, t, "prob"),
    carry: C.carryFig(d, t),
    fanY10: C.fanFig(d, t, "y10"),
    fanOnOff: C.fanFig(d, t, "onOff10"),
    fan2s10s: C.fanFig(d, t, "twosTens"),
  } satisfies Record<string, Figure>;
}

function Control({ spec, value, onChange }: { spec: ControlSpec; value: unknown; onChange: (v: unknown) => void }) {
  if (spec.kind === "toggle") {
    return (
      <label className="row" title={spec.help}>
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span>{spec.label}</span>
      </label>
    );
  }
  if (spec.kind === "select") {
    return (
      <label className="select" title={spec.help}>
        <span>{spec.label}</span>
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
          ))}
        </select>
      </label>
    );
  }
  const v = Number(value);
  const scale = spec.scale ?? 1;
  const shown = v * scale;
  const digits = spec.step * scale >= 1 ? 0 : spec.step * scale >= 0.1 ? 1 : 2;
  return (
    <label className="slider" title={spec.help}>
      <span>
        {spec.label} <b>{Number.isFinite(shown) ? shown.toFixed(digits) : "—"}{spec.unit ? ` ${spec.unit}` : ""}</b>
      </span>
      <input type="range" min={spec.min} max={spec.max} step={spec.step} value={v} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Summary({ d }: { d: ChartData }) {
  const k = d.meta.keyTenors.length;
  const i10 = d.meta.keyTenors.indexOf(10);
  const last = d.meta.nDays - 1;
  const y10 = d.curve.parYields[last * k + i10] * 100;
  const tails = d.auctions.filter((a) => a.tenor === 10).map((a) => a.tailBp);
  const meanTail = tails.length ? tails.reduce((a, b) => a + b, 0) / tails.length : 0;
  const m = d.buyback.metrics;
  const onOff = d.onOff[10].otrMinusFitted;
  let s = 0;
  for (let i = 0; i < onOff.length; i++) s += onOff[i];
  const tiles: Array<[string, string, string]> = [
    ["10y yield, end of run", `${y10.toFixed(2)}%`, `2s10s ${d.curve.twosTens[last].toFixed(0)}bp`],
    ["10y OTR richness, average", `${(-s / onOff.length).toFixed(1)}bp`, "yield below fitted curve"],
    ["10y auction tail, average", `${meanTail >= 0 ? "+" : ""}${meanTail.toFixed(2)}bp`, `${tails.length} auctions`],
    ["Bought back", `$${m.totalBought.toFixed(0)}bn`, d.meta.buybackEnabled ? `${d.buyback.operations.length} operations` : "program off"],
    ["Savings vs curve", `$${(m.totalSavings * 1000).toFixed(0)}mm`, "par bought below fair value"],
    ["Net DV01 impact", `${m.netDv01 >= 0 ? "+" : ""}$${m.netDv01.toFixed(1)}mm/bp`, `removed $${m.dv01Removed.toFixed(1)} · funded $${m.dv01Funded.toFixed(1)}`],
  ];
  if (d.compare) tiles.push(["Off-run cheapness, 2y–10y average", `${d.compare.meanOn.toFixed(2)} vs ${d.compare.meanOff.toFixed(2)}bp`, `buybacks on vs off, same seed · peak ${d.compare.peakOn.toFixed(2)} vs ${d.compare.peakOff.toFixed(2)}bp`]);
  return (
    <div className="tiles">
      {tiles.map(([label, value, sub]) => (
        <div className="tile" key={label}>
          <div className="label">{label}</div>
          <div className="value">{value}</div>
          <div className="sub">{sub}</div>
        </div>
      ))}
    </div>
  );
}

function BuybackTable({ d }: { d: ChartData }) {
  const m = d.buyback.metrics;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Bucket</th><th>Ops</th><th>Offered $bn</th><th>Bought $bn</th><th>Fill</th><th>Avg spread bp</th><th>Savings $mm</th><th>DV01 removed $mm/bp</th></tr>
        </thead>
        <tbody>
          {m.buckets.map((b) => (
            <tr key={b.name}>
              <td>{b.name}</td><td>{b.operations}</td><td>{b.offered.toFixed(1)}</td><td>{b.bought.toFixed(1)}</td><td>{(b.fillRate * 100).toFixed(0)}%</td><td>{b.avgSpreadBp.toFixed(2)}</td><td>{(b.savingsVsCurve * 1000).toFixed(0)}</td><td>{b.dv01Removed.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CarryTable({ d }: { d: ChartData }) {
  const rows = d.carry.rows.filter((r) => r.status === "OTR" || r.status === "old");
  return (
    <details className="table-wrap">
      <summary>Table: on-the-run and old bonds on {d.meta.dates[d.carry.dayIdx]}</summary>
      <table>
        <thead>
          <tr><th>CUSIP</th><th>Status</th><th>Yield bp</th><th>Spread bp</th><th>Carry</th><th>Roll-down</th><th>Financing</th><th>DV01</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td><td>{r.status}</td><td>{r.ytmBp.toFixed(1)}</td><td>{r.spreadBp.toFixed(2)}</td><td>{r.carry.toFixed(4)}</td><td>{r.rolldown.toFixed(4)}</td><td>{r.financing.toFixed(4)}</td><td>{r.dv01.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export { DEFAULT_CONFIG };

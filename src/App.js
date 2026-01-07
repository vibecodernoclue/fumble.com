import React, { useMemo, useState } from "react";
import Papa from "papaparse";

/**
 * fumble.com — Degen Edition + FREE Hindsight via Binance Candles (no API key)
 * Current supported trade CSV:
 * - BloFin Order History (reconstruct closed trades by pairing Open/Close)
 *
 * Price source:
 * - Binance public klines (spot) used as universal price source
 *   Primary: https://api.binance.com
 *   Fallback: https://data-api.binance.vision
 *
 * This is a vibes tool: estimates, not exchange-perfect.
 */

// ---------------- utils ----------------
function cleanHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ");
}

function parseNumWithUnits(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  if (!s || s === "--") return NaN;
  const token = s.split(" ")[0].replaceAll(",", "");
  const n = Number(token);
  return Number.isFinite(n) ? n : NaN;
}

function parseTimeBloFin(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  let d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;

  // MM/DD/YYYY HH:mm:ss
  const [datePart, timePart] = s.split(" ");
  if (!datePart || !timePart) return null;
  const [mm, dd, yyyy] = datePart.split("/").map((x) => Number(x));
  const [HH, MM, SS] = timePart.split(":").map((x) => Number(x));
  if ([mm, dd, yyyy, HH, MM, SS].some((x) => !Number.isFinite(x))) return null;

  d = new Date(yyyy, mm - 1, dd, HH, MM, SS);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtMoney(n) {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}
function fmtPct(n) {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
function fmtPrice(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function minsBetween(a, b) {
  if (!a || !b) return NaN;
  const ms = b.getTime() - a.getTime();
  if (!Number.isFinite(ms) || ms < 0) return NaN;
  return ms / 60000;
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// ---------------- detect source ----------------
function detectSource(headers) {
  const H = headers.map(cleanHeader);
  const has = (x) => H.includes(cleanHeader(x));

  if (
    has("Underlying Asset") &&
    has("Margin Mode") &&
    has("Order Time") &&
    has("Avg Fill") &&
    has("Filled") &&
    has("PNL") &&
    has("PNL%")
  ) {
    return "BLOFIN_ORDER_HISTORY";
  }
  return "UNKNOWN";
}

// ---------------- BloFin parsing ----------------
function parseBloFinRows(rows) {
  return rows
    .filter((r) => r && String(r["Status"] || "").toLowerCase() === "filled")
    .map((r) => {
      const symbol = String(r["Underlying Asset"] || "").trim(); // usually BTCUSDT
      const side = String(r["Side"] || "").trim(); // "Open Long", "Close Short", ...
      const time = parseTimeBloFin(r["Order Time"]);
      const avgFill = parseNumWithUnits(r["Avg Fill"]);
      const qty = parseNumWithUnits(r["Filled"]);
      const pnl = parseNumWithUnits(r["PNL"]); // close rows have number, open rows "--"
      const pnlPct = parseNumWithUnits(r["PNL%"]); // close rows have number, open rows "--"
      const fee = parseNumWithUnits(r["Fee"]);

      let action = "UNKNOWN";
      let direction = "UNKNOWN";
      const s = side.toUpperCase();
      if (s.includes("OPEN")) action = "OPEN";
      if (s.includes("CLOSE")) action = "CLOSE";
      if (s.includes("LONG")) direction = "LONG";
      if (s.includes("SHORT")) direction = "SHORT";

      return {
        symbol,
        side,
        action,
        direction,
        time,
        avgFill,
        qty,
        pnl: Number.isFinite(pnl) ? pnl : null,
        pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
        fee: Number.isFinite(fee) ? fee : null,
      };
    })
    .filter(
      (x) =>
        x.symbol &&
        x.action !== "UNKNOWN" &&
        x.direction !== "UNKNOWN" &&
        x.time
    );
}

function buildClosedTradesFromFills(fills) {
  const stacks = new Map(); // key symbol|direction -> FIFO open lots

  const getKey = (f) => `${f.symbol}|${f.direction}`;
  const getStack = (key) => {
    if (!stacks.has(key)) stacks.set(key, []);
    return stacks.get(key);
  };

  const sorted = fills
    .slice()
    .sort((a, b) => a.time.getTime() - b.time.getTime());
  const closedTrades = [];

  for (const f of sorted) {
    const key = getKey(f);
    const stack = getStack(key);

    if (f.action === "OPEN") {
      stack.push({ time: f.time, price: f.avgFill, qty: f.qty });
      continue;
    }

    if (f.action === "CLOSE") {
      let remaining = f.qty;

      let entryQtyTotal = 0;
      let entryNotional = 0;
      let entryTime = null;

      while (remaining > 0 && stack.length > 0) {
        const lot = stack[0];
        const take = Math.min(remaining, lot.qty);

        entryQtyTotal += take;
        entryNotional += take * lot.price;
        if (!entryTime || lot.time < entryTime) entryTime = lot.time;

        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-12) stack.shift();
      }

      const entryPrice =
        entryQtyTotal > 0 ? entryNotional / entryQtyTotal : NaN;
      const exitPrice = f.avgFill;
      const holdMins = entryTime ? minsBetween(entryTime, f.time) : NaN;

      closedTrades.push({
        exchange: "BloFin",
        symbol: f.symbol,
        direction: f.direction,
        entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
        exitPrice: Number.isFinite(exitPrice) ? exitPrice : null,
        qty: Number.isFinite(f.qty) ? f.qty : null,
        pnl: Number.isFinite(f.pnl) ? f.pnl : null,
        pnlPct: Number.isFinite(f.pnlPct) ? f.pnlPct : null,
        holdMins: Number.isFinite(holdMins) ? holdMins : null,
        closeTime: f.time,
        note:
          entryQtyTotal > 0
            ? null
            : "No matching open found (CSV may be partial).",
      });
    }
  }

  return closedTrades;
}

// ---------------- Summary (behavioral) ----------------
function mean(arr) {
  const a = arr.filter((x) => Number.isFinite(x));
  if (a.length === 0) return NaN;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function summarizeClosedTrades(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => Number.isFinite(t.pnl) && t.pnl > 0);
  const losses = trades.filter((t) => Number.isFinite(t.pnl) && t.pnl < 0);

  const winRate = n > 0 ? wins.length / n : NaN;
  const totalPnl = trades
    .map((t) => t.pnl)
    .filter((x) => Number.isFinite(x))
    .reduce((a, b) => a + b, 0);

  const avgWinHold = mean(wins.map((t) => t.holdMins));
  const avgLossHold = mean(losses.map((t) => t.holdMins));
  const paperhands =
    Number.isFinite(avgWinHold) &&
    Number.isFinite(avgLossHold) &&
    avgLossHold > 0
      ? avgWinHold / avgLossHold
      : NaN;

  let fumbleScore = NaN;
  if (Number.isFinite(paperhands)) {
    const raw = 60 - 20 * Math.log2(paperhands);
    fumbleScore = clamp(raw, 0, 100);
  }

  return { n, winRate, totalPnl, paperhands, fumbleScore };
}

// ---------------- Binance candles (FREE, no key) ----------------
const BINANCE_BASES = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
];

const INTERVALS = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
];

function normalizeToBinanceSymbol(sym) {
  // BloFin might be BTCUSDT already; others might be BTC-USDT, BTC/USDT, etc.
  return String(sym || "")
    .toUpperCase()
    .replaceAll("-", "")
    .replaceAll("/", "")
    .trim();
}

async function fetchKlinesAnyBase({ symbol, interval, startTime, endTime }) {
  let lastErr = null;

  for (const base of BINANCE_BASES) {
    try {
      const url = new URL(`${base}/api/v3/klines`);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("startTime", String(startTime));
      url.searchParams.set("endTime", String(endTime));
      url.searchParams.set("limit", "1000");

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Failed to fetch klines");
}

async function fetchAllKlines({
  symbol,
  interval,
  startTime,
  endTime,
  onProgress,
}) {
  // Binance limit: 1000 candles per request
  const intervalMs = INTERVALS.find((x) => x.label === interval)?.ms ?? 300_000;
  const maxSpan = intervalMs * 1000; // 1000 candles

  let t = startTime;
  const out = [];

  let chunk = 0;
  while (t < endTime) {
    const chunkEnd = Math.min(endTime, t + maxSpan);
    onProgress?.({ chunk: chunk + 1, start: t, end: chunkEnd });

    // eslint-disable-next-line no-await-in-loop
    const kl = await fetchKlinesAnyBase({
      symbol,
      interval,
      startTime: t,
      endTime: chunkEnd,
    });

    for (const k of kl) out.push(k);

    // move forward: last candle open time + interval
    if (kl.length > 0) {
      const lastOpen = kl[kl.length - 1][0];
      t = lastOpen + intervalMs;
    } else {
      // if empty, just jump
      t = chunkEnd;
    }

    chunk += 1;

    // tiny pause to be nice with limits
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 120));
  }

  // Deduplicate by open time
  const seen = new Set();
  const dedup = [];
  for (const k of out) {
    const ot = k[0];
    if (seen.has(ot)) continue;
    seen.add(ot);
    dedup.push(k);
  }
  dedup.sort((a, b) => a[0] - b[0]);

  return dedup;
}

function indexKlines(klines) {
  // Convert to array of {t, high, low}
  return klines.map((k) => ({
    t: k[0], // open time ms
    high: Number(k[2]),
    low: Number(k[3]),
  }));
}

function bestPriceInWindow({ series, startMs, endMs, direction }) {
  // Long: best = max high, Short: best = min low
  let best = direction === "SHORT" ? Infinity : -Infinity;
  let found = false;

  for (const c of series) {
    if (c.t < startMs) continue;
    if (c.t > endMs) break;
    found = true;
    if (direction === "SHORT") best = Math.min(best, c.low);
    else best = Math.max(best, c.high);
  }

  if (!found) return null;
  return best;
}

// ---------------- App ----------------
export default function App() {
  const [fileName, setFileName] = useState("");
  const [source, setSource] = useState("UNKNOWN");
  const [error, setError] = useState("");
  const [closedTrades, setClosedTrades] = useState([]);

  // Hindsight (Binance)
  const [interval, setInterval] = useState("5m");
  const [lookaheadHours, setLookaheadHours] = useState(4);
  const [realismPct, setRealismPct] = useState(80); // 80% of best move to be less fantasy
  const [hStatus, setHStatus] = useState(""); // status line
  const [hLoading, setHLoading] = useState(false);
  const [hData, setHData] = useState(null); // computed fumbles per trade

  function handleFile(file) {
    if (!file) return;
    setFileName(file.name);
    setError("");
    setClosedTrades([]);
    setHData(null);
    setSource("PARSING");

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const headers = results.meta.fields || [];
        const rows = results.data || [];
        const detected = detectSource(headers);
        setSource(detected);

        if (detected === "BLOFIN_ORDER_HISTORY") {
          const fills = parseBloFinRows(rows);
          const closed = buildClosedTradesFromFills(fills).filter(
            (t) => t.closeTime
          );
          setClosedTrades(closed);
          return;
        }

        setError(
          "Unsupported CSV for now. (BloFin Order History supported). Next we’ll hardcode Binance + Bybit exports too."
        );
      },
    });
  }

  const summary = useMemo(
    () => summarizeClosedTrades(closedTrades),
    [closedTrades]
  );

  const big = useMemo(() => {
    if (!Number.isFinite(summary.fumbleScore)) return "—";
    return Math.round(summary.fumbleScore).toString();
  }, [summary]);

  const bigColor = useMemo(() => {
    const s = summary.fumbleScore;
    if (!Number.isFinite(s)) return "#111827";
    if (s >= 70) return "#ff3b3b";
    if (s >= 40) return "#ffb020";
    return "#22c55e";
  }, [summary]);

  const uniqueSymbols = useMemo(() => {
    const set = new Set();
    for (const t of closedTrades) set.add(normalizeToBinanceSymbol(t.symbol));
    return Array.from(set).filter(Boolean);
  }, [closedTrades]);

  const hindsightSummary = useMemo(() => {
    if (!hData) return null;
    const totalFumbled = hData.reduce(
      (s, x) => s + (Number.isFinite(x.fumbled) ? x.fumbled : 0),
      0
    );
    const totalPotential = hData.reduce(
      (s, x) => s + (Number.isFinite(x.potentialPnl) ? x.potentialPnl : 0),
      0
    );
    const totalRealized = hData.reduce(
      (s, x) => s + (Number.isFinite(x.realizedPnl) ? x.realizedPnl : 0),
      0
    );

    const worst = hData
      .filter((x) => Number.isFinite(x.fumbled))
      .slice()
      .sort((a, b) => b.fumbled - a.fumbled)[0];

    return { totalFumbled, totalPotential, totalRealized, worst };
  }, [hData]);

  async function runHindsight() {
    if (closedTrades.length === 0) return;

    setHLoading(true);
    setHStatus("Warming up the roast…");
    setError("");
    setHData(null);

    try {
      const intervalMs =
        INTERVALS.find((x) => x.label === interval)?.ms ?? 300_000;
      const lookaheadMs = Number(lookaheadHours) * 3600_000;

      // Group trades by symbol to fetch candles once per symbol
      const bySymbol = new Map();
      for (const t of closedTrades) {
        const sym = normalizeToBinanceSymbol(t.symbol);
        if (!sym) continue;
        if (!bySymbol.has(sym)) bySymbol.set(sym, []);
        bySymbol.get(sym).push(t);
      }

      const symbolSeries = new Map();

      let symIdx = 0;
      for (const [sym, trades] of bySymbol.entries()) {
        symIdx += 1;

        // Determine needed range
        const minClose = Math.min(...trades.map((t) => t.closeTime.getTime()));
        const maxClose = Math.max(...trades.map((t) => t.closeTime.getTime()));
        const startTime = minClose - intervalMs * 2;
        const endTime = maxClose + lookaheadMs + intervalMs * 2;

        setHStatus(`Fetching ${sym} candles (${symIdx}/${bySymbol.size})…`);

        // eslint-disable-next-line no-await-in-loop
        const klines = await fetchAllKlines({
          symbol: sym,
          interval,
          startTime,
          endTime,
          onProgress: ({ chunk }) => {
            setHStatus(`Fetching ${sym} candles… chunk ${chunk}`);
          },
        });

        symbolSeries.set(sym, indexKlines(klines));
      }

      setHStatus("Computing fumbles…");

      const realism = clamp(Number(realismPct) / 100, 0, 1);

      const computed = closedTrades.map((t) => {
        const sym = normalizeToBinanceSymbol(t.symbol);
        const series = symbolSeries.get(sym);
        if (!series) {
          return {
            ...t,
            bestExit: null,
            potentialPnl: null,
            fumbled: null,
            realizedPnl: t.pnl,
          };
        }

        // Window starts at exit time; ends at exit + lookahead
        const startMs = t.closeTime.getTime();
        const endMs = startMs + lookaheadMs;

        const bestExitRaw = bestPriceInWindow({
          series,
          startMs,
          endMs,
          direction: t.direction,
        });

        if (!Number.isFinite(bestExitRaw)) {
          return {
            ...t,
            bestExit: null,
            potentialPnl: null,
            fumbled: null,
            realizedPnl: t.pnl,
          };
        }

        // realism adjustment: pull bestExit toward actual exit
        const exit = t.exitPrice;
        const bestExit =
          Number.isFinite(exit) && Number.isFinite(bestExitRaw)
            ? exit + (bestExitRaw - exit) * realism
            : bestExitRaw;

        // Potential PnL estimate using qty and entry/bestExit
        // Long: (bestExit - entry) * qty
        // Short: (entry - bestExit) * qty
        const entry = t.entryPrice;
        const qty = t.qty;

        let potentialPnl = null;
        if (
          Number.isFinite(entry) &&
          Number.isFinite(bestExit) &&
          Number.isFinite(qty)
        ) {
          potentialPnl =
            t.direction === "SHORT"
              ? (entry - bestExit) * qty
              : (bestExit - entry) * qty;
        }

        const realized = Number.isFinite(t.pnl) ? t.pnl : null;

        // Fumbled = potential - realized (only if positive)
        let fumbled = null;
        if (Number.isFinite(potentialPnl) && Number.isFinite(realized)) {
          fumbled = Math.max(0, potentialPnl - realized);
        }

        // Also compute potential pct vs entry
        let potentialPct = null;
        if (Number.isFinite(entry) && Number.isFinite(bestExit)) {
          const raw = ((bestExit - entry) / entry) * 100;
          potentialPct = t.direction === "SHORT" ? -raw : raw;
        }

        return {
          ...t,
          bestExit,
          potentialPnl,
          potentialPct,
          realizedPnl: realized,
          fumbled,
        };
      });

      setHData(computed);
      setHStatus("Roast complete ✅");
    } catch (e) {
      setError(`Hindsight failed: ${e?.message || String(e)}`);
      setHStatus("");
    } finally {
      setHLoading(false);
    }
  }

  const previewRows = useMemo(
    () => (hData ? hData : closedTrades),
    [hData, closedTrades]
  );

  return (
    <div style={styles.bg}>
      <div style={styles.shell}>
        <div style={styles.header}>
          <div style={styles.logo}>
            <span style={styles.logoEmoji}>🤡</span>
            <span style={styles.logoText}>fumble.com</span>
          </div>
          <div style={styles.tagline}>
            Upload your trades. We roast your exits.
          </div>
        </div>

        <div style={styles.uploadCard}>
          <div style={styles.uploadTop}>
            <div>
              <div style={styles.uploadTitle}>Drop your CSV</div>
              <div style={styles.uploadHint}>
                Using <b>Binance spot candles</b> for hindsight (free, no key).
              </div>
            </div>

            <label style={styles.fileBtn}>
              <input
                type="file"
                accept=".csv"
                style={{ display: "none" }}
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              Upload CSV 🚀
            </label>
          </div>

          {fileName && (
            <div style={styles.loadedRow}>
              <span style={styles.badge}>Loaded</span>
              <span style={{ fontWeight: 800 }}>{fileName}</span>
              <span style={styles.dim}>·</span>
              <span style={styles.dim}>
                {source === "BLOFIN_ORDER_HISTORY"
                  ? "BloFin detected ✅"
                  : source === "PARSING"
                  ? "Parsing…"
                  : "Unknown"}
              </span>
            </div>
          )}

          {error && <div style={styles.errorBox}>⚠️ {error}</div>}
        </div>

        {closedTrades.length > 0 && (
          <>
            <div style={styles.hero}>
              <div style={styles.heroLeft}>
                <div style={styles.heroLabel}>Fumble Score</div>
                <div style={{ ...styles.heroNumber, color: bigColor }}>
                  {big}
                </div>
                <div style={styles.heroSub}>
                  V1 behavioral score. Hindsight mode below computes the real
                  “could’ve made”.
                </div>
              </div>

              <div style={styles.heroRight}>
                <Stat label="Trades" value={summary.n.toLocaleString()} />
                <Stat
                  label="Win rate"
                  value={
                    Number.isFinite(summary.winRate)
                      ? `${Math.round(summary.winRate * 100)}%`
                      : "—"
                  }
                />
                <Stat label="Total PnL" value={fmtMoney(summary.totalPnl)} />
                <Stat
                  label="Pairs"
                  value={
                    uniqueSymbols.length > 0
                      ? uniqueSymbols.length.toString()
                      : "—"
                  }
                />
              </div>
            </div>

            {/* Hindsight controls */}
            <div style={styles.hCard}>
              <div style={styles.hTop}>
                <div>
                  <div style={styles.hTitle}>Hindsight Mode (FREE)</div>
                  <div style={styles.hHint}>
                    We fetch Binance candles once per pair, then compute “best
                    exit within X hours”.
                  </div>
                </div>

                <button
                  type="button"
                  style={{ ...styles.primaryBtn, opacity: hLoading ? 0.7 : 1 }}
                  disabled={hLoading}
                  onClick={runHindsight}
                >
                  {hLoading
                    ? "Roasting…"
                    : "Fetch Binance candles & roast me 🔥"}
                </button>
              </div>

              <div style={styles.hGrid}>
                <div>
                  <div style={styles.hLabel}>Candle interval</div>
                  <select
                    style={styles.hSelect}
                    value={interval}
                    onChange={(e) => setInterval(e.target.value)}
                  >
                    {INTERVALS.map((x) => (
                      <option key={x.label} value={x.label}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div style={styles.hLabel}>Lookahead window</div>
                  <select
                    style={styles.hSelect}
                    value={lookaheadHours}
                    onChange={(e) => setLookaheadHours(Number(e.target.value))}
                  >
                    <option value={1}>1 hour</option>
                    <option value={4}>4 hours</option>
                    <option value={24}>24 hours</option>
                  </select>
                </div>

                <div>
                  <div style={styles.hLabel}>Realism (less fantasy)</div>
                  <div style={styles.sliderRow}>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={realismPct}
                      onChange={(e) => setRealismPct(Number(e.target.value))}
                      style={{ width: "100%" }}
                    />
                    <div style={styles.sliderVal}>{realismPct}%</div>
                  </div>
                </div>
              </div>

              {hStatus && <div style={styles.hStatus}>{hStatus}</div>}

              {hindsightSummary && (
                <div style={styles.hKPIs}>
                  <Kpi
                    label="Could’ve made"
                    value={fmtMoney(hindsightSummary.totalPotential)}
                  />
                  <Kpi
                    label="Actually made"
                    value={fmtMoney(hindsightSummary.totalRealized)}
                  />
                  <Kpi
                    label="Fumbled"
                    value={fmtMoney(hindsightSummary.totalFumbled)}
                  />
                </div>
              )}
            </div>

            {/* Trade preview */}
            <div style={styles.tableCard}>
              <div style={styles.tableTitle}>Trade preview</div>
              <div style={styles.tableHint}>
                If Hindsight Mode ran, you’ll see <b>Best Exit</b> +{" "}
                <b>Could’ve PnL</b> + <b>Fumbled</b>.
              </div>

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Exchange</th>
                      <th style={styles.th}>Symbol</th>
                      <th style={styles.th}>Side</th>
                      <th style={styles.th}>Entry</th>
                      <th style={styles.th}>Exit</th>
                      <th style={styles.th}>Best Exit</th>
                      <th style={styles.th}>PnL</th>
                      <th style={styles.th}>Could’ve PnL</th>
                      <th style={styles.th}>Fumbled</th>
                      <th style={styles.th}>Hold (min)</th>
                      <th style={styles.th}>Close time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.slice(0, 80).map((t, i) => (
                      <tr key={i}>
                        <td style={styles.td}>{t.exchange}</td>
                        <td style={styles.td}>
                          {normalizeToBinanceSymbol(t.symbol)}
                        </td>
                        <td style={styles.td}>{t.direction}</td>
                        <td style={styles.td}>
                          {t.entryPrice ? fmtPrice(t.entryPrice) : "—"}
                        </td>
                        <td style={styles.td}>
                          {t.exitPrice ? fmtPrice(t.exitPrice) : "—"}
                        </td>
                        <td style={styles.td}>
                          {"bestExit" in t && Number.isFinite(t.bestExit)
                            ? fmtPrice(t.bestExit)
                            : "—"}
                        </td>
                        <td style={styles.td}>
                          {Number.isFinite(t.pnl) ? fmtMoney(t.pnl) : "—"}
                        </td>
                        <td style={styles.td}>
                          {"potentialPnl" in t &&
                          Number.isFinite(t.potentialPnl)
                            ? fmtMoney(t.potentialPnl)
                            : "—"}
                        </td>
                        <td style={styles.td}>
                          {"fumbled" in t && Number.isFinite(t.fumbled)
                            ? fmtMoney(t.fumbled)
                            : "—"}
                        </td>
                        <td style={styles.td}>
                          {t.holdMins !== null
                            ? t.holdMins?.toFixed?.(0) ?? "—"
                            : "—"}
                        </td>
                        <td style={styles.td}>
                          t.closeTime ? t.closeTime.toISOString().slice(0,
                          19).replace("T", " ") : "—"
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={styles.footerRow}>
                <span style={styles.footerPill}>🔒 Runs locally</span>
                <span style={styles.footerPill}>🧨 Binance candles (free)</span>
                <span style={styles.footerPill}>🤝 No API key</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
    </div>
  );
}

function Kpi({ label, value }) {
  return (
    <div style={styles.kpi}>
      <div style={styles.kpiLabel}>{label}</div>
      <div style={styles.kpiValue}>{value}</div>
    </div>
  );
}

// ---------------- styles (degen) ----------------
const styles = {
  bg: {
    minHeight: "100vh",
    padding: 24,
    fontFamily:
      "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
    background:
      "radial-gradient(1200px 600px at 20% 0%, rgba(255, 0, 128, 0.20), transparent 60%)," +
      "radial-gradient(900px 500px at 90% 20%, rgba(0, 209, 255, 0.18), transparent 60%)," +
      "radial-gradient(900px 500px at 50% 100%, rgba(34, 197, 94, 0.16), transparent 60%)," +
      "#060914",
    color: "#e5e7eb",
    display: "flex",
    justifyContent: "center",
  },
  shell: { width: 1050, maxWidth: "100%" },

  header: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    marginBottom: 16,
  },
  logo: { display: "flex", alignItems: "center", gap: 10 },
  logoEmoji: { fontSize: 28 },
  logoText: { fontWeight: 1000, fontSize: 22, letterSpacing: "-0.02em" },
  tagline: { color: "rgba(229,231,235,0.75)", fontSize: 14 },

  uploadCard: {
    borderRadius: 18,
    padding: 16,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
  },
  uploadTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
  },
  uploadTitle: { fontWeight: 1000, fontSize: 16 },
  uploadHint: { marginTop: 4, fontSize: 13, color: "rgba(229,231,235,0.75)" },

  fileBtn: {
    cursor: "pointer",
    userSelect: "none",
    padding: "10px 14px",
    borderRadius: 14,
    fontWeight: 1000,
    color: "#0b1220",
    background:
      "linear-gradient(90deg, rgba(255,59,59,1), rgba(255,176,32,1), rgba(0,209,255,1))",
    border: "none",
  },

  loadedRow: {
    marginTop: 12,
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  badge: {
    fontSize: 12,
    fontWeight: 1000,
    padding: "4px 8px",
    borderRadius: 999,
    background: "rgba(34,197,94,0.18)",
    border: "1px solid rgba(34,197,94,0.35)",
  },
  dim: { opacity: 0.7 },

  errorBox: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    background: "rgba(255,59,59,0.10)",
    border: "1px solid rgba(255,59,59,0.25)",
    color: "#ffd1d1",
    fontWeight: 800,
  },

  hero: {
    marginTop: 16,
    display: "grid",
    gridTemplateColumns: "1.2fr 0.8fr",
    gap: 14,
  },
  heroLeft: {
    borderRadius: 18,
    padding: 18,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
  },
  heroLabel: {
    fontSize: 12,
    fontWeight: 1000,
    opacity: 0.75,
    letterSpacing: "0.08em",
  },
  heroNumber: { fontSize: 64, fontWeight: 1100, lineHeight: 1, marginTop: 8 },
  heroSub: {
    marginTop: 10,
    fontSize: 13,
    color: "rgba(229,231,235,0.75)",
    lineHeight: 1.35,
  },

  heroRight: {
    borderRadius: 18,
    padding: 18,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
  },
  stat: {
    borderRadius: 16,
    padding: 12,
    background: "rgba(0,0,0,0.18)",
    border: "1px solid rgba(255,255,255,0.10)",
  },
  statLabel: { fontSize: 12, opacity: 0.75, marginBottom: 6, fontWeight: 900 },
  statValue: { fontSize: 16, fontWeight: 1100 },

  hCard: {
    marginTop: 14,
    borderRadius: 18,
    padding: 16,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
  },
  hTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  hTitle: { fontWeight: 1100, fontSize: 16 },
  hHint: { marginTop: 4, fontSize: 13, color: "rgba(229,231,235,0.75)" },

  primaryBtn: {
    padding: "10px 14px",
    borderRadius: 14,
    fontWeight: 1100,
    color: "#0b1220",
    background: "linear-gradient(90deg, rgba(34,197,94,1), rgba(0,209,255,1))",
    border: "none",
    cursor: "pointer",
  },

  hGrid: {
    marginTop: 14,
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 12,
  },
  hLabel: { fontSize: 12, fontWeight: 900, opacity: 0.85, marginBottom: 6 },
  hSelect: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.20)",
    color: "#e5e7eb",
    outline: "none",
  },
  sliderRow: { display: "flex", gap: 10, alignItems: "center" },
  sliderVal: { fontWeight: 1100, width: 60, textAlign: "right" },

  hStatus: {
    marginTop: 12,
    fontSize: 13,
    color: "rgba(229,231,235,0.85)",
    fontWeight: 800,
  },

  hKPIs: {
    marginTop: 12,
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 12,
  },
  kpi: {
    borderRadius: 16,
    padding: 12,
    background: "rgba(0,0,0,0.18)",
    border: "1px solid rgba(255,255,255,0.10)",
  },
  kpiLabel: { fontSize: 12, opacity: 0.75, marginBottom: 6, fontWeight: 900 },
  kpiValue: { fontSize: 16, fontWeight: 1100 },

  tableCard: {
    marginTop: 14,
    borderRadius: 18,
    padding: 16,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
  },
  tableTitle: { fontWeight: 1100, fontSize: 18 },
  tableHint: { marginTop: 6, fontSize: 13, color: "rgba(229,231,235,0.75)" },

  tableWrap: {
    marginTop: 12,
    overflow: "auto",
    maxHeight: 440,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
    background: "rgba(0,0,0,0.12)",
  },
  th: {
    textAlign: "left",
    padding: "12px 12px",
    position: "sticky",
    top: 0,
    background: "rgba(6,9,20,0.95)",
    backdropFilter: "blur(8px)",
    borderBottom: "1px solid rgba(255,255,255,0.10)",
    fontWeight: 1100,
    whiteSpace: "nowrap",
  },
  td: {
    padding: "12px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    whiteSpace: "nowrap",
  },

  footerRow: { marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" },
  footerPill: {
    fontSize: 12,
    fontWeight: 1000,
    padding: "8px 10px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
  },
};

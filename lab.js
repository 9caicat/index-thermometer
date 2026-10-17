/* =========================================================================
   宽基温度计 · 指标实验室 — Lab logic
   全部指标由前端从 data/index_data.json 的收盘价现算，主站数据管道零改动。
   ========================================================================= */

let DATA = null;
let LABDATA = null;   // 指标实验室扩展数据（沪深300全收益 vs 二级债基）
let UPDATE_TIME = "--";

/* ──────────────  纯计算函数（与 Python 校验脚本同口径，可单测）  ── */

/** 调和均值滚动窗口：每日等额定投的真实平均成本 */
function rollingHarmonic(p, w) {
  const out = new Array(p.length).fill(null);
  let inv = 0;
  for (let t = 0; t < p.length; t++) {
    inv += 1 / p[t];
    if (t >= w) inv -= 1 / p[t - w];
    if (t >= w - 1) out[t] = w / inv;
  }
  return out;
}

/** 算术均值滚动窗口 */
function rollingMean(p, w) {
  const out = new Array(p.length).fill(null);
  let sum = 0;
  for (let t = 0; t < p.length; t++) {
    sum += p[t];
    if (t >= w) sum -= p[t - w];
    if (t >= w - 1) out[t] = sum / w;
  }
  return out;
}

/** 扩展窗口分位（样本 = 当日及之前），null 跳过；与 Python bisect 版同口径 */
function expandingPercentile(values) {
  const out = new Array(values.length).fill(null);
  const buf = [];
  for (let t = 0; t < values.length; t++) {
    const v = values[t];
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    let lo = 0, hi = buf.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (buf[m] < v) lo = m + 1; else hi = m; }
    out[t] = buf.length ? (lo / buf.length) * 100 : 0.0;
    buf.splice(lo, 0, v);
  }
  return out;
}

/** 滚动窗口分位（样本 = 前 win 日，不含当日），有序缓冲区增量维护 */
function rollingPercentile(values, win = 2500, minSamples = 250) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const buf = [];
  const bisect = (arr, x) => {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
    return lo;
  };
  for (let t = 0; t < n; t++) {
    const x = values[t];
    if (buf.length >= minSamples) out[t] = (bisect(buf, x) / buf.length) * 100;
    buf.splice(bisect(buf, x), 0, x);
    if (buf.length > win) {
      const y = values[t - win];
      buf.splice(bisect(buf, y), 1);
    }
  }
  return out;
}

/** ISO 周键：YYYY-Www（周一为一周起点） */
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // 本周周四
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + "-W" + week;
}

/** 日线 → 周线重采样：每周最后一个交易日收盘价 */
function resampleWeekly(dates, prices) {
  const wdates = [], wpx = [];
  let lastKey = null;
  for (let i = 0; i < dates.length; i++) {
    const k = isoWeekKey(dates[i]);
    if (k !== lastKey) { wdates.push(dates[i]); wpx.push(prices[i]); lastKey = k; }
    else { wdates[wdates.length - 1] = dates[i]; wpx[wpx.length - 1] = prices[i]; }
  }
  return { wdates, wpx };
}

/** 日线 → 月线重采样：每月最后一个交易日收盘价 */
function resampleMonthly(dates, prices) {
  const mdates = [], mpx = [];
  let lastKey = null;
  for (let i = 0; i < dates.length; i++) {
    const k = dates[i].slice(0, 7); // YYYY-MM
    if (k !== lastKey) { mdates.push(dates[i]); mpx.push(prices[i]); lastKey = k; }
    else { mdates[mdates.length - 1] = dates[i]; mpx[mpx.length - 1] = prices[i]; }
  }
  return { mdates, mpx };
}

/** 把月末序列前向填充对齐到任意日期轴（阶梯线效果） */
function alignMonthlyToDates(dates, mdates, mvals) {
  const out = new Array(dates.length).fill(null);
  let mi = 0, last = null;
  for (let i = 0; i < dates.length; i++) {
    while (mi < mdates.length && mdates[mi] <= dates[i]) {
      if (mvals[mi] !== null) last = mvals[mi];
      mi++;
    }
    out[i] = last;
  }
  return out;
}

/** 摆动极值点：w 日极值，间隔 >= gap，区间内取更极端者 */
function swingPoints(v, find, w = 45, gap = 45) {
  const idxs = [];
  const n = v.length;
  for (let t = w; t < n - w; t++) {
    let ok = true;
    for (let j = t - w; j <= t + w; j++) {
      if (j === t) continue;
      if (find === "low" ? v[j] < v[t] : v[j] > v[t]) { ok = false; break; }
    }
    if (!ok) continue;
    if (!idxs.length || t - idxs[idxs.length - 1] >= gap) idxs.push(t);
    else {
      const last = idxs[idxs.length - 1];
      if (find === "low" ? v[t] < v[last] : v[t] > v[last]) idxs[idxs.length - 1] = t;
    }
  }
  return idxs;
}

/** 背离事件检测（与 build_dashboard_data.py 同口径） */
function findEvents(dates, px, sent, ppct) {
  const SIG = 250;
  const events = [];
  const fwd = (b, h) => (b + h < px.length ? +(((px[b + h] / px[b]) - 1) * 100).toFixed(1) : null);
  for (const [find, typ] of [["low", "底背离"], ["high", "顶背离"]]) {
    const pts = swingPoints(px, find).filter(t => {
      if (t < SIG) return false;
      let ok = true;
      for (let j = t - SIG; j < t; j++) {
        if (find === "low" ? px[j] < px[t] : px[j] > px[t]) { ok = false; break; }
      }
      return ok;
    });
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      if (dates[b] < "2010-01-01") continue;
      const pch = (px[b] / px[a] - 1) * 100;
      const sch = sent[b] - sent[a];
      const hit = find === "low" ? (pch <= 2 && sch >= 3) : (pch >= -2 && sch <= -3);
      if (!hit) continue;
      const level = Math.abs(sch) >= 8 ? "强" : Math.abs(sch) >= 5 ? "中" : "弱";
      events.push({
        date: dates[b], prev: dates[a], t: b, type: typ, level,
        mag: +sch.toFixed(1), px: +px[b].toFixed(2),
        sent: +sent[b].toFixed(1), ppct: +ppct[b].toFixed(1),
        r60: fwd(b, 60), r120: fwd(b, 120), r250: fwd(b, 250),
      });
    }
  }
  return events;
}

/** 价格与基准线之间的色带多边形（对数轴安全：直接画闭合环） */
function bandPolygons(dates, price, base, above) {
  const segs = [];
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const poly = run.map(i => [dates[i], price[i]]);
      for (let k = run.length - 1; k >= 0; k--) poly.push([dates[run[k]], base[run[k]]]);
      segs.push(poly);
    }
    run = [];
  };
  for (let i = 0; i < price.length; i++) {
    const p = price[i], b = base[i];
    if (p !== null && b !== null && (above ? p >= b : p < b)) run.push(i);
    else flush();
  }
  flush();
  return segs;
}

const CALC = { rollingHarmonic, rollingMean, expandingPercentile, rollingPercentile,
               isoWeekKey, resampleWeekly, resampleMonthly, alignMonthlyToDates,
               swingPoints, findEvents, bandPolygons };
const _g = typeof window !== "undefined" ? window : globalThis;
_g.LAB_CALC = CALC;
if (typeof module !== "undefined" && module.exports) module.exports = CALC;

/* ══════════════════════  以下为浏览器渲染逻辑  ══════════════════════ */
function _browserMain() {

/* ──────────────  数据加载  ─────────────────────────────────────── */
function showLoadingOverlay() {
  const el = document.createElement("div");
  el.id = "loading-overlay";
  el.style.cssText = ["position:fixed", "inset:0", "display:flex", "align-items:center",
    "justify-content:center", "background:rgba(8,10,15,0.88)", "z-index:9999",
    "font-family:'Noto Sans SC',sans-serif", "font-size:1rem", "color:#8b95a8",
    "letter-spacing:0.12em"].join(";");
  el.textContent = "数据加载中…";
  document.body.appendChild(el);
}
function hideLoadingOverlay() { document.getElementById("loading-overlay")?.remove(); }

async function loadAndInit() {
  showLoadingOverlay();
  const footerMock = document.querySelector(".footer-mock");
  try {
    let raw;
    if (window.__FORCE_DATA__) {
      raw = window.__FORCE_DATA__;
    } else {
      const resp = await fetch("data/index_data.json?v=" + new Date().toISOString().slice(0, 10));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      raw = await resp.json();
    }
    DATA = raw.map(idx => ({
      code: idx.code, name: idx.name, market: idx.market,
      dates: idx.dates, prices: idx.prices, temperature: idx.temperature,
      current: idx.current,
    }));
    UPDATE_TIME = raw[0]?.update_time ?? "--";
  } catch (_) {
    DATA = window.DIAMOND_DATA;
    UPDATE_TIME = window.DIAMOND_UPDATE_TIME;
    if (footerMock) { footerMock.textContent = "⚠ 当前为模拟数据"; }
  }
  // 实验室扩展数据（沪深300全收益 vs 二级债基）：失败仅隐藏 L3，不影响其它指标
  try {
    const r2 = await fetch("data/lab_data.json?v=" + new Date().toISOString().slice(0, 10));
    if (r2.ok) LABDATA = await r2.json();
  } catch (_) { LABDATA = null; }
  hideLoadingOverlay();
  init();
}

/* ──────────────  状态与公共  ───────────────────────────────────── */
const PANEL_IDS = ["cost", "ma850", "dip"];
const _indParam = (typeof location !== "undefined" && new URLSearchParams(location.search).get("ind")) || "";
const state = {
  activeIdx: 0,
  freq: (typeof location !== "undefined" && new URLSearchParams(location.search).get("freq") === "W") ? "W" : "D",
  ind: PANEL_IDS.includes(_indParam) ? _indParam : "cost",
};
let costChart = null;
let ma850Chart = null;
let dipChart = null;

const fmtSigned = (v, digits = 1) => (v > 0 ? "+" : "") + v.toFixed(digits) + "%";
/* 每指数预计算 */
const enriched = [];
function enrichAll() {
  DATA.forEach(d => {
    const px = d.prices;
    const hm200 = rollingHarmonic(px, 200);
    const ma850 = rollingMean(px, 850);
    const { wdates, wpx } = resampleWeekly(d.dates, px);
    const ma50w = rollingMean(wpx, 50);
    const ma200w = rollingMean(wpx, 200);
    const { mdates, mpx } = resampleMonthly(d.dates, px);
    const ma210m = rollingMean(mpx, 210);   // 月度 210 均线 · 超长期成本
    enriched.push({ ...d, px, hm200, ma850, wdates, wpx, ma50w, ma200w, mdates, mpx, ma210m });
  });
}

/* ──────────────  指数切换 chips  ───────────────────────────────── */
function renderChips() {
  const host = document.getElementById("idxChips");
  host.innerHTML = "";
  enriched.forEach((d, i) => {
    const last = [...d.prices].reverse().find(v => v != null);
    const b = document.createElement("button");
    b.className = "lab-chip" + (i === state.activeIdx ? " active" : "");
    b.setAttribute("aria-pressed", i === state.activeIdx ? "true" : "false");
    b.innerHTML = `${d.name}<span class="mono">${last != null ? last.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "--"}</span>`;
    b.onclick = () => setActive(i, true);
    host.appendChild(b);
  });
}

function setActive(i, pushHash) {
  state.activeIdx = i;
  if (pushHash) history.replaceState(null, "", "#" + enriched[i].code);
  document.querySelectorAll("#idxChips .lab-chip").forEach((c, j) => {
    c.classList.toggle("active", j === i);
    c.setAttribute("aria-pressed", j === i ? "true" : "false");
  });
  renderActive();
}

/* ──────────────  指标 tab 切换（左侧定宽栏）  ───────────────────── */
function syncPanels() {
  PANEL_IDS.forEach(id => {
    const el = document.getElementById("panel-" + id);
    if (el) el.hidden = id !== state.ind;
  });
  // L3 为固定品种对比，与指数切换无关：禁用 chips
  const chips = document.getElementById("idxChips");
  if (chips) chips.classList.toggle("chips-disabled", state.ind === "dip");
}

function bindIndTabs() {
  document.querySelectorAll(".lab-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.ind === state.ind);
    btn.setAttribute("aria-selected", btn.dataset.ind === state.ind ? "true" : "false");
    btn.addEventListener("click", () => setInd(btn.dataset.ind, true));
  });
  syncPanels();
}

function setInd(ind, pushUrl) {
  state.ind = ind;
  document.querySelectorAll(".lab-tab").forEach(b => {
    const on = b.dataset.ind === ind;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  syncPanels();
  if (pushUrl && typeof URLSearchParams !== "undefined") {
    const q = new URLSearchParams(location.search);
    if (ind === "cost") q.delete("ind"); else q.set("ind", ind);
    const qs = q.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  }
  renderActive();
}

function renderActive() {
  if (state.ind === "ma850") renderMa850();
  else if (state.ind === "dip") renderDip();
  else renderCost();
}

/* ──────────────  图表公共  ─────────────────────────────────────── */
/** 把纵轴边界取整到 1-2-2.5-5 式的漂亮刻度 */
function niceBounds(lo, hi) {
  const r = (x, dir) => {
    const mag = Math.pow(10, Math.floor(Math.log10(x)));
    const norm = x / mag;
    const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    if (dir < 0) { for (let i = steps.length - 1; i >= 0; i--) if (steps[i] <= norm + 1e-9) return steps[i] * mag; return mag; }
    for (const s of steps) if (s >= norm - 1e-9) return s * mag;
    return 10 * mag;
  };
  return { min: Math.max(1, r(lo, -1)), max: r(hi, +1) };
}

/** 预览在 iframe 里时，鼠标拖出窗口才松开会导致图表收不到 mouseup、停在拖拽态跟随鼠标；
    指针离开页面时补发一个 mouseup 兜底 */
function attachMouseupFix(hostId) {
  document.addEventListener("mouseleave", () => {
    const host = document.getElementById(hostId);
    if (!host) return;
    ["mouseup", "pointerup"].forEach(type => {
      try { host.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })); } catch (_) {}
    });
  });
}

/** 锁定收盘价序列：图例点击不可隐藏价格线（其余序列保持可切换） */
function attachPriceLock(chart) {
  chart.on("legendselectchanged", (e) => {
    const sel = e.selected || {};
    if (sel["收盘价"] === false) {
      chart.setOption({ legend: { selected: { "收盘价": true } } });
    }
  });
}

/** 缩放/平移时纵轴自适应可见区间（TradingView 风格） */
function attachZoomAdaptive(chart, getArrays) {
  chart.on("datazoom", () => {
    const dz = chart.getOption().dataZoom[0];
    const arrays = getArrays();
    const n = arrays[0].length;
    const lo = Math.max(0, Math.floor(n * dz.start / 100));
    const hi = Math.min(n - 1, Math.ceil(n * dz.end / 100));
    let mn = Infinity, mx = 0;
    for (const arr of arrays) {
      for (let i = lo; i <= hi; i++) {
        const v = arr[i];
        if (v !== null && v > 0) { if (v < mn) mn = v; if (v > mx) mx = v; }
      }
    }
    if (!isFinite(mn) || mx <= mn) return;
    const b = niceBounds(mn * 0.96, mx * 1.04);
    chart.setOption({ yAxis: [{ min: b.min, max: b.max }, { min: b.min, max: b.max }] });
  });
}

function baseYAxis(initBounds) {
  return {
    type: "log", logBase: 10,
    min: initBounds.min, max: initBounds.max,
    axisLine: { show: false }, axisTick: { show: false },
    axisLabel: {
      color: "#4d5666", fontSize: 10, fontFamily: "JetBrains Mono, monospace",
      formatter: (v) => v >= 1000 ? v.toLocaleString("en-US") : String(v),
    },
    splitLine: { lineStyle: { color: "rgba(255,255,255,0.035)" } },
  };
}

function baseXAxis() {
  return {
    type: "time",
    axisLine: { lineStyle: { color: "rgba(255,255,255,0.08)" } },
    axisTick: { show: false },
    axisLabel: {
      color: "#4d5666", fontSize: 10, fontFamily: "JetBrains Mono, monospace",
      formatter: (v) => { const dt = new Date(v); return isFinite(dt) ? String(dt.getUTCFullYear()) : ""; },
      hideOverlap: true,
    },
    splitLine: { show: false },
  };
}

/* 移动端判定：加高加粗底部滑块，方便手指拖按 */
const IS_MOBILE = typeof window !== "undefined" && typeof window.matchMedia === "function" &&
  (window.matchMedia("(max-width: 760px)").matches || "ontouchstart" in window);

function baseDataZoom() {
  return [
    { type: "inside", xAxisIndex: 0, start: 0, end: 100 },
    {
      type: "slider", xAxisIndex: 0, start: 0, end: 100,
      height: IS_MOBILE ? 30 : 18, bottom: IS_MOBILE ? 8 : 12,
      handleSize: IS_MOBILE ? 26 : "100%",
      borderColor: "transparent", backgroundColor: "rgba(14,18,25,0.4)",
      fillerColor: "rgba(245,230,196,0.10)",
      dataBackground: { areaStyle: { color: "rgba(103,232,249,0.18)" }, lineStyle: { color: "rgba(103,232,249,0.4)", width: 0.8 } },
      selectedDataBackground: { areaStyle: { color: "rgba(245,230,196,0.22)" }, lineStyle: { color: "rgba(245,230,196,0.6)", width: 0.8 } },
      handleStyle: { color: "#f5e6c4", borderColor: "transparent", opacity: 0.9 },
      moveHandleSize: 0,   // 禁用移动把手：避免点击后进入「跟随鼠标」模式
      textStyle: { color: "#8b95a8", fontSize: IS_MOBILE ? 10 : 9, fontFamily: "JetBrains Mono, monospace" },
    },
  ];
}

function baseTooltipStyle() {
  return {
    backgroundColor: "rgba(14, 18, 25, 0.97)",
    borderColor: "rgba(255,255,255,0.18)", borderWidth: 1, padding: [10, 12],
    textStyle: { color: "#f6f8fb", fontSize: 12, fontFamily: "Geist, Noto Sans SC, sans-serif" },
    axisPointer: { type: "line", lineStyle: { color: "rgba(245,230,196,0.5)", width: 1 } },
  };
}

function baseLegend(data) {
  return {
    data,
    top: 8, left: "center",
    textStyle: { color: "#8b95a8", fontSize: IS_MOBILE ? 10 : 11, fontFamily: "Geist, Noto Sans SC, sans-serif" },
    icon: "roundRect", itemWidth: IS_MOBILE ? 12 : 14, itemHeight: 3, itemGap: IS_MOBILE ? 10 : 20,
    inactiveColor: "#3d4453",
  };
}

function fullExtentBounds(arrays) {
  let yMin = Infinity, yMax = 0;
  for (const arr of arrays) {
    for (const v of arr) {
      if (v !== null && v > 0) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
    }
  }
  return niceBounds(yMin * 0.96, yMax * 1.04);
}

/* ──────────────  成本锚图表  ─────────────────────────────────────
   配色借鉴 CoinGlass 风格：价格线按「线上=浮盈(琥珀)/线下=浮亏(蓝)」
   分段变色，成本线用高饱和实线，远线用亮色实线保证对比度。 */
const C_PRICE_ABOVE = "#fbbf24";  // 黄（不变）：价格在成本线上方
const C_PRICE_BELOW = "#38bdf8";  // 亮蓝：价格在成本线下方
const C_NEAR = "#f472b6";         // 玫红：近端成本线（定投线/50周线）
const C_FAR = "#a78bfa";          // 紫：远端成本线（850日线/200周线）
const C_MONTH = "#22c55e";        // 绿：210月均线（超长期成本）

/** 数组最后一个非 null 值（取整），图例展示最新读数用 */
function lastVal(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null) return Math.round(arr[i]);
  return null;
}
const lvTag = (v) => (v === null ? "" : " · " + v);

function buildCostOption(d) {
  const weekly = state.freq === "W";
  const dates = weekly ? d.wdates : d.dates;
  const px = weekly ? d.wpx : d.px;
  const near = weekly ? d.ma50w : d.hm200;     // 近端成本线
  const far = weekly ? d.ma200w : d.ma850;     // 远端成本线
  const month = alignMonthlyToDates(dates, d.mdates, d.ma210m);  // 210月均线（阶梯对齐）
  const nearName = (weekly ? "50周线" : "定投成本线") + lvTag(lastVal(near));
  const farName = (weekly ? "200周线" : "850日均线") + lvTag(lastVal(far));
  const monthName = "210月均线" + lvTag(lastVal(month));

  // 价格线三段数据：[日期, 价格, 状态] 状态 1=线上 0=线下 0.5=无基准
  const pxTriples = dates.map((t, i) => {
    const p = px[i], n = near[i];
    const flag = (p !== null && n !== null) ? (p >= n ? 1 : 0) : 0.5;
    return [t, p, flag];
  });
  const nearPairs = dates.map((t, i) => [t, near[i]]);
  const farPairs = dates.map((t, i) => [t, far[i]]);
  const monthPairs = dates.map((t, i) => [t, month[i]]);

  // 初始纵轴范围 = 全部数据极值 ±8% 边距（收紧到数据本身，不取 10 的整次幂）
  const initBounds = fullExtentBounds([px, near, far, month]);
  const yAxisBase = baseYAxis(initBounds);

  // 日期 → 下标映射：tooltip 直接从数组取值（LTTB 抽样下按 series 名取参不可靠）
  const idxOf = new Map(dates.map((t, i) => [t, i]));
  const tsToKey = (ts) => {
    const dt = new Date(ts);   // ECharts 按本地时区解析日期串，取本地年月日对齐
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };

  return {
    backgroundColor: "transparent",
    animation: false,
    grid: { left: 56, right: 56, top: 42, bottom: 62 },
    legend: baseLegend(["收盘价", nearName, farName, monthName]),
    visualMap: {
      show: false,
      type: "piecewise",
      seriesIndex: 3,          // 收盘价序列
      dimension: 2,            // 按第三维（线上/线下状态）着色
      pieces: [
        { min: 0.5, max: 1.5, color: C_PRICE_ABOVE },
        { min: -0.5, max: 0.5, color: C_PRICE_BELOW },
      ],
    },
    tooltip: {
      trigger: "axis",
      ...baseTooltipStyle(),
      formatter: (params) => {
        const date = params[0].axisValueLabel;
        const i = idxOf.get(tsToKey(params[0].axisValue));
        const val = (arr) => (i === undefined ? null : arr[i]);
        const p = val(px), n = val(near), f = val(far), m = val(month);
        let html = `<div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#8b95a8;letter-spacing:0.08em;margin-bottom:8px;">${date}</div>`;
        const stateTxt = (p == null || n == null) ? "" : (p >= n
          ? `<span style="font-size:10px;color:${C_PRICE_ABOVE};">线上 · 定投者浮盈</span>`
          : `<span style="font-size:10px;color:${C_PRICE_BELOW};">线下 · 定投者浮亏</span>`);
        const row = (label, v, color) => {
          const short = label.split(" · ")[0];   // 图例名含最新值，tooltip 里用短名
          const vTxt = (v === null || v === undefined) ? "--" : v.toFixed(2);   // 均线 warmup 期内统一显示 --
          return `<div style="display:flex;justify-content:space-between;gap:18px;margin-bottom:4px;">
            <span style="font-size:11px;color:#8b95a8;">${short}</span>
            <span style="font-family:'Chakra Petch',sans-serif;font-size:13px;font-weight:600;color:${color};font-variant-numeric:tabular-nums;">${vTxt}</span></div>`;
        };
        html += row("收盘价", p, C_PRICE_ABOVE);   // 数值恒定黄色，与收盘价图例一致
        html += stateTxt;
        html += row(nearName, n, C_NEAR);
        html += row(farName, f, C_FAR);
        html += row(monthName, m, C_MONTH);
        return html;
      },
    },
    xAxis: baseXAxis(),
    yAxis: [
      { ...yAxisBase, position: "left" },
      { ...yAxisBase, position: "right", splitLine: { show: false } },
    ],
    dataZoom: baseDataZoom(),
    series: [
      { name: monthName, type: "line", data: monthPairs, showSymbol: false, sampling: "lttb",
        lineStyle: { color: C_MONTH, width: 1.4 },
        itemStyle: { color: C_MONTH }, z: 2 },
      { name: farName, type: "line", data: farPairs, showSymbol: false, sampling: "lttb",
        lineStyle: { color: C_FAR, width: 1.3 },
        itemStyle: { color: C_FAR }, z: 2 },
      { name: nearName, type: "line", data: nearPairs, showSymbol: false, sampling: "lttb",
        lineStyle: { color: C_NEAR, width: 1.6 },
        itemStyle: { color: C_NEAR }, z: 3 },
      { name: "收盘价", type: "line", data: pxTriples,
        showSymbol: false, sampling: "lttb",
        lineStyle: { width: 2 },
        itemStyle: { color: C_PRICE_ABOVE }, z: 4 },
    ],
  };
}

function renderCost() {
  const d = enriched[state.activeIdx];
  if (!costChart) {
    costChart = echarts.init(document.getElementById("costChart"), null, { renderer: "canvas" });
    attachMouseupFix("costChart");
    attachPriceLock(costChart);
    attachZoomAdaptive(costChart, () => {
      const cur = enriched[state.activeIdx];
      const dates = state.freq === "W" ? cur.wdates : cur.dates;
      const month = alignMonthlyToDates(dates, cur.mdates, cur.ma210m);
      return state.freq === "W"
        ? [cur.wpx, cur.ma50w, cur.ma200w, month]
        : [cur.px, cur.hm200, cur.ma850, month];
    });
  }
  costChart.setOption(buildCostOption(d), true);

  // 读数条
  const weekly = state.freq === "W";
  const near = weekly ? d.ma50w : d.hm200;
  const far = weekly ? d.ma200w : d.ma850;
  const dates = weekly ? d.wdates : d.dates;
  const month = alignMonthlyToDates(dates, d.mdates, d.ma210m);
  const nI = [...near].map((v, i) => v === null ? -1 : i).reduce((a, b) => Math.max(a, b));
  const fI = [...far].map((v, i) => v === null ? -1 : i).reduce((a, b) => Math.max(a, b));
  const mI = [...month].map((v, i) => v === null ? -1 : i).reduce((a, b) => Math.max(a, b));
  const p = d.px[d.px.length - 1], nv = near[nI], fv = far[fI], mv = month[mI];
  const stat = (label, base) => {
    if (base == null || p == null) return "";
    const dev = (p / base - 1) * 100;
    const cls = dev >= 0 ? "pos" : "neg";
    return `<span class="lab-stat"><span class="k">${label}</span><span class="v ${cls}">${fmtSigned(dev)}</span></span>`;
  };
  document.getElementById("costReadout").innerHTML =
    `<span class="lab-stat"><span class="k">现价</span><span class="v">${p.toFixed(2)}</span></span>
     <span class="lab-sep">·</span>` +
    stat(weekly ? "偏离 50周线" : "偏离 定投线", nv) +
    `<span class="lab-sep">·</span>` +
    stat(weekly ? "偏离 200周线" : "偏离 850日线", fv) +
    `<span class="lab-sep">·</span>` +
    stat("偏离 210月线", mv) +
``;
}

/* ──────────────  MA850 黄金乘数图表（仅日线）  ───────────────────
   对应 TradingView Pine：850 日均线 + ×1.6 / ×2 / ×3 / ×5 乘数带。 */
const C_MA850 = "#3b82f6";        // 蓝：850 均线（Pine color.blue）
const C_X16 = "#ef4444";          // 红：1.6 倍（Pine color.red）
const C_X2 = "#22c55e";           // 绿：2 倍（Pine color.green）
const C_X3 = "#f97316";           // 橙：3 倍（Pine color.orange）
const C_X5 = "#db42a1";           // 品红：5 倍（Pine rgb(219,66,161)）
const C_MA_PRICE = "#fbbf24";     // 琥珀：收盘价

function buildMa850Option(d) {
  const dates = d.dates;
  const px = d.px;
  const base = d.ma850;
  const baseName = "850均线" + lvTag(lastVal(base));
  const bands = {
    x16: base.map(v => v === null ? null : v * 1.6),
    x2:  base.map(v => v === null ? null : v * 2),
    x3:  base.map(v => v === null ? null : v * 3),
    x5:  base.map(v => v === null ? null : v * 5),
  };
  const bandNames = {
    x16: "1.6倍" + lvTag(lastVal(bands.x16)),
    x2:  "2倍" + lvTag(lastVal(bands.x2)),
    x3:  "3倍" + lvTag(lastVal(bands.x3)),
    x5:  "5倍" + lvTag(lastVal(bands.x5)),
  };

  const pxPairs = dates.map((t, i) => [t, px[i]]);
  const basePairs = dates.map((t, i) => [t, base[i]]);
  const bandPairs = {
    x16: dates.map((t, i) => [t, bands.x16[i]]),
    x2:  dates.map((t, i) => [t, bands.x2[i]]),
    x3:  dates.map((t, i) => [t, bands.x3[i]]),
    x5:  dates.map((t, i) => [t, bands.x5[i]]),
  };

  // 初始纵轴范围需覆盖最高的 5 倍带
  const initBounds = fullExtentBounds([px, base, bands.x16, bands.x2, bands.x3, bands.x5]);
  const yAxisBase = baseYAxis(initBounds);

  const legendNames = ["收盘价", baseName, bandNames.x16, bandNames.x2, bandNames.x3, bandNames.x5];

  // 日期 → 下标映射：tooltip 直接从数组取值（LTTB 抽样下按 series 名取参不可靠）
  const idxOf = new Map(dates.map((t, i) => [t, i]));
  const tsToKey = (ts) => {
    const dt = new Date(ts);   // ECharts 按本地时区解析日期串，取本地年月日对齐
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };

  return {
    backgroundColor: "transparent",
    animation: false,
    grid: { left: 56, right: 56, top: 42, bottom: 62 },
    legend: baseLegend(legendNames),
    tooltip: {
      trigger: "axis",
      ...baseTooltipStyle(),
      formatter: (params) => {
        const date = params[0].axisValueLabel;
        const i = idxOf.get(tsToKey(params[0].axisValue));
        const val = (arr) => (i === undefined ? null : arr[i]);
        const p = val(px), b = val(base);
        let html = `<div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#8b95a8;letter-spacing:0.08em;margin-bottom:8px;">${date}</div>`;
        const row = (label, v, color) => {
          const short = label.split(" · ")[0];   // 图例名含最新值，tooltip 里用短名
          const vTxt = (v === null || v === undefined) ? "--" : v.toFixed(2);   // 均线 warmup 期内统一显示 --
          return `<div style="display:flex;justify-content:space-between;gap:18px;margin-bottom:4px;">
            <span style="font-size:11px;color:#8b95a8;">${short}</span>
            <span style="font-family:'Chakra Petch',sans-serif;font-size:13px;font-weight:600;color:${color};font-variant-numeric:tabular-nums;">${vTxt}</span></div>`;
        };
        html += row("收盘价", p, C_MA_PRICE);   // 数值恒定黄色，与收盘价图例一致
        html += row(baseName, b, C_MA850);
        html += row(bandNames.x16, val(bands.x16), C_X16);
        html += row(bandNames.x2, val(bands.x2), C_X2);
        html += row(bandNames.x3, val(bands.x3), C_X3);
        html += row(bandNames.x5, val(bands.x5), C_X5);
        return html;
      },
    },
    xAxis: baseXAxis(),
    yAxis: [
      { ...yAxisBase, position: "left" },
      { ...yAxisBase, position: "right", splitLine: { show: false } },
    ],
    dataZoom: baseDataZoom(),
    series: [
      { name: bandNames.x5, type: "line", data: bandPairs.x5, showSymbol: false, sampling: "lttb",
        lineStyle: { color: C_X5, width: 1.2 }, itemStyle: { color: C_X5 }, z: 2 },
      { name: bandNames.x3, type: "line", data: bandPairs.x3, showSymbol: false, sampling: "lttb",
        lineStyle: { color: C_X3, width: 1.2 }, itemStyle: { color: C_X3 }, z: 3 },
      { name: bandNames.x2, type: "line", data: bandPairs.x2, showSymbol: false, sampling: "lttb",
        lineStyle: { color: C_X2, width: 1.3 }, itemStyle: { color: C_X2 }, z: 4 },
      { name: bandNames.x16, type: "line", data: bandPairs.x16, showSymbol: false, sampling: "lttb",
        lineStyle: { color: C_X16, width: 1.4 }, itemStyle: { color: C_X16 }, z: 5 },
      { name: baseName, type: "line", data: basePairs, showSymbol: false, sampling: "lttb",
        lineStyle: { color: C_MA850, width: 2 }, itemStyle: { color: C_MA850 }, z: 6 },
      { name: "收盘价", type: "line", data: pxPairs, showSymbol: false, sampling: "lttb",
        lineStyle: { color: C_MA_PRICE, width: 2 }, itemStyle: { color: C_MA_PRICE }, z: 7 },
    ],
  };
}

function renderMa850() {
  const d = enriched[state.activeIdx];
  if (!ma850Chart) {
    ma850Chart = echarts.init(document.getElementById("ma850Chart"), null, { renderer: "canvas" });
    attachMouseupFix("ma850Chart");
    attachPriceLock(ma850Chart);
    attachZoomAdaptive(ma850Chart, () => {
      const cur = enriched[state.activeIdx];
      return [cur.px, cur.ma850, cur.ma850.map(v => v === null ? null : v * 5)];
    });
  }
  ma850Chart.setOption(buildMa850Option(d), true);

  // 读数条
  const px = d.px;
  const base = d.ma850;
  const bI = [...base].map((v, i) => v === null ? -1 : i).reduce((a, b) => Math.max(a, b));
  const p = px[px.length - 1], bv = base[bI];
  const devHtml = (bv == null || p == null) ? "" : (() => {
    const dev = (p / bv - 1) * 100;
    const cls = dev >= 0 ? "pos" : "neg";
    return `<span class="lab-stat"><span class="k">偏离 850均线</span><span class="v ${cls}">${fmtSigned(dev)}</span></span>`;
  })();
  document.getElementById("ma850Readout").innerHTML =
    `<span class="lab-stat"><span class="k">现价</span><span class="v">${p.toFixed(2)}</span></span>
     <span class="lab-sep">·</span>` +
    devHtml +
``;
}

/* ──────────────  沪深300超跌基准（L3）  ─────────────────────────────
   沪深300全收益 vs 二级债基：同起点等效（起点=1000），红点=历次跌破起点。 */
const C_DIP_PRICE = "#fbbf24";    // 琥珀：沪深300全收益
const C_DIP_BENCH = "#f472b6";    // 玫红：等效基准线
const C_DIP_MARK = "#ef4444";     // 红：跌破起点

let dipData = null;
const DIP_CAL = 1.64;          // 校准系数：中证债券基金 H11023 × 1.64 ≈ 万得二级债基 885007 轨迹（口径见指标说明）
const DIP_BASE = "2004-12-31"; // 沪深300全收益基日
function buildDipData() {
  if (!LABDATA || !LABDATA.csi300tr || !LABDATA.bond2) return null;
  const a = LABDATA.csi300tr, b = LABDATA.bond2;
  const bMap = new Map(b.dates.map((t, i) => [t, b.prices[i]]));
  const dates = [], pxRaw = [], bnRaw = [];
  for (let i = 0; i < a.dates.length; i++) {
    const t = a.dates[i];
    if (t < DIP_BASE) continue;   // H00300 基日前的回填值跳过
    const bv = bMap.get(t);
    if (bv != null && a.prices[i] != null) { dates.push(t); pxRaw.push(a.prices[i]); bnRaw.push(bv); }
  }
  if (dates.length < 2) return null;
  const p0 = pxRaw[0], b0 = bnRaw[0];
  const px = pxRaw.map(v => +(v / p0 * 1000).toFixed(2));
  const bn = bnRaw.map(v => +(v / b0 * DIP_CAL * 1000).toFixed(2));
  // 跌破区段：间隔 ≤15 个交易日的相邻区段合并为一个事件，标记事件起点
  const segs = [];
  let inSeg = false;
  for (let i = 0; i < px.length; i++) {
    const bl = px[i] < bn[i];
    if (bl && !inSeg) { segs.push([i, i]); inSeg = true; }
    else if (!bl && inSeg) { segs[segs.length - 1][1] = i - 1; inSeg = false; }
  }
  if (inSeg) segs[segs.length - 1][1] = px.length - 1;
  const events = [];
  for (const s of segs) {
    if (events.length && s[0] - events[events.length - 1][1] <= 15) events[events.length - 1][1] = s[1];
    else events.push(s);
  }
  const dips = events.map(e => e[0]);
  return { dates, px, bn, dips, rawLast: pxRaw[pxRaw.length - 1] };
}

function buildDipOption(dd) {
  const dates = dd.dates;
  const pxPairs = dates.map((t, i) => [t, dd.px[i]]);
  const bnPairs = dates.map((t, i) => [t, dd.bn[i]]);
  const markPairs = dd.dips.map(i => [dates[i], dd.px[i]]);
  const markName = `跌破起点 (${dd.dips.length}次)`;

  const initBounds = fullExtentBounds([dd.px, dd.bn]);
  // 线性轴 + 累计涨幅% 刻度（参考 @北漂民工 原图风格：起点 0%，等距百分比）
  const yAxisBase = {
    type: "value",
    min: initBounds.min, max: initBounds.max,
    axisLine: { show: false }, axisTick: { show: false },
    axisLabel: {
      color: "#4d5666", fontSize: 10, fontFamily: "JetBrains Mono, monospace",
      formatter: (v) => Math.round(v / 10 - 100) + "%",   // 等效值 1000 → 0%
    },
    splitLine: { lineStyle: { color: "rgba(255,255,255,0.035)" } },
  };

  // 日期 → 下标映射：tooltip 直接从数组取值（LTTB 抽样下按 series 名取参不可靠）
  const idxOf = new Map(dates.map((t, i) => [t, i]));
  const tsToKey = (ts) => {
    const dt = new Date(ts);   // ECharts 按本地时区解析日期串，取本地年月日对齐
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  };

  return {
    backgroundColor: "transparent",
    animation: false,
    grid: { left: 56, right: 56, top: 42, bottom: 62 },
    legend: baseLegend(["沪深300全收益", "等效基准线"]),   // 跌破红点只在图上标注，不进图例
    tooltip: {
      trigger: "axis",
      ...baseTooltipStyle(),
      formatter: (params) => {
        const date = params[0].axisValueLabel;
        const i = idxOf.get(tsToKey(params[0].axisValue));
        const val = (arr) => (i === undefined ? null : arr[i]);
        const p = val(dd.px), b = val(dd.bn);
        let html = `<div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#8b95a8;letter-spacing:0.08em;margin-bottom:8px;">${date}</div>`;
        // 直接以累计涨幅%为主值展示（起点=0%），与参考图一致
        const row = (label, v, color) => {
          const vTxt = (v === null || v === undefined) ? "--" : fmtSigned(v / 10 - 100, 1);
          return `<div style="display:flex;justify-content:space-between;gap:18px;margin-bottom:4px;">
            <span style="font-size:11px;color:#8b95a8;">${label}</span>
            <span style="font-family:'Chakra Petch',sans-serif;font-size:13px;font-weight:600;color:${color};font-variant-numeric:tabular-nums;">${vTxt}</span></div>`;
        };
        html += row("沪深300全收益", p, C_DIP_PRICE);
        html += row("等效基准线", b, C_DIP_BENCH);
        if (p != null && b != null) {
          const dev = (p / b - 1) * 100;
          const color = dev >= 0 ? "#22c55e" : "#ff3344";   // 红跌绿涨
          html += `<span style="font-size:10px;color:${color};">${dev >= 0 ? "高于" : "低于"}基准 ${fmtSigned(dev, 2)}</span>`;
        }
        return html;
      },
    },
    xAxis: baseXAxis(),
    yAxis: [
      { ...yAxisBase, position: "left" },
      { ...yAxisBase, position: "right", splitLine: { show: false } },
    ],
    dataZoom: baseDataZoom(),
    series: [
      { name: "等效基准线", type: "line", data: bnPairs, showSymbol: false, sampling: "lttb",
        lineStyle: { color: C_DIP_BENCH, width: 1.8 }, itemStyle: { color: C_DIP_BENCH }, z: 2 },
      { name: "沪深300全收益", type: "line", data: pxPairs, showSymbol: false, sampling: "lttb",
        lineStyle: { color: C_DIP_PRICE, width: 2 }, itemStyle: { color: C_DIP_PRICE }, z: 3 },
      { name: markName, type: "scatter", data: markPairs, symbolSize: 8,
        itemStyle: { color: C_DIP_MARK, borderColor: "rgba(255,255,255,0.85)", borderWidth: 1 },
        tooltip: { show: false }, z: 4 },
    ],
  };
}

function renderDip() {
  if (!dipData) return;
  if (!dipChart) {
    dipChart = echarts.init(document.getElementById("dipChart"), null, { renderer: "canvas" });
    attachMouseupFix("dipChart");
    attachZoomAdaptive(dipChart, () => [dipData.px, dipData.bn]);
  }
  dipChart.setOption(buildDipOption(dipData), true);

  // 读数条
  const dd = dipData;
  const pL = dd.px[dd.px.length - 1], bL = dd.bn[dd.bn.length - 1];
  const dev = (pL / bL - 1) * 100;
  const cls = dev >= 0 ? "pos" : "neg";
  document.getElementById("dipReadout").innerHTML =
    `<span class="lab-stat"><span class="k">沪深300全收益</span><span class="v">${dd.rawLast.toFixed(2)}</span></span>
     <span class="lab-sep">·</span>` +
    `<span class="lab-stat"><span class="k">偏离基准</span><span class="v ${cls}">${fmtSigned(dev)}</span></span>
     <span class="lab-sep">·</span>` +
    `<span class="lab-stat"><span class="k">历史跌破</span><span class="v">${dd.dips.length} 次</span></span>` +
``;
}

/* ──────────────  周期切换  ─────────────────────────────────────── */
function bindFreq() {
  document.querySelectorAll("[data-freq]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.freq === state.freq);
    btn.addEventListener("click", () => {
      state.freq = btn.dataset.freq;
      document.querySelectorAll("[data-freq]").forEach(b => b.classList.toggle("active", b === btn));
      renderActive();
    });
  });
}

/* ──────────────  Init  ─────────────────────────────────────────── */
function init() {
  document.getElementById("update-time").textContent = UPDATE_TIME.replace(/\s*CST$/i, "");
  enrichAll();

  // L3 超跌基准数据：缺失时隐藏 tab，不让用户点到空面板
  dipData = buildDipData();
  if (!dipData) {
    const t = document.querySelector('.lab-tab[data-ind="dip"]');
    if (t) t.style.display = "none";
    if (state.ind === "dip") state.ind = "cost";
  }

  // hash 同步指数选择
  const h = (location.hash || "").replace("#", "");
  const hi = enriched.findIndex(d => d.code === h);
  if (hi >= 0) state.activeIdx = hi;

  renderChips();
  bindIndTabs();
  bindFreq();
  renderActive();

  window.addEventListener("resize", () => {
    costChart && costChart.resize();
    ma850Chart && ma850Chart.resize();
    dipChart && dipChart.resize();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", loadAndInit);
} else {
  loadAndInit();
}
}

if (typeof window !== "undefined") _browserMain();

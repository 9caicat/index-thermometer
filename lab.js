/* =========================================================================
   宽基温度计 · 指标实验室 — Lab logic
   全部指标由前端从 data/index_data.json 的收盘价现算，主站数据管道零改动。
   ========================================================================= */

let DATA = null;
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
               isoWeekKey, resampleWeekly, swingPoints, findEvents, bandPolygons };
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
      const resp = await fetch("data/index_data.json");
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
  } finally {
    hideLoadingOverlay();
  }
  init();
}

/* ──────────────  状态与公共  ───────────────────────────────────── */
const state = {
  activeIdx: 0,
  freq: (typeof location !== "undefined" && new URLSearchParams(location.search).get("freq") === "W") ? "W" : "D",
};
let costChart = null;

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
    enriched.push({ ...d, px, hm200, ma850, wdates, wpx, ma50w, ma200w });
  });
}

/* ──────────────  指数切换 chips  ───────────────────────────────── */
function renderChips() {
  const host = document.getElementById("idxChips");
  host.innerHTML = "";
  enriched.forEach((d, i) => {
    const temp = [...d.temperature].reverse().find(v => v != null);
    const b = document.createElement("button");
    b.className = "lab-chip" + (i === state.activeIdx ? " active" : "");
    b.setAttribute("aria-pressed", i === state.activeIdx ? "true" : "false");
    b.innerHTML = `${d.name}<span class="mono">${temp != null ? Math.round(temp) + "°" : "--"}</span>`;
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
  renderCost();
}

/* ──────────────  成本锚图表  ───────────────────────────────────── */
/* ──────────────  成本锚图表  ─────────────────────────────────────
   配色借鉴 CoinGlass 风格：价格线按「线上=浮盈(琥珀)/线下=浮亏(蓝)」
   分段变色，成本线用高饱和实线，远线用亮色实线保证对比度。 */
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

const C_PRICE_ABOVE = "#fbbf24";  // 黄（不变）：价格在成本线上方
const C_PRICE_BELOW = "#38bdf8";  // 亮蓝：价格在成本线下方
const C_NEAR = "#f472b6";         // 玫红：近端成本线（定投线/50周线）
const C_FAR = "#a78bfa";          // 紫：远端成本线（850日线/200周线）

function buildCostOption(d) {
  const weekly = state.freq === "W";
  const dates = weekly ? d.wdates : d.dates;
  const px = weekly ? d.wpx : d.px;
  const near = weekly ? d.ma50w : d.hm200;     // 近端成本线
  const far = weekly ? d.ma200w : d.ma850;     // 远端成本线
  const nearName = weekly ? "50周线 · 一年成本" : "定投成本线 · 200日调和";
  const farName = weekly ? "200周线 · 四年成本" : "850日均线 · 3.5年成本";

  // 价格线三段数据：[日期, 价格, 状态] 状态 1=线上 0=线下 0.5=无基准
  const pxTriples = dates.map((t, i) => {
    const p = px[i], n = near[i];
    const flag = (p !== null && n !== null) ? (p >= n ? 1 : 0) : 0.5;
    return [t, p, flag];
  });
  const nearPairs = dates.map((t, i) => [t, near[i]]);
  const farPairs = dates.map((t, i) => [t, far[i]]);

  // 初始纵轴范围 = 全部数据极值 ±8% 边距（收紧到数据本身，不取 10 的整次幂）
  let yMin = Infinity, yMax = 0;
  for (const arr of [px, near, far]) {
    for (const v of arr) {
      if (v !== null && v > 0) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
    }
  }
  const initBounds = niceBounds(yMin * 0.96, yMax * 1.04);
  const yAxisBase = {
    type: "log", logBase: 10,
    min: initBounds.min, max: initBounds.max,
    axisLine: { show: false }, axisTick: { show: false },
    axisLabel: {
      color: "#4d5666", fontSize: 10, fontFamily: "JetBrains Mono, monospace",
      formatter: (v) => v >= 1000 ? v.toLocaleString("en-US") : String(v),
    },
    splitLine: { lineStyle: { color: "rgba(255,255,255,0.035)" } },
  };

  return {
    backgroundColor: "transparent",
    animation: false,
    grid: { left: 56, right: 56, top: 42, bottom: 62 },
    legend: {
      data: ["收盘价", nearName, farName],
      top: 8, left: "center",
      textStyle: { color: "#8b95a8", fontSize: 11, fontFamily: "Geist, Noto Sans SC, sans-serif" },
      icon: "roundRect", itemWidth: 14, itemHeight: 3, itemGap: 20,
      inactiveColor: "#3d4453",
    },
    visualMap: {
      show: false,
      type: "piecewise",
      seriesIndex: 2,          // 收盘价序列
      dimension: 2,            // 按第三维（线上/线下状态）着色
      pieces: [
        { min: 0.5, max: 1.5, color: C_PRICE_ABOVE },
        { min: -0.5, max: 0.5, color: C_PRICE_BELOW },
      ],
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(14, 18, 25, 0.97)",
      borderColor: "rgba(255,255,255,0.18)", borderWidth: 1, padding: [10, 12],
      textStyle: { color: "#f6f8fb", fontSize: 12, fontFamily: "Geist, Noto Sans SC, sans-serif" },
      formatter: (params) => {
        const date = params[0].axisValueLabel;
        const get = (name) => { const p = params.find(x => x.seriesName === name); return p ? p.value[1] : null; };
        const p = get("收盘价"), n = get(nearName), f = get(farName);
        let html = `<div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#8b95a8;letter-spacing:0.08em;margin-bottom:8px;">${date}</div>`;
        const stateTxt = (p == null || n == null) ? "" : (p >= n
          ? `<span style="font-size:10px;color:${C_PRICE_ABOVE};">线上 · 定投者浮盈 ${fmtSigned((p / n - 1) * 100, 2)}</span>`
          : `<span style="font-size:10px;color:${C_PRICE_BELOW};">线下 · 定投者浮亏 ${fmtSigned((p / n - 1) * 100, 2)}</span>`);
        const row = (label, val, color, devBase) => {
          if (val == null) return "";
          const dev = devBase ? `<span style="font-size:10px;color:#8b95a8;margin-left:8px;">${fmtSigned((val / devBase - 1) * 100, 2)}</span>` : "";
          return `<div style="display:flex;justify-content:space-between;gap:18px;margin-bottom:4px;">
            <span style="font-size:11px;color:#8b95a8;">${label}</span>
            <span style="font-family:'Chakra Petch',sans-serif;font-size:13px;font-weight:600;color:${color};font-variant-numeric:tabular-nums;">${val.toFixed(2)}${dev}</span></div>`;
        };
        html += row("收盘价", p, p != null && n != null && p >= n ? C_PRICE_ABOVE : C_PRICE_BELOW);
        html += stateTxt;
        html += row(nearName, n, C_NEAR, p);
        html += row(farName, f, C_FAR, p);
        return html;
      },
      axisPointer: { type: "line", lineStyle: { color: "rgba(245,230,196,0.5)", width: 1 } },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: "rgba(255,255,255,0.08)" } },
      axisTick: { show: false },
      axisLabel: {
        color: "#4d5666", fontSize: 10, fontFamily: "JetBrains Mono, monospace",
        formatter: (v) => { const dt = new Date(v); return isFinite(dt) ? String(dt.getUTCFullYear()) : ""; },
        hideOverlap: true,
      },
      splitLine: { show: false },
    },
    yAxis: [
      { ...yAxisBase, position: "left" },
      { ...yAxisBase, position: "right", splitLine: { show: false } },
    ],
    dataZoom: [
      { type: "inside", xAxisIndex: 0, start: 0, end: 100 },
      {
        type: "slider", xAxisIndex: 0, start: 0, end: 100, height: 18, bottom: 12,
        borderColor: "transparent", backgroundColor: "rgba(14,18,25,0.4)",
        fillerColor: "rgba(245,230,196,0.10)",
        dataBackground: { areaStyle: { color: "rgba(103,232,249,0.18)" }, lineStyle: { color: "rgba(103,232,249,0.4)", width: 0.8 } },
        selectedDataBackground: { areaStyle: { color: "rgba(245,230,196,0.22)" }, lineStyle: { color: "rgba(245,230,196,0.6)", width: 0.8 } },
        handleStyle: { color: "#f5e6c4", borderColor: "transparent", opacity: 0.9 },
        moveHandleSize: 0,   // 禁用移动把手：避免点击后进入「跟随鼠标」模式
        textStyle: { color: "#8b95a8", fontSize: 9, fontFamily: "JetBrains Mono, monospace" },
      },
    ],
    series: [
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
    // 预览在 iframe 里时，鼠标拖出窗口才松开会导致图表收不到 mouseup、停在拖拽态跟随鼠标；
    // 指针离开页面时补发一个 mouseup 兜底
    document.addEventListener("mouseleave", () => {
      const host = document.getElementById("costChart");
      ["mouseup", "pointerup"].forEach(type => {
        try { host.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })); } catch (_) {}
      });
    });
    // 缩放/平移时纵轴自适应可见区间（TradingView 风格），解决长历史纵向压缩问题
    costChart.on("datazoom", () => {
      const cur = enriched[state.activeIdx];
      const dz = costChart.getOption().dataZoom[0];
      const arrays = state.freq === "W"
        ? [cur.wpx, cur.ma50w, cur.ma200w]
        : [cur.px, cur.hm200, cur.ma850];
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
      costChart.setOption({ yAxis: [{ min: b.min, max: b.max }, { min: b.min, max: b.max }] });
    });
  }
  costChart.setOption(buildCostOption(d), true);

  // 读数条
  const weekly = state.freq === "W";
  const near = weekly ? d.ma50w : d.hm200;
  const far = weekly ? d.ma200w : d.ma850;
  const nI = [...near].map((v, i) => v === null ? -1 : i).reduce((a, b) => Math.max(a, b));
  const fI = [...far].map((v, i) => v === null ? -1 : i).reduce((a, b) => Math.max(a, b));
  const p = d.px[d.px.length - 1], nv = near[nI], fv = far[fI];
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
``;
}

/* ──────────────  周期切换  ─────────────────────────────────────── */
function bindFreq() {
  document.querySelectorAll("[data-freq]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.freq === state.freq);
    btn.addEventListener("click", () => {
      state.freq = btn.dataset.freq;
      document.querySelectorAll("[data-freq]").forEach(b => b.classList.toggle("active", b === btn));
      renderCost();
    });
  });
}

/* ──────────────  Init  ─────────────────────────────────────────── */
function init() {
  document.getElementById("update-time").textContent = UPDATE_TIME.replace(/\s*CST$/i, "");
  enrichAll();

  // hash 同步指数选择
  const h = (location.hash || "").replace("#", "");
  const hi = enriched.findIndex(d => d.code === h);
  if (hi >= 0) state.activeIdx = hi;

  renderChips();
  bindFreq();
  renderCost();

  window.addEventListener("resize", () => { costChart && costChart.resize(); });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", loadAndInit);
} else {
  loadAndInit();
}
}

if (typeof window !== "undefined") _browserMain();

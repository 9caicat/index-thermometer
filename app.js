/* =========================================================================
   宽基温度计 — App logic
   ========================================================================= */

let DATA = null;
let UPDATE_TIME = "--";

/* ──────────────  JSON → internal format  ──────────────────────── */
/* Converts snake_case fields from data/index_data.json into the
   camelCase / nested shape the rest of this file expects.          */
function transformJsonData(raw) {
  return raw.map((idx) => ({
    code: idx.code,
    name: idx.name,
    market: idx.market,
    dates: idx.dates,
    prices: idx.prices,
    temperature: idx.temperature,
    current: {
      date: idx.current.date,
      price: idx.current.price,
      changePct: idx.current.change_pct,
      percentile: idx.current.percentile,
      zone: {
        key:  idx.current.zone_key,
        label: idx.current.zone_label,
        hint:  idx.current.zone_hint,
      },
      daysCheaper:      idx.current.days_cheaper,
      daysMoreExpensive: idx.current.days_more_expensive,
      totalDays:        idx.current.total_days,
      zoneDays:         idx.current.zone_days,
    },
  }));
}

/* ──────────────  Loading overlay  ─────────────────────────────── */
function showLoadingOverlay() {
  const el = document.createElement("div");
  el.id = "loading-overlay";
  el.style.cssText = [
    "position:fixed", "inset:0", "display:flex",
    "align-items:center", "justify-content:center",
    "background:rgba(8,10,15,0.88)", "z-index:9999",
    "font-family:'Noto Sans SC',sans-serif",
    "font-size:1rem", "color:#8b95a8", "letter-spacing:0.12em",
  ].join(";");
  el.textContent = "数据加载中…";
  document.body.appendChild(el);
}

function hideLoadingOverlay() {
  const el = document.getElementById("loading-overlay");
  if (el) el.remove();
}

/* ──────────────  Data loader  ──────────────────────────────────── */
async function loadAndInit() {
  showLoadingOverlay();
  const footerMock = document.querySelector(".footer-mock");
  if (footerMock) footerMock.hidden = true;

  try {
    const resp = await fetch("data/index_data.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();
    DATA = transformJsonData(raw);
    UPDATE_TIME = raw[0]?.update_time ?? "--";
  } catch (_) {
    // 本地开发或文件缺失时，静默回退到 mock 数据
    DATA = window.DIAMOND_DATA;
    UPDATE_TIME = window.DIAMOND_UPDATE_TIME;
    if (footerMock) {
      footerMock.textContent = "⚠ 当前为模拟数据";
      footerMock.hidden = false;
    }
  } finally {
    hideLoadingOverlay();
  }

  init();
}

/* ──────────────  Zone visual mapping  ─────────────────────────── */
const ZONE = {
  diamond: { color: "#60a5fa", tint: "rgba(96, 165, 250, 0.10)",  glow: "rgba(96, 165, 250, 0.30)"  },
  dca:     { color: "#2dd4bf", tint: "rgba(45, 212, 191, 0.10)",  glow: "rgba(45, 212, 191, 0.26)"  },
  fair:    { color: "#94a3b8", tint: "rgba(148, 163, 184, 0.10)", glow: "rgba(148, 163, 184, 0.18)" },
  warm:    { color: "#fbbf24", tint: "rgba(251, 191, 36, 0.10)",  glow: "rgba(251, 191, 36, 0.26)"  },
  hot:     { color: "#fb923c", tint: "rgba(251, 146, 60, 0.12)",  glow: "rgba(251, 146, 60, 0.28)"  },
  extreme: { color: "#ef4444", tint: "rgba(239, 68, 68, 0.14)",   glow: "rgba(239, 68, 68, 0.30)"   },
};
const ZONE_ORDER = ["diamond", "dca", "fair", "warm", "hot", "extreme"];
const ZONE_LABEL = { diamond: "冰点", dca: "偏冷", fair: "常温", warm: "偏热", hot: "过热", extreme: "沸腾" };

/* ──────────────  Formatters  ──────────────────────────────────── */
const fmtPrice = (v) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v, signed = false) => {
  if (!signed) return `${v.toFixed(2)}%`;
  if (v > 0)  return `+${v.toFixed(2)}%`;
  if (v < 0)  return `−${Math.abs(v).toFixed(2)}%`;
  return `${v.toFixed(2)}%`;
};
const fmtInt = (v) => Math.round(v).toLocaleString("en-US");
const fmtTemp = (v) => `${Math.round(v)}`;   // unit ° rendered separately

/* ──────────────  State  ───────────────────────────────────────── */
const state = {
  activeIdx: 0,
  range: "1Y",
};

let chart = null;

/* ──────────────  Sparkline (inline SVG)  ──────────────────────── */
function buildSparkline(d, zoneColor) {
  const W = 100, H = 30;
  const sliceLen = Math.min(250, d.temperature.length);
  const validStart = d.temperature.findIndex((v) => v != null);
  const start = Math.max(validStart, d.temperature.length - sliceLen);
  const series = d.temperature.slice(start);
  if (series.length < 2) return "";

  // Temperature is already 0–100, fixed y range gives a consistent visual
  const min = 0, max = 100, range = max - min;
  const xStep = W / (series.length - 1);

  const pts = series.map((v, i) =>
    `${(i * xStep).toFixed(1)},${(H - ((v - min) / range) * (H - 4) - 2).toFixed(1)}`
  );

  const lastX = (series.length - 1) * xStep;
  const lastY = H - ((series[series.length - 1] - min) / range) * (H - 4) - 2;

  return `
    <svg class="dc-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts.join(" ")}" fill="none" stroke="${zoneColor}" stroke-width="1.2" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="1.8" fill="${zoneColor}" />
    </svg>
  `;
}

/* ──────────────  Thermometer SVG  ─────────────────────────────── */
function buildThermometer(temp, zoneColor) {
  // viewBox 100 × 330
  const tubeX = 30, tubeW = 24;
  const tubeTop = 18, tubeBottom = 258;
  const tubeRange = tubeBottom - tubeTop;  // 240
  const bulbCx = 42, bulbCy = 288, bulbR = 26;

  // map temp 0–100 to y: 0° at tubeBottom, 100° at tubeTop
  const tBounded = Math.max(0, Math.min(100, temp));
  const fillY = tubeBottom - (tBounded / 100) * tubeRange;
  const colHeight = (bulbCy - bulbR + 8) - fillY; // extends into bulb area for seam

  // tick marks shown on the right
  const ticks = [
    { val: 5,  label: "5°"  },
    { val: 25, label: "25°" },
    { val: 50, label: "50°" },
    { val: 75, label: "75°" },
    { val: 95, label: "95°" },
  ];
  const tickSVG = ticks.map((t) => {
    const y = tubeBottom - (t.val / 100) * tubeRange;
    return `
      <line x1="${tubeX + tubeW + 2}" y1="${y}" x2="${tubeX + tubeW + 8}" y2="${y}" stroke="rgba(255,255,255,0.32)" stroke-width="0.8" />
      <text x="${tubeX + tubeW + 12}" y="${y + 3}" font-family="JetBrains Mono, monospace" font-size="8" font-weight="500" fill="rgba(139,149,168,0.92)" letter-spacing="0.04em">${t.label}</text>
    `;
  }).join("");

  // current value marker (line)
  const markerY = fillY;

  return `
    <defs>
      <linearGradient id="mercuryGrad" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%"   stop-color="#60a5fa" />
        <stop offset="22%"  stop-color="#2dd4bf" />
        <stop offset="50%"  stop-color="#94a3b8" />
        <stop offset="82%"  stop-color="#fbbf24" />
        <stop offset="92%"  stop-color="#fb923c" />
        <stop offset="100%" stop-color="#ef4444" />
      </linearGradient>
      <filter id="bulbGlow" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="6" />
      </filter>
      <radialGradient id="bulbInner" cx="35%" cy="35%" r="65%">
        <stop offset="0%"  stop-color="${zoneColor}" stop-opacity="1" />
        <stop offset="75%" stop-color="${zoneColor}" stop-opacity="0.9" />
        <stop offset="100%" stop-color="${zoneColor}" stop-opacity="0.6" />
      </radialGradient>
    </defs>

    <!-- Bulb outer glow -->
    <circle cx="${bulbCx}" cy="${bulbCy}" r="${bulbR + 2}" fill="${zoneColor}" opacity="0.35" filter="url(#bulbGlow)" />

    <!-- Glass tube outline -->
    <rect x="${tubeX}" y="${tubeTop}" width="${tubeW}" height="${tubeRange}" rx="${tubeW / 2}" ry="${tubeW / 2}"
          fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.22)" stroke-width="1" />

    <!-- Glass bulb outline -->
    <circle cx="${bulbCx}" cy="${bulbCy}" r="${bulbR}" fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.22)" stroke-width="1" />

    <!-- Mercury column (rounded) -->
    <rect x="${tubeX + 3}" y="${fillY}" width="${tubeW - 6}" height="${colHeight}" rx="${(tubeW - 6) / 2}" ry="${(tubeW - 6) / 2}"
          fill="url(#mercuryGrad)" />

    <!-- Mercury bulb (always filled in zone color) -->
    <circle cx="${bulbCx}" cy="${bulbCy}" r="${bulbR - 4}" fill="url(#bulbInner)" />

    <!-- Glass reflection on tube -->
    <rect x="${tubeX + 4}" y="${tubeTop + 6}" width="2.5" height="${tubeRange - 12}" rx="1.2" fill="rgba(255,255,255,0.18)" />

    <!-- Glass reflection on bulb -->
    <ellipse cx="${bulbCx - 7}" cy="${bulbCy - 8}" rx="5" ry="7" fill="rgba(255,255,255,0.32)" />

    <!-- Tick marks + labels -->
    <g>${tickSVG}</g>

    <!-- Current temp marker -->
    <g style="transition: transform 0.6s ease;">
      <line x1="${tubeX - 8}" y1="${markerY}" x2="${tubeX + 2}" y2="${markerY}" stroke="#fff" stroke-width="1.2" stroke-linecap="round" />
      <circle cx="${tubeX - 8}" cy="${markerY}" r="2" fill="#fff" />
    </g>
  `;
}

/* ──────────────  Render dashboard cards  ─────────────────────── */
function renderDashboard() {
  const host = document.getElementById("dash-grid");
  host.innerHTML = "";
  DATA.forEach((d, i) => {
    const c = d.current;
    const z = ZONE[c.zone.key];
    const card = document.createElement("button");
    card.className = "dash-card" + (i === state.activeIdx ? " active" : "");
    card.style.setProperty("--zone-color", z.color);
    card.style.setProperty("--zone-tint", z.tint);
    card.dataset.idx = i;
    card.innerHTML = `
      <span class="dc-corner-tr" aria-hidden="true"></span>
      <span class="dc-corner-br" aria-hidden="true"></span>
      <div class="dc-top">
        <span class="dc-code">${d.market}·${d.code.slice(2)}</span>
        <span class="dc-status" aria-hidden="true"></span>
      </div>
      <div class="dc-name">${d.name}</div>
      <div class="dc-price-block">
        <span class="dc-price">${fmtPrice(c.price)}</span>
        <span class="dc-change ${c.changePct >= 0 ? "is-up" : "is-down"}">${fmtPct(c.changePct, true)}</span>
      </div>
      <div class="dc-zone">${c.zone.label}</div>
      ${buildSparkline(d, z.color)}
    `;
    card.addEventListener("click", () => setActive(i));
    host.appendChild(card);
  });
}

/* ──────────────  Render zone breakdown (text table)  ──────────── */
function renderBreakdown(d) {
  const c = d.current;
  const total = c.totalDays;
  const host = document.getElementById("a-breakdown");
  host.innerHTML = "";

  ZONE_ORDER.forEach((key) => {
    const days = c.zoneDays[key];
    const z = ZONE[key];
    const pct = (days / total) * 100;

    const row = document.createElement("div");
    row.className = "breakdown-row" + (key === c.zone.key ? " is-active" : "");
    row.style.setProperty("--zone-color", z.color);
    row.style.setProperty("--zone-tint", z.tint);
    row.innerHTML = `
      <span class="row-bar" aria-hidden="true"></span>
      <span class="row-name">${ZONE_LABEL[key]}</span>
      <span class="row-days">${days}<span style="color:var(--text-dim);font-size:0.85em;margin-left:2px;">天</span></span>
      <span class="row-pct">${pct.toFixed(2)}%</span>
    `;
    host.appendChild(row);
  });
}

/* ──────────────  Render analysis panel  ───────────────────────── */
function renderAnalysis(d) {
  const c = d.current;
  const z = ZONE[c.zone.key];

  const card = document.querySelector(".analysis-card");
  card.style.setProperty("--zone-color", z.color);
  card.style.setProperty("--zone-tint", z.tint);
  card.style.setProperty("--zone-glow", z.glow);

  document.getElementById("a-code").textContent = `${d.market}·${d.code.slice(2)}`;
  document.getElementById("a-name").textContent = d.name;
  document.getElementById("a-price").textContent = fmtPrice(c.price);

  const ch = document.getElementById("a-change");
  ch.textContent = fmtPct(c.changePct, true);
  ch.classList.toggle("is-up", c.changePct >= 0);
  ch.classList.toggle("is-down", c.changePct < 0);

  document.getElementById("a-temp").textContent = fmtTemp(c.percentile);

  const zoneEl = document.getElementById("a-zone");
  zoneEl.textContent = c.zone.label;
  zoneEl.dataset.zone = c.zone.key;

  document.getElementById("a-hint").textContent = c.zone.hint;

  document.getElementById("a-total").textContent = c.totalDays;
  document.getElementById("a-cheaper").textContent = fmtInt(c.daysCheaper);
  document.getElementById("a-expensive").textContent = fmtInt(c.daysMoreExpensive);

  document.getElementById("analysis-meta").textContent = `— ${d.name} · ${d.market}·${d.code.slice(2)}`;

  // Thermometer
  document.getElementById("a-thermo").innerHTML = buildThermometer(c.percentile, z.color);

  renderBreakdown(d);
}

/* ──────────────  Build chart option  ──────────────────────────── */
function rangeStartIndex(d, range) {
  const total = d.dates.length;
  if (range === "ALL") return d.temperature.findIndex((v) => v != null);
  const map = { "3M": 60, "6M": 125, "1Y": 250 };
  const days = map[range] || 250;
  const firstValid = d.temperature.findIndex((v) => v != null);
  return Math.max(firstValid, total - days);
}

function buildChartOption(d) {
  const start = rangeStartIndex(d, state.range);
  const dates = d.dates.slice(start);
  const tempSeries = d.temperature.slice(start);
  const priceSeries = d.prices.slice(start);

  const bandColor = (key, alpha) => {
    const hex = ZONE[key].color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16),
          g = parseInt(hex.slice(2, 4), 16),
          b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  // Subtle zone background bands
  const markArea = {
    silent: true,
    itemStyle: { borderWidth: 0 },
    data: [
      [{ yAxis: 0,  itemStyle: { color: bandColor("diamond", 0.08) } }, { yAxis: 5  }],
      [{ yAxis: 5,  itemStyle: { color: bandColor("dca",     0.05) } }, { yAxis: 25 }],
      [{ yAxis: 25, itemStyle: { color: bandColor("fair",    0.02) } }, { yAxis: 75 }],
      [{ yAxis: 75, itemStyle: { color: bandColor("warm",    0.05) } }, { yAxis: 90 }],
      [{ yAxis: 90, itemStyle: { color: bandColor("hot",     0.07) } }, { yAxis: 95 }],
      [{ yAxis: 95, itemStyle: { color: bandColor("extreme", 0.10) } }, { yAxis: 100 }],
    ],
  };

  // Threshold reference lines (the equivalent of CoinGlass's 抄底线/定投线)
  const mkThreshold = (yv, label, color) => ({
    yAxis: yv,
    lineStyle: { color, type: "dashed", width: 1, opacity: 0.75 },
    label: {
      formatter: label,
      position: "insideEndTop",
      color,
      fontSize: 9,
      fontFamily: "JetBrains Mono, monospace",
      backgroundColor: "rgba(14, 18, 25, 0.9)",
      padding: [2, 5],
      borderRadius: 2,
      distance: 2,
    },
  });
  const markLine = {
    silent: true,
    symbol: "none",
    data: [
      mkThreshold(5,  "冰点 5°",  ZONE.diamond.color),
      mkThreshold(25, "偏冷 25°", ZONE.dca.color),
      mkThreshold(75, "偏热 75°", ZONE.warm.color),
      mkThreshold(95, "沸腾 95°", ZONE.extreme.color),
    ],
  };

  return {
    backgroundColor: "transparent",
    animation: true,
    animationDuration: 600,
    animationEasing: "cubicOut",
    grid: { left: 48, right: 56, top: 46, bottom: 66, containLabel: false },

    /* Native legend (clickable to toggle series) */
    legend: {
      data: ["温度值", "收盘价"],
      top: 10,
      left: "center",
      textStyle: {
        color: "#8b95a8",
        fontSize: 11,
        fontFamily: "Geist, Noto Sans SC, sans-serif",
      },
      icon: "roundRect",
      itemWidth: 14,
      itemHeight: 3,
      itemGap: 22,
      inactiveColor: "#3d4453",
    },

    /* Color the temperature line piecewise by its value */
    visualMap: {
      show: false,
      type: "piecewise",
      seriesIndex: 0,
      pieces: [
        { min: 0,  max: 5,   color: ZONE.diamond.color },
        { min: 5,  max: 25,  color: ZONE.dca.color     },
        { min: 25, max: 75,  color: ZONE.fair.color    },
        { min: 75, max: 90,  color: ZONE.warm.color    },
        { min: 90, max: 95,  color: ZONE.hot.color     },
        { min: 95, max: 100, color: ZONE.extreme.color },
      ],
    },

    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(14, 18, 25, 0.97)",
      borderColor: "rgba(255, 255, 255, 0.18)",
      borderWidth: 1,
      padding: [12, 14],
      textStyle: {
        color: "#f6f8fb",
        fontSize: 12,
        fontFamily: "Geist, Noto Sans SC, sans-serif",
      },
      formatter: (params) => {
        const date = params[0].axisValueLabel;
        let temp = null, price = null;
        params.forEach((p) => {
          if (p.seriesName === "温度值") temp = p.value;
          if (p.seriesName === "收盘价") price = p.value;
        });
        let zoneKey = "fair";
        if (temp != null) {
          if      (temp < 5)  zoneKey = "diamond";
          else if (temp < 25) zoneKey = "dca";
          else if (temp < 75) zoneKey = "fair";
          else if (temp < 90) zoneKey = "warm";
          else if (temp < 95) zoneKey = "hot";
          else                zoneKey = "extreme";
        }
        let html = `<div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#8b95a8;letter-spacing:0.1em;margin-bottom:10px;">${date}</div>`;
        if (temp != null) {
          html += `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:6px;">
              <span style="font-family:'Noto Sans SC',sans-serif;font-size:11px;color:#8b95a8;display:inline-flex;align-items:center;gap:7px;">
                <span style="display:inline-block;width:10px;height:2px;background:${ZONE[zoneKey].color};border-radius:1px;"></span>温度值
              </span>
              <span style="display:inline-flex;align-items:baseline;gap:8px;">
                <span style="font-family:'Chakra Petch',sans-serif;font-size:20px;font-weight:700;color:${ZONE[zoneKey].color};font-variant-numeric:tabular-nums;">${Math.round(temp)}°</span>
                <span style="font-family:'Noto Sans SC',sans-serif;font-size:11px;font-weight:600;color:${ZONE[zoneKey].color};letter-spacing:0.08em;padding:2px 7px;background:${bandColor(zoneKey, 0.18)};border-radius:3px;">${ZONE_LABEL[zoneKey]}</span>
              </span>
            </div>`;
        }
        if (price != null) {
          html += `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:20px;padding-top:8px;margin-top:4px;border-top:1px dashed rgba(255,255,255,0.1);">
              <span style="font-family:'Noto Sans SC',sans-serif;font-size:11px;color:#8b95a8;display:inline-flex;align-items:center;gap:7px;">
                <span style="display:inline-block;width:10px;height:2px;background:#f5e6c4;border-radius:1px;"></span>收盘价
              </span>
              <span style="font-family:'Chakra Petch',sans-serif;font-size:15px;font-weight:600;color:#f5e6c4;font-variant-numeric:tabular-nums;">${price.toFixed(2)}</span>
            </div>`;
        }
        return html;
      },
      axisPointer: {
        type: "line",
        lineStyle: { color: "rgba(245, 230, 196, 0.5)", type: "solid", width: 1 },
      },
    },

    xAxis: {
      type: "category",
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: "rgba(255,255,255,0.08)" } },
      axisTick: { show: false },
      axisLabel: {
        color: "#4d5666",
        fontSize: 10,
        fontFamily: "JetBrains Mono, monospace",
        margin: 10,
        formatter: (v) => v.slice(0, 7),
        hideOverlap: true,
      },
      splitLine: { show: false },
    },

    yAxis: [
      {
        type: "value",
        min: 0,
        max: 100,
        interval: 25,
        position: "left",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: "#4d5666",
          fontSize: 10,
          fontFamily: "JetBrains Mono, monospace",
          formatter: (v) => `${v}°`,
        },
        splitLine: { lineStyle: { color: "rgba(255,255,255,0.035)", type: "solid" } },
      },
      {
        type: "value",
        scale: true,
        position: "right",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: "#4d5666",
          fontSize: 10,
          fontFamily: "JetBrains Mono, monospace",
          formatter: (v) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0),
        },
        splitLine: { show: false },
      },
    ],

    /* Date range slider at the bottom (CoinGlass style) */
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
        start: 0,
        end: 100,
        zoomLock: false,
      },
      {
        type: "slider",
        xAxisIndex: 0,
        start: 0,
        end: 100,
        height: 18,
        bottom: 14,
        borderColor: "transparent",
        backgroundColor: "rgba(14, 18, 25, 0.4)",
        fillerColor: "rgba(245, 230, 196, 0.10)",
        dataBackground: {
          areaStyle: { color: "rgba(103, 232, 249, 0.18)" },
          lineStyle: { color: "rgba(103, 232, 249, 0.4)", width: 0.8 },
        },
        selectedDataBackground: {
          areaStyle: { color: "rgba(245, 230, 196, 0.22)" },
          lineStyle: { color: "rgba(245, 230, 196, 0.6)", width: 0.8 },
        },
        handleStyle: { color: "#f5e6c4", borderColor: "transparent", opacity: 0.9 },
        moveHandleStyle: { color: "rgba(245, 230, 196, 0.25)" },
        textStyle: {
          color: "#8b95a8",
          fontSize: 9,
          fontFamily: "JetBrains Mono, monospace",
        },
        labelFormatter: (idx, v) => (v ? v.slice(0, 7) : ""),
      },
    ],

    series: [
      {
        name: "温度值",
        type: "line",
        yAxisIndex: 0,
        data: tempSeries,
        smooth: 0.25,
        showSymbol: false,
        sampling: "lttb",
        lineStyle: {
          width: 1.8,
          shadowColor: "rgba(0, 0, 0, 0.2)",
          shadowBlur: 6,
        },
        markArea,
        markLine,
        z: 3,
      },
      {
        name: "收盘价",
        type: "line",
        yAxisIndex: 1,
        data: priceSeries,
        smooth: 0.15,
        showSymbol: false,
        sampling: "lttb",
        lineStyle: { color: "rgba(245, 230, 196, 0.55)", width: 1.2 },
        z: 2,
      },
    ],
  };
}

/* ──────────────  Render chart  ────────────────────────────────── */
function renderChart() {
  const el = document.getElementById("chart");
  if (!chart) {
    chart = echarts.init(el, null, { renderer: "canvas" });
    window.addEventListener("resize", () => chart && chart.resize());
  }
  chart.setOption(buildChartOption(DATA[state.activeIdx]), true);
}

/* ──────────────  Activate / range  ────────────────────────────── */
function setActive(i) {
  state.activeIdx = i;
  document.querySelectorAll(".dash-card").forEach((c, j) => {
    c.classList.toggle("active", j === i);
  });
  renderAnalysis(DATA[i]);
  renderChart();
}

function setRange(r) {
  state.range = r;
  document.querySelectorAll(".range-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.range === r);
  });
  renderChart();
}

/* ──────────────  Bind range buttons  ──────────────────────────── */
function bindRange() {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => setRange(btn.dataset.range));
  });
}

/* ──────────────  Init  ────────────────────────────────────────── */
function init() {
  document.getElementById("update-time").textContent = UPDATE_TIME.replace(/\s*CST$/i, "");
  renderDashboard();
  renderAnalysis(DATA[state.activeIdx]);
  bindRange();
  renderChart();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", loadAndInit);
} else {
  loadAndInit();
}

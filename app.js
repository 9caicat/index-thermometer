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
    const resp = await fetch("data/index_data.json?v=" + new Date().toISOString().slice(0, 10));
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
/* ──────────────  Semicircular gauge (恐惧贪婪仪表盘风格) ──────── */
function buildGauge(temp, zoneKey) {
  const CX = 170, CY = 178, R = 128, SW = 15;
  const pt = (v, r = R) => {
    const a = ((180 - v * 1.8) * Math.PI) / 180;
    return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
  };
  const arc = (v1, v2) => {
    const [x1, y1] = pt(v1), [x2, y2] = pt(v2);
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };
  const SEG = [
    { key: "diamond", from: 0,  to: 5  },
    { key: "dca",     from: 5,  to: 25 },
    { key: "fair",    from: 25, to: 75 },
    { key: "warm",    from: 75, to: 90 },
    { key: "hot",     from: 90, to: 95 },
    { key: "extreme", from: 95, to: 100 },
  ];
  const GAP = 0.45;                     // 段间缝隙（温度单位）
  const tB = Math.max(0, Math.min(100, temp));

  // 全弧底色轨道（增强轮廓结构感）
  const track = `<path d="${arc(0, 100)}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="${SW}" />`;

  // 六段温区弧：当前温区全亮加粗，其余保留 55% 不透明度（无发光滤镜）
  const arcs = SEG.map(s => {
    const on = s.key === zoneKey;
    const f = s.from === 0 ? s.from : s.from + GAP;
    const t = s.to === 100 ? s.to : s.to - GAP;
    const d = arc(f, t);
    return `<path d="${d}" fill="none" stroke="${ZONE[s.key].color}" stroke-width="${on ? SW + 3 : SW}" opacity="${on ? 1 : 0.55}" stroke-linecap="butt" />`;
  }).join("");

  // 温区名称沿弧排布（切线方向旋转），颜色与弧段一致
  const labels = SEG.map(s => {
    const mid = (s.from + s.to) / 2;
    const [x, y] = pt(mid, R + 22);
    const rot = mid * 1.8 - 90;
    const on = s.key === zoneKey;
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle"
      transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})"
      font-family="Noto Sans SC, sans-serif" font-size="11" font-weight="${on ? 700 : 500}"
      fill="${ZONE[s.key].color}" opacity="${on ? 1 : 0.65}">${ZONE_LABEL[s.key]}</text>`;
  }).join("");

  // 刻度：每 5° 一格
  let ticks = "";
  for (let v = 0; v <= 100; v += 5) {
    const [x1, y1] = pt(v, R - SW / 2 - 3);
    const [x2, y2] = pt(v, R - SW / 2 - 8);
    ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(255,255,255,0.22)" stroke-width="1" />`;
  }

  // 指针 + 轴心
  const [nx, ny] = pt(tB, R - SW / 2 - 16);
  const needle = `
    <line x1="${CX}" y1="${CY}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#f5e6c4" stroke-width="3" stroke-linecap="round" />
    <circle cx="${CX}" cy="${CY}" r="5" fill="#f5e6c4" />`;

  return `${track}${arcs}${ticks}${labels}${needle}`;
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

  document.getElementById("a-total").textContent = c.totalDays;

  // 比当前更冷/更热的时间占比（%）。分母 = 更冷天数 + 更热天数（= 总天数 − 当日自身），
  // 与既有天数口径一致；极端情况（无历史样本 → 0；历史最低 → 0% 更冷；历史新高 → 0% 更热）均可安全展示
  const coldDays = c.daysCheaper, hotDays = c.daysMoreExpensive;
  const coldHotSum = coldDays + hotDays;
  const coldPct = coldHotSum > 0 ? (coldDays / coldHotSum) * 100 : null;
  const hotPct = coldHotSum > 0 ? (hotDays / coldHotSum) * 100 : null;
  document.getElementById("a-cheaper").textContent = coldPct === null ? "--" : coldPct.toFixed(1) + "%";
  document.getElementById("a-expensive").textContent = hotPct === null ? "--" : hotPct.toFixed(1) + "%";

  // Semicircular gauge
  document.getElementById("a-gauge").innerHTML = buildGauge(c.percentile, c.zone.key);

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
  /* 移动端：收紧边距、缩小图例与阈值标签，底部滑块加高方便手指拖按 */
  const mob = window.innerWidth <= 767 || "ontouchstart" in window;

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
      fontSize: mob ? 8 : 9,
      fontFamily: "JetBrains Mono, monospace",
      backgroundColor: "rgba(14, 18, 25, 0.9)",
      padding: mob ? [1, 4] : [2, 5],
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
    grid: { left: mob ? 40 : 48, right: mob ? 44 : 56, top: mob ? 40 : 46, bottom: mob ? 58 : 66, containLabel: false },

    /* Native legend (clickable to toggle series) */
    legend: {
      data: ["温度值", "收盘价"],
      top: 10,
      left: "center",
      textStyle: {
        color: "#8b95a8",
        fontSize: mob ? 10 : 11,
        fontFamily: "Geist, Noto Sans SC, sans-serif",
      },
      icon: "roundRect",
      itemWidth: mob ? 12 : 14,
      itemHeight: 3,
      itemGap: mob ? 12 : 22,
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
                <span style="display:inline-block;width:10px;height:2px;background:#f8fafc;border-radius:1px;"></span>收盘价
              </span>
              <span style="font-family:'Chakra Petch',sans-serif;font-size:15px;font-weight:600;color:#f8fafc;font-variant-numeric:tabular-nums;">${price.toFixed(2)}</span>
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
        height: mob ? 28 : 18,
        bottom: mob ? 10 : 14,
        handleSize: mob ? 26 : "100%",
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
          fontSize: mob ? 10 : 9,
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
        lineStyle: { color: "#f8fafc", width: 1.4 },   // 高对比白，避开温区配色
        itemStyle: { color: "#f8fafc" },               // 图例色块与线条一致
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

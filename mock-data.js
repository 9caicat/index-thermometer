/* =========================================================================
   Mock data for the Diamond Bottom Index prototype
   - Generates ~1200 trading days for 4 A-share indices
   - Each index is tuned to land in a different zone for demo purposes
   - All client-side, deterministic via seeded RNG
   ========================================================================= */

/* ──────────────  Seeded random / Box-Muller normal  ─────────────── */
const seededRand = (seed) => {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
};
const normalSample = (rand) => {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/* ──────────────  Trading-day calendar  ───────────────────────────── */
function generateTradingDates(numDays) {
  const dates = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let d = new Date(today);
  while (dates.length < numDays) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      const iso = d.toISOString().slice(0, 10);
      dates.unshift(iso);
    }
    d.setDate(d.getDate() - 1);
  }
  return dates;
}

/* ──────────────  Price-series generator  ─────────────────────────── */
/* Supports either a simple (longDrift + recentDrift) shape or a multi-phase
   shape via `phases: [{ days, drift }, ...]`. Multi-phase is what gives the
   indicator a meaningful range — a prior bull run then a decline makes
   today's level a genuine percentile outlier. */
function generatePrices(cfg) {
  const { startPrice, days, seed, vol, cycles } = cfg;
  const rand = seededRand(seed);
  const prices = [];
  let p = startPrice;

  // Resolve drift per-day from either `phases` or simple fallback
  const driftAt = (() => {
    if (cfg.phases) {
      const arr = new Array(days);
      let i = 0;
      for (const ph of cfg.phases) {
        for (let k = 0; k < ph.days && i < days; k++, i++) arr[i] = ph.drift;
      }
      while (i < days) arr[i++] = cfg.phases[cfg.phases.length - 1].drift;
      return (idx) => arr[idx];
    }
    return (idx) => {
      const inRecent = days - idx - 1 < (cfg.recentDays || 0);
      return inRecent ? cfg.recentDrift : cfg.longDrift;
    };
  })();

  for (let i = 0; i < days; i++) {
    let cyclic = 0;
    if (cycles) {
      for (const c of cycles) {
        cyclic += c.amp * Math.sin((i / c.period) * 2 * Math.PI + c.phase);
      }
    }
    const shock = vol * normalSample(rand);
    p *= 1 + driftAt(i) + cyclic + shock;
    prices.push(p);
  }
  return prices;
}

/* ──────────────  Math helpers  ───────────────────────────────────── */
function computeMA(arr, period) {
  const ma = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) ma[i] = sum / period;
  }
  return ma;
}

function computeIndicator(prices, ma200, ma850) {
  return prices.map((p, i) => {
    if (ma200[i] == null || ma850[i] == null) return null;
    return (p / ma200[i]) * Math.sqrt(p / ma850[i]);
  });
}

function thresholdsAt(sorted, percents) {
  return percents.map((p) => sorted[Math.floor((sorted.length - 1) * (p / 100))]);
}

function percentileOf(value, sorted) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return (lo / sorted.length) * 100;
}

function classifyZone(pct) {
  if (pct < 5)  return { key: "diamond", label: "冰 点", hint: "温度极低 · 比历史 95% 以上的时段都更冷" };
  if (pct < 25) return { key: "dca",     label: "偏 冷", hint: "温度偏低 · 比历史 75%–95% 的时段都更冷" };
  if (pct < 75) return { key: "fair",    label: "常 温", hint: "温度居中 · 约一半的历史时段处于此区间" };
  if (pct < 90) return { key: "warm",    label: "偏 热", hint: "温度偏高 · 比历史 75%–90% 的时段都更热" };
  if (pct < 95) return { key: "hot",     label: "过 热", hint: "温度高位 · 比历史 90%–95% 的时段都更热" };
  return         { key: "extreme", label: "沸 腾", hint: "温度极高 · 比历史 95% 以上的时段都更热" };
}

/* ──────────────  Per-index configuration  ────────────────────────── */
/* Each config uses multi-phase drifts to produce a historical series with
   a meaningful peak, so today's value is a genuine percentile outlier.
   Seeds were chosen so each index lands in a different demo zone. */
const INDEX_CONFIGS = [
  /* 上证指数 — FAIR zone */
  {
    code: "sh000001",
    name: "上证指数",
    market: "SH",
    cfg: {
      startPrice: 4500, days: 1200, seed: 34069, vol: 0.0095,
      phases: [
        { days: 500, drift:  0.00050 },   // slow rally
        { days: 400, drift:  0.00030 },   // continued grind
        { days: 300, drift:  0.00040 },   // late mild rally
      ],
      cycles: [
        { amp: 0.00030, period: 380, phase: 1.2 },
        { amp: 0.00020, period: 170, phase: 0.6 },
      ],
    },
  },

  /* 沪深300 — DCA zone */
  {
    code: "sh000300",
    name: "沪深300",
    market: "SH",
    cfg: {
      startPrice: 3200, days: 1200, seed: 1584, vol: 0.0110,
      phases: [
        { days: 500, drift:  0.00180 },   // strong bull
        { days: 300, drift: -0.00080 },   // distribution
        { days: 400, drift: -0.00130 },   // bear trend
      ],
      cycles: [
        { amp: 0.00035, period: 380, phase: 0.4 },
        { amp: 0.00025, period: 200, phase: 2.1 },
      ],
    },
  },

  /* 科创50 — DIAMOND BOTTOM */
  {
    code: "sh000688",
    name: "科创50",
    market: "SH",
    cfg: {
      startPrice: 600, days: 1200, seed: 1146, vol: 0.0170,
      phases: [
        { days: 400, drift:  0.00200 },   // big tech rally
        { days: 300, drift: -0.00040 },   // distribution
        { days: 500, drift: -0.00170 },   // prolonged bear
      ],
      cycles: [
        { amp: 0.00050, period: 320, phase: 2.4 },
        { amp: 0.00030, period: 160, phase: 1.0 },
      ],
    },
  },

  /* 创业板指 — WARM zone */
  {
    code: "sz399006",
    name: "创业板指",
    market: "SZ",
    cfg: {
      startPrice: 1700, days: 1200, seed: 1000, vol: 0.0155,
      phases: [
        { days: 400, drift: -0.00040 },   // mild decline first
        { days: 500, drift: -0.00010 },   // long base
        { days: 300, drift:  0.00170 },   // recent rally
      ],
      cycles: [
        { amp: 0.00045, period: 360, phase: 0.2 },
        { amp: 0.00025, period: 140, phase: 1.7 },
      ],
    },
  },
];

/* ──────────────  Build dataset  ──────────────────────────────────── */
function buildIndexData(spec) {
  const dates = generateTradingDates(spec.cfg.days);
  const prices = generatePrices(spec.cfg);
  const ma200 = computeMA(prices, 200);
  const ma850 = computeMA(prices, 850);
  const indicator = computeIndicator(prices, ma200, ma850);

  // percentile thresholds based on the historical (valid) indicator series
  const validIndicators = indicator.filter((v) => v != null);
  const sortedIndicators = [...validIndicators].sort((a, b) => a - b);
  const totalValidDays = validIndicators.length;
  const [p5, p25, p75, p90, p95] = thresholdsAt(sortedIndicators, [5, 25, 75, 90, 95]);

  // Temperature series — each day's percentile rank, so the chart shows
  // temperature (0–100°) over time rather than raw indicator values.
  const temperature = indicator.map((v) =>
    v == null ? null : percentileOf(v, sortedIndicators)
  );

  const lastIdx = prices.length - 1;
  const currentPrice = prices[lastIdx];
  const currentInd = indicator[lastIdx];
  const currentPct = percentileOf(currentInd, sortedIndicators);
  const zone = classifyZone(currentPct);

  const prevPrice = prices[lastIdx - 1];
  const changePct = ((currentPrice - prevPrice) / prevPrice) * 100;

  // Concrete day counts — the "no mental math" framing
  const daysCheaper = validIndicators.filter((v) => v < currentInd).length;
  const daysMoreExpensive = totalValidDays - daysCheaper - 1; // exclude today itself

  // Days spent in each zone historically (by classification, not percentile-by-construction)
  const zoneDays = { diamond: 0, dca: 0, fair: 0, warm: 0, hot: 0, extreme: 0 };
  for (const v of validIndicators) {
    if      (v < p5)  zoneDays.diamond++;
    else if (v < p25) zoneDays.dca++;
    else if (v < p75) zoneDays.fair++;
    else if (v < p90) zoneDays.warm++;
    else if (v < p95) zoneDays.hot++;
    else              zoneDays.extreme++;
  }

  return {
    code: spec.code,
    name: spec.name,
    market: spec.market,
    dates,
    prices,
    indicator,                          // kept for completeness
    temperature,                        // 0–100° series for charting
    thresholds: { p5, p25, p75, p90, p95 },
    current: {
      date: dates[lastIdx],
      price: currentPrice,
      changePct,
      indicator: currentInd,            // not shown directly in UI but useful for chart marker
      percentile: currentPct,
      zone,
      daysCheaper,
      daysMoreExpensive,
      totalDays: totalValidDays,
      zoneDays,
    },
  };
}

// Expose the assembled dataset to the app
window.DIAMOND_DATA = INDEX_CONFIGS.map(buildIndexData);

// Most recent update timestamp — assume run at 16:10 Beijing time today
window.DIAMOND_UPDATE_TIME = (() => {
  const now = new Date();
  // Roll back to most recent weekday close
  let d = new Date(now);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  d.setHours(16, 10, 0, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${dd}  ${hh}:${mm} CST`;
})();

#!/usr/bin/env python3
"""
宽基温度计 — 数据采集脚本
从 akshare 拉取 4 个 A 股宽基指数历史数据，计算温度指标，输出 data/index_data.json。
"""

import json
import time
from datetime import datetime
from pathlib import Path

import akshare as ak
import numpy as np
import pandas as pd

# ─── 配置 ────────────────────────────────────────────────────────────────────

INDICES = [
    {"code": "sh000001", "name": "上证指数", "market": "SH"},
    {"code": "sh000300", "name": "沪深300",  "market": "SH"},
    {"code": "sh000688", "name": "科创50",   "market": "SH"},
    {"code": "sz399006", "name": "创业板指", "market": "SZ"},
]

OUTPUT_PATH = Path("data/index_data.json")
MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds

# ─── 工具函数 ─────────────────────────────────────────────────────────────────

def classify_zone(pct: float) -> tuple[str, str, str]:
    if pct < 5:
        return "diamond", "冰 点", "温度极低 · 比历史 95% 以上的时段都更冷"
    if pct < 25:
        return "dca",     "偏 冷", "温度偏低 · 比历史 75%–95% 的时段都更冷"
    if pct < 75:
        return "fair",    "常 温", "温度居中 · 约一半的历史时段处于此区间"
    if pct < 90:
        return "warm",    "偏 热", "温度偏高 · 比历史 75%–90% 的时段都更热"
    if pct < 95:
        return "hot",     "过 热", "温度高位 · 比历史 90%–95% 的时段都更热"
    return "extreme", "沸 腾", "温度极高 · 比历史 95% 以上的时段都更热"


def percentile_of(value: float, sorted_arr: list) -> float:
    """二分查找 value 在已排序数组中的百分位（0–100）。"""
    lo, hi = 0, len(sorted_arr)
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_arr[mid] < value:
            lo = mid + 1
        else:
            hi = mid
    return (lo / len(sorted_arr)) * 100


def fetch_with_retry(code: str) -> pd.DataFrame:
    for attempt in range(MAX_RETRIES):
        try:
            df = ak.stock_zh_index_daily(symbol=code)
            return df
        except Exception as exc:
            if attempt < MAX_RETRIES - 1:
                print(f"  [{code}] 第 {attempt + 1} 次请求失败: {exc}，{RETRY_DELAY}s 后重试…")
                time.sleep(RETRY_DELAY)
            else:
                raise RuntimeError(f"[{code}] 重试 {MAX_RETRIES} 次后仍失败: {exc}") from exc


# ─── 今日已更新检查 ───────────────────────────────────────────────────────────

def already_updated_today() -> bool:
    if not OUTPUT_PATH.exists():
        return False
    try:
        with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        today_str = datetime.now().strftime("%Y-%m-%d")
        for item in data:
            if item.get("update_time", "").startswith(today_str):
                return True
    except Exception:
        pass
    return False


# ─── 核心处理 ─────────────────────────────────────────────────────────────────

def process_index(info: dict) -> dict:
    code, name, market = info["code"], info["name"], info["market"]

    df = fetch_with_retry(code)

    # 排序 + 统一日期格式为 YYYY-MM-DD
    df = df.sort_values("date").reset_index(drop=True)
    df["date"] = df["date"].apply(lambda d: str(d)[:10])

    prices_arr = df["close"].values.astype(float)
    dates_list: list[str] = df["date"].tolist()

    # MA200 / MA850
    ma200 = pd.Series(prices_arr).rolling(200, min_periods=200).mean().values
    ma850 = pd.Series(prices_arr).rolling(850, min_periods=850).mean().values

    # 温度计指标 = (price/MA200) × √(price/MA850)
    indicator: list = []
    for i in range(len(prices_arr)):
        if np.isnan(ma200[i]) or np.isnan(ma850[i]):
            indicator.append(None)
        else:
            val = (prices_arr[i] / ma200[i]) * np.sqrt(prices_arr[i] / ma850[i])
            indicator.append(float(val))

    valid_vals = [v for v in indicator if v is not None]
    sorted_vals = sorted(valid_vals)
    total_days = len(valid_vals)

    # 各分位阈值（用于 zone_days 归档）
    def pth(p: float) -> float:
        idx = int((len(sorted_vals) - 1) * p / 100)
        return sorted_vals[idx]

    p5, p25, p75, p90, p95 = pth(5), pth(25), pth(75), pth(90), pth(95)

    # 温度序列：每天的历史百分位（0–100°）
    temperature: list = [
        round(percentile_of(v, sorted_vals), 4) if v is not None else None
        for v in indicator
    ]

    # 各温区历史天数
    zone_days = {"diamond": 0, "dca": 0, "fair": 0, "warm": 0, "hot": 0, "extreme": 0}
    for v in valid_vals:
        if   v < p5:  zone_days["diamond"] += 1
        elif v < p25: zone_days["dca"]     += 1
        elif v < p75: zone_days["fair"]    += 1
        elif v < p90: zone_days["warm"]    += 1
        elif v < p95: zone_days["hot"]     += 1
        else:         zone_days["extreme"] += 1

    # 最新有效交易日
    last_idx = len(indicator) - 1
    while last_idx >= 0 and indicator[last_idx] is None:
        last_idx -= 1

    current_ind = indicator[last_idx]
    current_price = float(prices_arr[last_idx])
    prev_price = float(prices_arr[last_idx - 1]) if last_idx > 0 else current_price
    change_pct = (current_price - prev_price) / prev_price * 100
    current_pct = percentile_of(current_ind, sorted_vals)
    zone_key, zone_label, zone_hint = classify_zone(current_pct)

    days_cheaper = sum(1 for v in valid_vals if v < current_ind)
    days_more_expensive = total_days - days_cheaper - 1

    update_time = datetime.now().strftime("%Y-%m-%d %H:%M CST")

    print(f"  {name:<6}  温度 {current_pct:5.1f}°  [{zone_key}]  价格 {current_price:.2f}  {change_pct:+.2f}%")

    return {
        "code": code,
        "name": name,
        "market": market,
        "update_time": update_time,
        "dates": dates_list,
        "prices": [round(float(p), 4) for p in prices_arr],
        "temperature": temperature,
        "current": {
            "date": dates_list[last_idx],
            "price": round(current_price, 2),
            "change_pct": round(change_pct, 4),
            "percentile": round(current_pct, 4),
            "zone_key": zone_key,
            "zone_label": zone_label,
            "zone_hint": zone_hint,
            "days_cheaper": days_cheaper,
            "days_more_expensive": days_more_expensive,
            "total_days": total_days,
            "zone_days": zone_days,
        },
    }


# ─── 主程序 ───────────────────────────────────────────────────────────────────

def main() -> None:
    if already_updated_today():
        print("今日数据已是最新，跳过更新。")
        return

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    results = []
    for info in INDICES:
        try:
            result = process_index(info)
            results.append(result)
        except Exception as exc:
            print(f"[ERROR] {info['name']} ({info['code']}) 处理失败，已跳过: {exc}")

    if not results:
        raise RuntimeError("所有指数均处理失败，不写入文件。")

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n✓ 数据已写入 {OUTPUT_PATH}（共 {len(results)} 个指数）")


if __name__ == "__main__":
    main()

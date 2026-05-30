# 宽基指数温度计 / Index Thermometer

> A 股宽基估值温度感知系统  
> by @韭菜老猫2019

**宽基指数温度计** 是一个面向 A 股宽基指数的估值温度仪表盘。它将指数当前价格相对于中长期持仓成本的位置，映射为一个 **0–100° 的温度值**，帮助用户快速感知市场当前处于“冰点、偏冷、常温、偏热、过热、沸腾”等不同温区。

本项目采用静态前端展示，数据由 Python 脚本定时采集与计算，并通过 GitHub Actions 自动更新。

---

## 功能特性

- **宽基指数监控**：当前支持上证指数、沪深 300、科创 50、创业板指。
- **温度值展示**：将市场位置转化为 0–100° 的直观温度。
- **温区判断**：自动标记冰点、偏冷、常温、偏热、过热、沸腾。
- **历史分位分析**：展示当前温度在历史样本中的相对位置。
- **走势图表**：同时展示温度走势与指数收盘价走势。
- **多周期切换**：支持 3M、6M、1Y、全部周期查看。
- **自动更新数据**：工作日收盘后自动拉取并计算最新数据。
- **静态部署友好**：无需后端服务，可部署到 GitHub Pages。

---

## 支持指数

| 指数名称 | 代码 | 市场 |
|---|---:|---|
| 上证指数 | sh000001 | SH |
| 沪深 300 | sh000300 | SH |
| 科创 50 | sh000688 | SH |
| 创业板指 | sz399006 | SZ |

---

## 温度值是如何计算的？

项目核心思想是：**把市场情绪当作温度**。

当指数价格显著低于中长期持仓成本时，市场往往处于悲观、便宜、低温状态；当指数价格显著高于中长期持仓成本时，市场可能处于乐观、昂贵、高温状态。

当前模型综合使用：

- **MA200**：约 1 年交易日的持仓成本参考；
- **MA850**：约 3.5 年交易日的长期持仓成本参考；
- **历史分位数**：将当前指标值与历史同口径样本进行比较。

核心指标：

```text
indicator = (price / MA200) × sqrt(price / MA850)
```

随后，将该指标在历史样本中的分位数映射为温度值：

```text
temperature = percentile(indicator) × 100
```

温度越低，代表当前市场比大多数历史时段更冷；温度越高，代表当前市场比大多数历史时段更热。

---

## 温区说明

| 温区 | 温度范围 | 含义 |
|---|---:|---|
| 冰点 | 0–5° | 历史最寒冷的 5% 时段 |
| 偏冷 | 5–25° | 历史较冷的 20% 时段 |
| 常温 | 25–75° | 历史中段，约 50% 时段 |
| 偏热 | 75–90° | 历史较热的 15% 时段 |
| 过热 | 90–95° | 历史高位的 5% 时段 |
| 沸腾 | 95–100° | 历史最炎热的 5% 时段 |

---

## 项目结构

```text
index-thermometer/
├── .github/
│   └── workflows/
│       └── update_data.yml       # GitHub Actions 自动更新任务
├── data/
│   └── index_data.json           # 前端读取的指数温度数据
├── images/
│   ├── wechat-qr-placeholder.svg
│   └── wechat-qrq.png
├── scripts/
│   ├── fetch_data.py             # 数据采集与温度计算脚本
│   └── requirements.txt          # Python 依赖
├── app.js                        # 前端交互与图表逻辑
├── index.html                    # 页面结构
├── mock-data.js                  # 本地模拟数据
├── style.css                     # 页面样式
└── README.md
```

---

## 本地运行

由于前端会通过 `fetch()` 读取 `data/index_data.json`，建议使用本地静态服务器运行，而不是直接双击打开 `index.html`。

```bash
git clone https://github.com/9caicat/index-thermometer.git
cd index-thermometer

python -m http.server 8000
```

然后在浏览器访问：

```text
http://localhost:8000
```

---

## 更新数据

### 1. 安装依赖

```bash
cd index-thermometer

python -m venv .venv
source .venv/bin/activate

pip install -r scripts/requirements.txt
```

Windows 用户可使用：

```bash
.venv\Scripts\activate
pip install -r scripts/requirements.txt
```

### 2. 拉取并计算最新数据

```bash
python scripts/fetch_data.py
```

脚本会：

1. 使用 AkShare 拉取指数历史数据；
2. 计算 MA200、MA850；
3. 计算温度指标与历史分位；
4. 生成或更新 `data/index_data.json`。

---

## 自动更新机制

项目内置 GitHub Actions 工作流：

```text
.github/workflows/update_data.yml
```

默认配置为：

- 工作日自动运行；
- UTC 08:10 触发，即北京时间 16:10；
- 安装 Python 依赖；
- 执行 `scripts/fetch_data.py`；
- 如 `data/index_data.json` 有变化，则自动提交回仓库。

也可以在 GitHub Actions 页面中手动触发，用于首次回填或补跑数据。

---

## 数据格式说明

前端主要读取 `data/index_data.json`。每个指数的数据结构大致如下：

```json
{
  "code": "sh000001",
  "name": "上证指数",
  "market": "SH",
  "update_time": "2026-01-01 16:10 CST",
  "dates": ["2020-01-01"],
  "prices": [3000.0],
  "temperature": [56.0],
  "current": {
    "date": "2026-01-01",
    "price": 3000.0,
    "change_pct": 0.42,
    "percentile": 56.0,
    "zone_key": "fair",
    "zone_label": "常 温",
    "zone_hint": "温度居中 · 约一半的历史时段处于此区间",
    "days_cheaper": 198,
    "days_more_expensive": 152,
    "total_days": 351,
    "zone_days": {
      "diamond": 18,
      "dca": 70,
      "fair": 176,
      "warm": 52,
      "hot": 17,
      "extreme": 18
    }
  }
}
```

---

## 前端展示逻辑

前端由 `index.html`、`style.css` 和 `app.js` 组成。

主要能力包括：

- 加载 `data/index_data.json`；
- 数据缺失时自动回退到 `mock-data.js`；
- 渲染指数卡片；
- 渲染温度计；
- 渲染历史温区分布；
- 使用 ECharts 展示温度与收盘价走势；
- 支持不同时间范围切换。

---

## 风险提示

本项目仅用于市场观察、估值温度感知与研究展示，不构成任何投资建议。

使用时请注意：

- 温度值不是买卖信号；
- 极低温度不代表市场一定马上反弹；
- 极高温度不代表市场一定马上见顶；
- V 型快速下跌与反弹阶段，指标可能滞后；
- 历史分位依赖历史样本，市场结构变化可能导致阈值漂移；
- 本指标更适合宽基指数和行业 ETF，不建议直接套用于个股。

请结合宏观环境、市场流动性、估值、盈利周期、成交量等因素综合判断。

---

## Roadmap

- [ ] 增加更多宽基指数
- [ ] 支持行业 ETF 温度计
- [ ] 增加截图与在线演示地址
- [ ] 增加配置化指数列表
- [ ] 增加数据更新失败告警
- [ ] 增加历史回测与信号统计
- [ ] 补充开源许可证

---

## 鸣谢

- 数据采集：AkShare
- 图表展示：ECharts
- 项目作者：@韭菜老猫2019

---

## License

当前仓库暂未声明开源许可证。  
如需复用、二次开发或商业使用，请先联系项目作者。

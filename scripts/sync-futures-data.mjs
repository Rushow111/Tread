// Dataset is generated only from declared source metadata; no synthetic prices.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SNAPSHOT_END = "2026-08-31";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "public/data/futures.json");
const CACHE_DIR = "/tmp/price-atlas-market-cache";
const USER_AGENT =
  "Mozilla/5.0 (compatible; PriceAtlas/1.0; +https://global-price-atlas.gc11119242530.chatgpt.site)";

function domestic(exchange, rows) {
  return rows.map(([symbol, name, listedAt, unit = "元/吨", decimals = 0]) => ({
    id: `${exchange}:${symbol}`,
    symbol,
    name,
    exchange,
    category: "中国期货",
    unit,
    currency: "CNY",
    decimals,
    listedAt,
  }));
}

// 在市期货品种清单。行情解析按品种代码自动聚合全部合约月份，新增月份无需维护。
const domesticInstruments = [
  ...domestic("SHFE", [
    ["CU", "铜", "1993-03-01"], ["AL", "铝", "1992-05-28"],
    ["ZN", "锌", "2007-03-26"], ["PB", "铅", "2011-03-24"],
    ["NI", "镍", "2015-03-27"], ["SN", "锡", "2015-03-27"],
    ["AO", "氧化铝", "2023-06-19"], ["AD", "铸造铝合金", "2025-06-10"],
    ["AU", "黄金", "2008-01-09", "元/克", 2], ["AG", "白银", "2012-05-10", "元/千克"],
    ["RB", "螺纹钢", "2009-03-27"], ["WR", "线材", "2009-03-27"],
    ["HC", "热轧卷板", "2014-03-21"], ["SS", "不锈钢", "2019-09-25"],
    ["FU", "燃料油", "2004-08-25"], ["BU", "石油沥青", "2013-10-09"],
    ["RU", "天然橡胶", "1993-11-01"], ["SP", "纸浆", "2018-11-27"],
    ["BR", "丁二烯橡胶", "2023-07-28"],
  ]),
  ...domestic("INE", [
    ["SC", "原油", "2018-03-26", "元/桶", 1], ["NR", "20号胶", "2019-08-12"],
    ["LU", "低硫燃料油", "2020-06-22"], ["BC", "国际铜", "2020-11-19"],
    ["EC", "集运指数（欧线）", "2023-08-18", "指数点", 2],
  ]),
  ...domestic("CZCE", [
    ["PM", "普麦", "2012-01-17"], ["WH", "强麦", "2013-05-28"],
    ["CF", "棉花", "2004-06-01"], ["SR", "白糖", "2006-01-06"],
    ["TA", "PTA", "2006-12-18"], ["OI", "菜籽油", "2007-06-08"],
    ["RI", "早籼稻", "2009-04-20"], ["MA", "甲醇", "2011-10-28"],
    ["FG", "玻璃", "2012-12-03"], ["RS", "油菜籽", "2012-12-28"],
    ["RM", "菜籽粕", "2012-12-28"], ["ZC", "动力煤", "2013-09-26"],
    ["JR", "粳稻", "2013-11-18"], ["LR", "晚籼稻", "2014-07-08"],
    ["SF", "硅铁", "2014-08-08"], ["SM", "锰硅", "2014-08-08"],
    ["CY", "棉纱", "2017-08-18"], ["AP", "苹果", "2017-12-22"],
    ["CJ", "红枣", "2019-04-30"], ["UR", "尿素", "2019-08-09"],
    ["SA", "纯碱", "2019-12-06"], ["PF", "短纤", "2020-10-12"],
    ["PK", "花生", "2021-02-01"], ["PX", "对二甲苯", "2023-09-15"],
    ["SH", "烧碱", "2023-09-15"], ["PR", "瓶片", "2024-08-30"],
  ]),
  ...domestic("GFEX", [
    ["SI", "工业硅", "2022-12-22"], ["LC", "碳酸锂", "2023-07-21"],
    ["PS", "多晶硅", "2024-12-26"],
  ]),
];

const foreignInstruments = [
  ["GC=F", "COMEX 黄金", "COMEX", "美元/盎司", 1],
  ["SI=F", "COMEX 白银", "COMEX", "美元/盎司", 3],
  ["HG=F", "COMEX 铜", "COMEX", "美元/磅", 4],
  ["CL=F", "WTI 原油", "NYMEX", "美元/桶", 2],
  ["BZ=F", "布伦特原油", "ICE", "美元/桶", 2],
  ["NG=F", "天然气", "NYMEX", "美元/MMBtu", 3],
  ["ZC=F", "CBOT 玉米", "CBOT", "美分/蒲式耳", 2],
  ["ZW=F", "CBOT 小麦", "CBOT", "美分/蒲式耳", 2],
  ["ZS=F", "CBOT 大豆", "CBOT", "美分/蒲式耳", 2],
  ["KC=F", "ICE 咖啡", "ICE", "美分/磅", 2],
  ["CT=F", "ICE 棉花", "ICE", "美分/磅", 2],
  ["SB=F", "ICE 原糖", "ICE", "美分/磅", 2],
  ["LE=F", "CME 活牛", "CME", "美分/磅", 3],
  ["HE=F", "CME 瘦肉猪", "CME", "美分/磅", 3],
].map(([symbol, name, exchange, unit, decimals]) => ({
  id: `YF:${symbol}`,
  symbol,
  name,
  exchange,
  category: "全球期货",
  unit,
  currency: "USD",
  decimals,
}));

const sources = {
  SHFE: {
    name: "上海期货交易所",
    shortName: "上期所官方",
    url: "https://www.shfe.com.cn/reports/tradedata/datadownload/",
    authority: "official",
    delay: "交易日收盘后更新",
  },
  INE: {
    name: "上海国际能源交易中心",
    shortName: "能源中心官方",
    url: "https://www.ine.cn/reports/tradedata/datadownload/",
    authority: "official",
    delay: "交易日收盘后更新",
  },
  CZCE: {
    name: "郑州商品交易所",
    shortName: "郑商所官方",
    url: "https://www.czce.com.cn/cn/jysj/lshqxz/H077003019index_1.htm",
    authority: "official",
    delay: "交易日收盘后更新",
  },
  GFEX: {
    name: "广州期货交易所",
    shortName: "广期所官方",
    url: "http://www.gfex.com.cn/gfex/lshq/lshqxz_new.shtml",
    authority: "official",
    delay: "交易日收盘后更新",
  },
  YAHOO: {
    name: "Yahoo Finance",
    shortName: "免费第三方",
    url: "https://finance.yahoo.com/markets/commodities/",
    authority: "third-party",
    delay: "延迟日线；并非交易所官方",
  },
};

function compactDate(date) {
  return date.replaceAll("-", "");
}

function weekdays(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (cursor <= stop) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function number(value) {
  if (typeof value === "string") value = value.replaceAll(",", "").trim();
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

async function request(url, init = {}, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "user-agent": USER_AGENT, ...init.headers },
        signal: controller.signal,
      });
      const body = await response.text();
      clearTimeout(timeout);
      if (response.ok) return body;
      if (response.status === 404 || response.status === 412) return null;
      lastError = new Error(`${response.status} ${url}`);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
    }
  }
  throw lastError;
}

function aggregateRows(date, rows, allowedSymbols) {
  const grouped = new Map();
  for (const row of rows) {
    if (!allowedSymbols.has(row.symbol)) continue;
    if (row.low == null || row.high == null) continue;
    const current = grouped.get(row.symbol);
    grouped.set(row.symbol, {
      date,
      low: current ? Math.min(current.low, row.low) : row.low,
      high: current ? Math.max(current.high, row.high) : row.high,
    });
  }
  return grouped;
}

function parseShfeFamily(date, body) {
  const json = JSON.parse(body);
  const rows = Array.isArray(json.o_curinstrument) ? json.o_curinstrument : [];
  return rows
    .filter((row) => String(row.PRODUCTCLASS ?? "1") === "1")
    .map((row) => ({
      symbol: String(row.PRODUCTGROUPID ?? row.PRODUCTID ?? "")
        .trim()
        .split("_")[0]
        .toUpperCase(),
      low: number(row.LOWESTPRICE),
      high: number(row.HIGHESTPRICE),
      date,
    }));
}

function parseCzce(date, body) {
  const rows = [];
  for (const line of body.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const match = cells[0]?.match(/^([A-Za-z]+)/);
    if (!match) continue;
    rows.push({
      symbol: match[1].toUpperCase(),
      high: number(cells[3]),
      low: number(cells[4]),
      date,
    });
  }
  return rows;
}

async function mapConcurrent(items, concurrency, worker, label) {
  const result = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        result[index] = await worker(items[index]);
      } catch (error) {
        result[index] = { error: String(error) };
      }
      completed += 1;
      if (completed % 100 === 0 || completed === items.length) {
        console.log(`${label}: ${completed}/${items.length}`);
      }
    }
  });
  await Promise.all(runners);
  return result;
}

async function loadDomesticExchange(exchange, start, parser, makeRequest, concurrency = 36) {
  const cachePath = resolve(CACHE_DIR, `${exchange}-${SNAPSHOT_END}.json`);
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    const expectedIds = domesticInstruments
      .filter((asset) => asset.exchange === exchange)
      .map((asset) => asset.id)
      .sort();
    const cacheIsComplete =
      cached.map((asset) => asset.id).sort().join("|") === expectedIds.join("|") &&
      cached.every((asset) => asset.coverageEnd === SNAPSHOT_END);
    if (cacheIsComplete) {
      console.log(`${exchange}: using completed checkpoint`);
      return cached;
    }
    console.log(`${exchange}: incomplete checkpoint ignored`);
  } catch {
    // No complete checkpoint exists for this exchange yet.
  }
  const instruments = domesticInstruments.filter((item) => item.exchange === exchange);
  const allowed = new Set(instruments.map((item) => item.symbol));
  const days = weekdays(start, SNAPSHOT_END);
  const records = Object.fromEntries(instruments.map((item) => [item.symbol, []]));
  const responses = await mapConcurrent(
    days,
    concurrency,
    async (date) => {
      const body = await makeRequest(date);
      if (!body || body.startsWith("<")) return null;
      const grouped = aggregateRows(date, parser(date, body), allowed);
      return Object.fromEntries(grouped);
    },
    exchange,
  );

  for (const response of responses) {
    if (!response || response.error) continue;
    for (const [symbol, point] of Object.entries(response)) {
      records[symbol].push([point.date, point.low, point.high]);
    }
  }

  const assets = instruments.map((instrument) => {
    const series = records[instrument.symbol].sort((a, b) => a[0].localeCompare(b[0]));
    const first = series[0]?.[0] ?? null;
    const listed = new Date(`${instrument.listedAt}T00:00:00Z`).getTime();
    const firstTime = first ? new Date(`${first}T00:00:00Z`).getTime() : Infinity;
    return {
      ...instrument,
      sourceKey: exchange,
      dataModel: "同一品种全部上市合约：日低取最小值，日高取最大值",
      fullHistory: firstTime - listed <= 7 * 86_400_000,
      coverageStart: first,
      coverageEnd: series.at(-1)?.[0] ?? null,
      series,
    };
  });
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, JSON.stringify(assets), "utf8");
  console.log(`${exchange}: checkpoint saved`);
  return assets;
}

async function loadForeign(instrument) {
  const period2 = Math.floor(
    new Date(`${SNAPSHOT_END}T00:00:00Z`).getTime() / 1000 + 86_400,
  );
  const url =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(instrument.symbol)}` +
    `?period1=0&period2=${period2}&interval=1d&events=history`;
  const body = await request(url, {}, 3);
  const json = JSON.parse(body);
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`${instrument.symbol}: ${json.chart?.error?.description ?? "no data"}`);
  const quote = result.indicators?.quote?.[0];
  const series = [];
  for (let index = 0; index < result.timestamp.length; index += 1) {
    const low = number(quote.low[index]);
    const high = number(quote.high[index]);
    if (low == null || high == null || low > high) continue;
    series.push([
      new Date(result.timestamp[index] * 1000).toISOString().slice(0, 10),
      low,
      high,
    ]);
  }
  return {
    ...instrument,
    sourceKey: "YAHOO",
    dataModel: "免费连续近月日线代理；不是同日全部合约月份之最",
    fullHistory: false,
    coverageStart: series[0]?.[0] ?? null,
    coverageEnd: series.at(-1)?.[0] ?? null,
    series,
  };
}

async function loadGfexBulk() {
  const cachePath = resolve(CACHE_DIR, `GFEX-${SNAPSHOT_END}.json`);
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    const expectedIds = domesticInstruments
      .filter((asset) => asset.exchange === "GFEX")
      .map((asset) => asset.id)
      .sort();
    const cacheIsComplete =
      cached.map((asset) => asset.id).sort().join("|") === expectedIds.join("|") &&
      cached.every((asset) => asset.coverageEnd === SNAPSHOT_END);
    if (cacheIsComplete) {
      console.log("GFEX: using completed checkpoint");
      return cached;
    }
    console.log("GFEX: replacing incomplete checkpoint with official annual files");
  } catch {
    // No complete checkpoint exists yet.
  }

  const indexBody = await request(
    "http://www.gfex.com.cn/u/interfacesWebFile/loadList_fileall",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "type=FUTURES&filetype=csv",
    },
    3,
  );
  const index = JSON.parse(indexBody);
  if (index.code !== "0" || !Array.isArray(index.data)) {
    throw new Error(`GFEX annual-file index: ${index.msg ?? "invalid response"}`);
  }

  const files = index.data
    .filter((item) => Number(item.year) >= 2022 && Number(item.year) <= 2026)
    .sort((left, right) => String(left.year).localeCompare(String(right.year)));
  const bodies = await mapConcurrent(
    files,
    5,
    (item) =>
      request(
        `http://www.gfex.com.cn/gfex/gfexfile/history/${encodeURIComponent(item.filename)}`,
        {},
        3,
      ),
    "GFEX annual files",
  );

  const instruments = domesticInstruments.filter((item) => item.exchange === "GFEX");
  const allowed = new Set(instruments.map((item) => item.symbol));
  const byDate = new Map();
  for (const body of bodies) {
    if (!body || body.error) continue;
    for (const line of body.replace(/^\uFEFF/, "").split(/\r?\n/).slice(2)) {
      const cells = line.split(",").map((cell) => cell.trim());
      const compact = cells[0];
      const match = cells[3]?.match(/^([A-Za-z]+)/);
      if (!/^\d{8}$/.test(compact ?? "") || !match) continue;
      const symbol = match[1].toUpperCase();
      if (!allowed.has(symbol)) continue;
      const high = number(cells[6]);
      const low = number(cells[7]);
      if (low == null || high == null || low > high) continue;
      const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
      if (date > SNAPSHOT_END) continue;
      const key = `${date}:${symbol}`;
      const current = byDate.get(key);
      byDate.set(key, {
        date,
        symbol,
        low: current ? Math.min(current.low, low) : low,
        high: current ? Math.max(current.high, high) : high,
      });
    }
  }

  const assets = instruments.map((instrument) => {
    const series = Array.from(byDate.values())
      .filter((point) => point.symbol === instrument.symbol)
      .map((point) => [point.date, point.low, point.high])
      .sort((left, right) => left[0].localeCompare(right[0]));
    const first = series[0]?.[0] ?? null;
    const listed = new Date(`${instrument.listedAt}T00:00:00Z`).getTime();
    const firstTime = first ? new Date(`${first}T00:00:00Z`).getTime() : Infinity;
    return {
      ...instrument,
      sourceKey: "GFEX",
      dataModel: "同一品种全部上市合约：日低取最小值，日高取最大值",
      fullHistory: firstTime - listed <= 7 * 86_400_000,
      coverageStart: first,
      coverageEnd: series.at(-1)?.[0] ?? null,
      series,
    };
  });
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, JSON.stringify(assets), "utf8");
  console.log("GFEX: official annual-file checkpoint saved");
  return assets;
}

const domesticJobs = [
  loadDomesticExchange(
    "SHFE",
    "2002-01-07",
    parseShfeFamily,
    (date) =>
      request(
        `https://www.shfe.com.cn/data/tradedata/future/dailydata/kx${compactDate(date)}.dat`,
      ),
  ),
  loadDomesticExchange(
    "INE",
    "2018-03-26",
    parseShfeFamily,
    (date) =>
      request(
        `https://www.ine.cn/data/tradedata/future/dailydata/kx${compactDate(date)}.dat`,
      ),
  ),
  loadDomesticExchange(
    "CZCE",
    "2010-01-04",
    parseCzce,
    (date) => {
      const compact = compactDate(date);
      return request(
        `https://www.czce.com.cn/cn/DFSStaticFiles/Future/${date.slice(0, 4)}/${compact}/FutureDataDaily.txt`,
      );
    },
  ),
  loadGfexBulk(),
];

const [domesticGroups, foreign] = await Promise.all([
  Promise.all(domesticJobs),
  mapConcurrent(foreignInstruments, 7, loadForeign, "GLOBAL"),
]);

const assets = [...domesticGroups.flat(), ...foreign]
  .filter((asset) => asset && !asset.error && asset.series.length > 0)
  .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));

const payload = {
  generatedAt: new Date().toISOString(),
  asOf: SNAPSHOT_END,
  methodologyVersion: "2026-09-01.v1",
  sources,
  unavailableSources: [
    {
      exchange: "DCE",
      name: "大连商品交易所",
      url: "https://www.dce.com.cn/dalianshangpin/xqsj/index.html",
      reason: "官方公开接口当前阻止服务器访问；未使用第三方数据替代",
    },
    {
      exchange: "CFFEX",
      name: "中国金融期货交易所",
      url: "https://www.cffex.com.cn/cn/lssjxz.html",
      reason: "官方历史下载当前无法稳定连接；未使用第三方数据替代",
    },
  ],
  assets,
};

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(payload)}\n`, "utf8");

console.log(
  `Wrote ${assets.length} assets / ${assets.reduce((sum, asset) => sum + asset.series.length, 0)} points to ${OUTPUT}`,
);

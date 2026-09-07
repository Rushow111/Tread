import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import WebSocketClient from "ws";

const ROOT = resolve(import.meta.dirname, "..");
const FUTURES_REGISTRY_PATH = resolve(ROOT, "data/futures-registry.json");
const STOCK_SEED_PATH = resolve(ROOT, "data/us-stock-seed.json.gz");
const FUTURES_OUTPUT = resolve(ROOT, "public/data/daily-futures.json");
const STOCK_OUTPUT = resolve(ROOT, "public/data/daily-stocks.json");
const USER_AGENT =
  "Mozilla/5.0 (compatible; PriceAtlasDaily/1.0; +https://github.com/Rushow111/Tread)";
const END_DATE = process.env.MARKET_DATA_END ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function number(value) {
  if (typeof value === "string") value = value.replaceAll(",", "").trim();
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

function compactDate(date) {
  return date.replaceAll("-", "");
}

function normalizeDate(date) {
  const text = String(date ?? "");
  return /^\d{8}$/.test(text)
    ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
    : text;
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
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

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error: String(error) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function requestText(url, init = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "user-agent": USER_AGENT, ...init.headers },
        signal: controller.signal,
      });
      const body = await response.text();
      clearTimeout(timeout);
      if (response.ok) return body;
      if ([404, 412].includes(response.status)) return null;
      lastError = new Error(`${response.status} ${url}`);
      if (response.status === 429) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 2_000));
      }
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 750));
    }
  }
  throw lastError;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function readGzipJson(path, fallback) {
  try {
    return JSON.parse(gunzipSync(await readFile(path)).toString("utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temp, path);
}

function mergeSeries(current, incoming, baselineAsOf) {
  const byDate = new Map();
  for (const point of [...(current ?? []), ...(incoming ?? [])]) {
    const date = normalizeDate(point?.[0]);
    const low = number(point?.[1]);
    const high = number(point?.[2]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= baselineAsOf || date > END_DATE) continue;
    if (low == null || high == null || low > high) continue;
    byDate.set(date, [date, low, high]);
  }
  return [...byDate.values()].sort((left, right) => left[0].localeCompare(right[0]));
}

function parseShfeFamily(body) {
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
    }));
}

function parseCzce(body) {
  const rows = [];
  for (const line of body.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const match = cells[0]?.match(/^([A-Za-z]+)/);
    if (!match) continue;
    rows.push({ symbol: match[1].toUpperCase(), high: number(cells[3]), low: number(cells[4]) });
  }
  return rows;
}

function groupDailyRows(rows, allowed) {
  const grouped = new Map();
  for (const row of rows) {
    const id = allowed.get(row.symbol);
    if (!id || row.low == null || row.high == null || row.low > row.high) continue;
    const current = grouped.get(id);
    grouped.set(id, [
      id,
      current ? Math.min(current[1], row.low) : row.low,
      current ? Math.max(current[2], row.high) : row.high,
    ]);
  }
  return [...grouped.values()];
}

function parseJsonp(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  return start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : [];
}

function frame(payload) {
  const json = JSON.stringify(payload);
  return `~m~${json.length}~m~${json}`;
}

async function updateFutures(registry, previous) {
  const baselineAsOf = registry.baselineAsOf;
  const seriesById = new Map(
    (previous.assets ?? []).map((asset) => [asset.id, mergeSeries(asset.series, [], baselineAsOf)]),
  );
  const failures = [];
  const successfulSources = new Set();

  const append = (id, points) => {
    seriesById.set(id, mergeSeries(seriesById.get(id), points, baselineAsOf));
  };

  const queryStart = (sourceKey) => {
    const dates = registry.assets
      .filter((asset) => asset.sourceKey === sourceKey)
      .flatMap((asset) => seriesById.get(asset.id)?.at(-1)?.[0] ?? []);
    const latest = dates.sort().at(-1) ?? baselineAsOf;
    return latest === baselineAsOf ? shiftDate(baselineAsOf, 1) : shiftDate(latest, -3);
  };

  const officialJobs = [
    {
      sourceKey: "SHFE",
      parser: parseShfeFamily,
      url: (date) => `https://www.shfe.com.cn/data/tradedata/future/dailydata/kx${compactDate(date)}.dat`,
    },
    {
      sourceKey: "INE",
      parser: parseShfeFamily,
      url: (date) => `https://www.ine.cn/data/tradedata/future/dailydata/kx${compactDate(date)}.dat`,
    },
    {
      sourceKey: "CZCE",
      parser: parseCzce,
      url: (date) => `https://www.czce.com.cn/cn/DFSStaticFiles/Future/${date.slice(0, 4)}/${compactDate(date)}/FutureDataDaily.txt`,
      fallbackUrl: (date) => `http://www.czce.com.cn/cn/DFSStaticFiles/Future/${date.slice(0, 4)}/${compactDate(date)}/FutureDataDaily.txt`,
    },
  ];

  await Promise.all(officialJobs.map(async ({ sourceKey, parser, url, fallbackUrl }) => {
    const assets = registry.assets.filter((asset) => asset.sourceKey === sourceKey);
    const allowed = new Map(assets.map((asset) => [asset.symbol, asset.id]));
    const dates = weekdays(queryStart(sourceKey), END_DATE);
    const responses = await mapConcurrent(dates, 12, async (date) => {
      const headers = sourceKey === "CZCE"
        ? {
            accept: "text/plain,text/html;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
            referer: "https://www.czce.com.cn/",
          }
        : {};
      let body = await requestText(url(date), { headers });
      if (!body && fallbackUrl) body = await requestText(fallbackUrl(date), { headers });
      if (!body || body.trimStart().startsWith("<")) return null;
      return { date, rows: groupDailyRows(parser(body), allowed) };
    });
    let successes = 0;
    for (const response of responses) {
      if (!response || response.error) continue;
      successes += 1;
      for (const [id, low, high] of response.rows) append(id, [[response.date, low, high]]);
    }
    if (successes > 0 || dates.length === 0) successfulSources.add(sourceKey);
    else failures.push(`${sourceKey}: no readable daily file`);
  }));

  try {
    const body = await requestText("http://www.gfex.com.cn/u/interfacesWebFile/loadList_fileall", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "type=FUTURES&filetype=csv",
    });
    const index = JSON.parse(body);
    if (String(index.code) !== "0" || !Array.isArray(index.data)) throw new Error("invalid annual-file index");
    const startYear = Number(queryStart("GFEX").slice(0, 4));
    const endYear = Number(END_DATE.slice(0, 4));
    const files = index.data.filter((item) => Number(item.year) >= startYear && Number(item.year) <= endYear);
    const bodies = await mapConcurrent(files, 2, (item) =>
      requestText(`http://www.gfex.com.cn/gfex/gfexfile/history/${encodeURIComponent(item.filename)}`),
    );
    const allowed = new Map(
      registry.assets.filter((asset) => asset.sourceKey === "GFEX").map((asset) => [asset.symbol, asset.id]),
    );
    for (const annual of bodies) {
      if (!annual || annual.error) continue;
      const byDate = new Map();
      for (const line of annual.replace(/^\uFEFF/, "").split(/\r?\n/).slice(2)) {
        const cells = line.split(",").map((cell) => cell.trim());
        const dateText = cells[0];
        const match = cells[3]?.match(/^([A-Za-z]+)/);
        if (!/^\d{8}$/.test(dateText ?? "") || !match) continue;
        const date = normalizeDate(dateText);
        const id = allowed.get(match[1].toUpperCase());
        const low = number(cells[7]);
        const high = number(cells[6]);
        if (!id || date <= baselineAsOf || date > END_DATE || low == null || high == null || low > high) continue;
        const key = `${id}:${date}`;
        const current = byDate.get(key);
        byDate.set(key, [date, current ? Math.min(current[1], low) : low, current ? Math.max(current[2], high) : high]);
      }
      for (const [key, point] of byDate) append(key.slice(0, key.lastIndexOf(":")), [point]);
    }
    successfulSources.add("GFEX");
  } catch (error) {
    failures.push(`GFEX: ${error}`);
  }

  const sinaAssets = registry.assets.filter((asset) => asset.sourceKey === "SINA_CN_FUTURES");
  const sinaResults = await mapConcurrent(sinaAssets, 8, async (asset) => {
    const proxySymbol = `${asset.symbol}0`;
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var_${proxySymbol}=/InnerFuturesNewService.getDailyKLine?symbol=${proxySymbol}`;
    const body = await requestText(url);
    const points = parseJsonp(body).map((row) => [row.d, row.l, row.h]);
    append(asset.id, points);
    return true;
  });
  const sinaSuccesses = sinaResults.filter((result) => result === true).length;
  if (sinaSuccesses > 0) successfulSources.add("SINA_CN_FUTURES");
  else if (sinaAssets.length) failures.push("SINA_CN_FUTURES: all requests failed");

  const yahooAssets = registry.assets.filter((asset) => asset.sourceKey === "YAHOO");
  const yahooResults = await mapConcurrent(yahooAssets, 8, async (asset) => {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?range=1mo&interval=1d&events=history`;
    const body = await requestText(url);
    const result = JSON.parse(body).chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    if (!result?.timestamp?.length || !quote) throw new Error(`${asset.symbol}: no chart data`);
    const points = result.timestamp.map((timestamp, index) => [
      new Date(timestamp * 1_000).toISOString().slice(0, 10),
      quote.low?.[index],
      quote.high?.[index],
    ]);
    append(asset.id, points);
    return true;
  });
  const yahooSuccesses = yahooResults.filter((result) => result === true).length;
  if (yahooSuccesses > 0) successfulSources.add("YAHOO");
  else if (yahooAssets.length) failures.push("YAHOO: all requests failed");

  async function loadTradingView(asset) {
    const providerSymbol = asset.id.replace(/^TV:/, "");
    const session = `cs_${Math.random().toString(36).slice(2, 14)}`;
    return new Promise((resolvePromise) => {
      let points = [];
      let settled = false;
      const socket = new WebSocketClient(
        `wss://data.tradingview.com/socket.io/websocket?from=symbols/${encodeURIComponent(providerSymbol)}/`,
        { headers: { Origin: "https://www.tradingview.com" } },
      );
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { socket.close(); } catch {}
        resolvePromise(value);
      };
      const timeout = setTimeout(() => finish({ error: `${providerSymbol}: timeout` }), 35_000);
      const send = (method, params) => socket.send(frame({ m: method, p: params }));
      socket.addEventListener("open", () => {
        send("set_auth_token", ["unauthorized_user_token"]);
        send("chart_create_session", [session, ""]);
        send("switch_timezone", [session, "Etc/UTC"]);
        send("resolve_symbol", [session, "symbol_1", `={"symbol":"${providerSymbol}","adjustment":"none","session":"regular"}`]);
        send("create_series", [session, "s1", "s1", "symbol_1", "1D", 400, ""]);
      });
      socket.addEventListener("message", (event) => {
        const text = event.data.toString();
        if (text.includes("~h~")) {
          socket.send(text);
          return;
        }
        for (const part of text.split(/~m~\d+~m~/).filter(Boolean)) {
          let message;
          try { message = JSON.parse(part); } catch { continue; }
          if (message.m === "timescale_update") points = message.p?.[1]?.s1?.s ?? points;
          if (message.m === "critical_error") finish({ error: `${providerSymbol}: critical error` });
          if (message.m !== "series_completed") continue;
          const incoming = [];
          for (const point of points) {
            const [timestamp, , high, low] = point.v ?? [];
            if (![timestamp, low, high].every(Number.isFinite) || low > high) continue;
            incoming.push([new Date(timestamp * 1_000).toISOString().slice(0, 10), low, high]);
          }
          append(asset.id, incoming);
          finish(true);
        }
      });
      socket.addEventListener("error", () => finish({ error: `${providerSymbol}: socket error` }));
    });
  }

  const tradingViewAssets = registry.assets.filter((asset) => asset.sourceKey === "TRADINGVIEW");
  const tradingViewResults = await mapConcurrent(tradingViewAssets, 6, loadTradingView);
  const tradingViewSuccesses = tradingViewResults.filter((result) => result === true).length;
  if (tradingViewSuccesses > 0) successfulSources.add("TRADINGVIEW");
  else if (tradingViewAssets.length) {
    const examples = tradingViewResults.filter((result) => result?.error).slice(0, 3).map((result) => result.error);
    failures.push(`TRADINGVIEW: all requests failed (${examples.join("; ")})`);
  }

  if (successfulSources.size === 0) throw new Error(`Every futures source failed: ${failures.join("; ")}`);

  const assets = registry.assets.flatMap((asset) => {
    const series = seriesById.get(asset.id) ?? [];
    return series.length ? [{ id: asset.id, series }] : [];
  });
  const asOf = assets.flatMap((asset) => asset.series.at(-1)?.[0] ?? []).sort().at(-1) ?? baselineAsOf;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baselineAsOf,
    asOf,
    assets,
    status: {
      registryCount: registry.assets.length,
      updatedAssetCount: assets.length,
      successfulSources: [...successfulSources].sort(),
      failures,
    },
  };
}

async function updateStocks(seed, previous) {
  const baselineAsOf = seed.baselineAsOf;
  const rows = new Map();
  for (const [id, symbol, date, dailyLow, historicalLow, historicalHigh] of seed.stocks) {
    rows.set(id, [id, symbol, date, dailyLow, dailyLow, historicalLow, historicalHigh]);
  }
  for (const row of previous.stocks ?? []) {
    if (Array.isArray(row) && row.length >= 7 && rows.has(row[0])) rows.set(row[0], row);
  }

  // Yahoo Spark accepts at most 20 symbols per request.
  const batches = chunks([...rows.values()], 20);
  const results = await mapConcurrent(batches, 4, async (batch) => {
    const symbols = batch.map((row) => row[1]);
    const query = new URLSearchParams({ symbols: symbols.join(","), range: "5d", interval: "1d" });
    let body;
    try {
      body = await requestText(`https://query2.finance.yahoo.com/v7/finance/spark?${query}`);
    } catch {
      body = await requestText(`https://query1.finance.yahoo.com/v7/finance/spark?${query}`);
    }
    const result = JSON.parse(body).spark?.result ?? [];
    const bySymbol = new Map(result.map((item) => [item.symbol, item.response?.[0]?.meta]));
    let updated = 0;
    for (const current of batch) {
      const [id, symbol, currentDate, currentLow, currentHigh, historicalLow, historicalHigh] = current;
      const meta = bySymbol.get(symbol);
      const date = meta?.regularMarketTime
        ? new Date(meta.regularMarketTime * 1_000).toISOString().slice(0, 10)
        : null;
      const low = number(meta?.regularMarketDayLow);
      const high = number(meta?.regularMarketDayHigh);
      if (!date || date < currentDate || date > END_DATE || low == null || high == null || low > high) continue;
      const sameDay = date === currentDate;
      const dailyLow = sameDay ? Math.min(currentLow, low) : low;
      const dailyHigh = sameDay ? Math.max(currentHigh, high) : high;
      rows.set(id, [
        id,
        symbol,
        date,
        dailyLow,
        dailyHigh,
        Math.min(historicalLow, dailyLow),
        Math.max(historicalHigh, dailyHigh),
      ]);
      updated += 1;
    }
    return updated;
  });

  const successfulBatches = results.filter((result) => typeof result === "number").length;
  if (successfulBatches === 0) {
    const examples = results.filter((result) => result?.error).slice(0, 3).map((result) => result.error);
    throw new Error(`Every Yahoo stock batch failed: ${examples.join("; ")}`);
  }
  const stocks = [...rows.values()].sort((left, right) => left[0].localeCompare(right[0]));
  const asOf = stocks.map((row) => row[2]).sort().at(-1) ?? baselineAsOf;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baselineAsOf,
    asOf,
    stocks,
    status: {
      registryCount: seed.stocks.length,
      successfulBatches,
      totalBatches: batches.length,
      updatedQuotes: results.reduce((sum, result) => sum + (typeof result === "number" ? result : 0), 0),
      failedBatches: results.filter((result) => result?.error).length,
    },
  };
}

function runSelfTest() {
  const merged = mergeSeries(
    [["2026-09-01", 10, 12]],
    [["20260901", 9, 13], ["2026-09-02", 11, 14], ["bad", 1, 2]],
    "2026-08-31",
  );
  if (JSON.stringify(merged) !== JSON.stringify([["2026-09-01", 9, 13], ["2026-09-02", 11, 14]])) {
    throw new Error("mergeSeries self-test failed");
  }
  const shfe = parseShfeFamily(JSON.stringify({ o_curinstrument: [{ PRODUCTGROUPID: "CU_f", LOWESTPRICE: "10", HIGHESTPRICE: "12" }] }));
  if (shfe[0]?.symbol !== "CU" || shfe[0]?.low !== 10 || shfe[0]?.high !== 12) {
    throw new Error("SHFE parser self-test failed");
  }
  const czce = parseCzce("CF701|x|x|12|10|x");
  if (czce[0]?.symbol !== "CF" || czce[0]?.low !== 10 || czce[0]?.high !== 12) {
    throw new Error("CZCE parser self-test failed");
  }
  console.log("Daily market updater self-test passed");
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  const [registry, seed] = await Promise.all([
    readJson(FUTURES_REGISTRY_PATH, null),
    readGzipJson(STOCK_SEED_PATH, null),
  ]);
  if (!registry?.assets?.length || !seed?.stocks?.length) throw new Error("Daily update seeds are missing");
  const [previousFutures, previousStocks] = await Promise.all([
    readJson(FUTURES_OUTPUT, { assets: [] }),
    readJson(STOCK_OUTPUT, { stocks: [] }),
  ]);
  const [futures, stocks] = await Promise.all([
    updateFutures(registry, previousFutures),
    updateStocks(seed, previousStocks),
  ]);
  await Promise.all([
    writeJsonAtomic(FUTURES_OUTPUT, futures),
    writeJsonAtomic(STOCK_OUTPUT, stocks),
  ]);
  console.log(`Futures: ${futures.status.updatedAssetCount}/${futures.status.registryCount}, as of ${futures.asOf}`);
  console.log(`Stocks: ${stocks.status.updatedQuotes}/${stocks.status.registryCount}, as of ${stocks.asOf}`);
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { trimmedRange } from './trimmed-range.mjs';

const root = resolve(import.meta.dirname, '..');
const end = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const registry = JSON.parse(await readFile(resolve(root, 'data/futures-registry.json'), 'utf8'));
const seed = JSON.parse(gunzipSync(await readFile(resolve(root, 'data/us-stock-seed.json.gz'))));
const futures = JSON.parse(await readFile(resolve(root, 'public/data/futures.json'), 'utf8'));
let dailyFutures = { assets: [] };
try { dailyFutures = JSON.parse(await readFile(resolve(root, 'public/data/daily-futures.json'), 'utf8')); } catch {}

const assets = [
  ...registry.assets.map(asset => ({ ...asset, stock: false })),
  ...seed.stocks.map(([id, symbol]) => ({ id, symbol, sourceKey: 'YAHOO', stock: true })),
];
const output = resolve(root, 'public/data/low-metrics.json');
let previous = {};
try { previous = JSON.parse(await readFile(output, 'utf8')).assets ?? {}; } catch {}
const rows = {};
let cursor = 0;
let done = 0;
let errors = 0;

async function get(url) {
  let error;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 PriceAtlas' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (caught) {
      error = caught;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 500 * (attempt + 1)));
    }
  }
  throw error;
}

async function yahooDailyLows(asset) {
  const query = new URLSearchParams({
    period1: '0',
    period2: String(Math.floor(Date.now() / 1000)),
    interval: '1d',
    events: 'history',
  });
  let text;
  try {
    text = await get(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?${query}`);
  } catch {
    text = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?${query}`);
  }
  const result = JSON.parse(text).chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result?.timestamp?.length || !quote) throw new Error('No daily-low history');
  return result.timestamp.map((timestamp, index) => [
    new Date(timestamp * 1_000).toISOString().slice(0, 10),
    quote.low?.[index],
  ]);
}

function normalizeDate(value) {
  const date = String(value ?? '');
  return /^\d{8}$/.test(date)
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    : date;
}

const bundledFutures = new Map(futures.assets.map(asset => [asset.id, asset]));
const incrementalFutures = new Map(dailyFutures.assets.map(asset => [asset.id, asset.series]));

function displayedFuturesDailyLows(asset) {
  const base = bundledFutures.get(asset.id);
  if (!base?.series?.length) throw new Error('No displayed daily-low history');
  const byDate = new Map();
  for (const [rawDate, low] of [...base.series, ...(incrementalFutures.get(asset.id) ?? [])]) {
    const date = normalizeDate(rawDate);
    const price = Number(low);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(price)) byDate.set(date, price);
  }
  return [...byDate].sort((left, right) => left[0].localeCompare(right[0]));
}

async function save() {
  await mkdir(resolve(root, 'public/data'), { recursive: true });
  const payload = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    asOf: end,
    method: 'all_available_daily_lows_trim_floor_10pct_each_tail_min_10_calendar_years',
    priceBasis: 'latest_completed_daily_low',
    assets: rows,
    status: {
      total: assets.length,
      processed: done,
      errors,
      eligible: Object.values(rows).filter(row => row.positionPct != null).length,
    },
  };
  await writeFile(`${output}.tmp`, `${JSON.stringify(payload)}\n`);
  await rename(`${output}.tmp`, output);
}

await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < assets.length) {
    const asset = assets[cursor++];
    const checkedAt = new Date().toISOString();
    try {
      const points = asset.stock
        ? await yahooDailyLows(asset)
        : displayedFuturesDailyLows(asset);
      rows[asset.id] = {
        ...trimmedRange(points, end),
        source: asset.sourceKey,
        checkedAt,
        priceBasis: 'daily_low',
        historyCoverage: asset.stock
          ? 'all_available_from_provider'
          : 'same_history_as_displayed_price_series',
        error: null,
      };
    } catch (error) {
      errors += 1;
      rows[asset.id] = {
        ...previous[asset.id],
        positionPct: null,
        widthPct: null,
        source: asset.sourceKey,
        checkedAt,
        priceBasis: 'daily_low',
        reason: 'source_unavailable',
        error: String(error),
      };
    }
    done += 1;
    if (done % 100 === 0) console.log(`Daily-low history: ${done}/${assets.length}, errors ${errors}`);
  }
}));

await save();
console.log(`Calculated ${Object.values(rows).filter(row => row.positionPct != null).length}/${assets.length}; errors ${errors}`);

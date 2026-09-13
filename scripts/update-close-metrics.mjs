import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { trimmedRange } from './trimmed-range.mjs';

const root = resolve(import.meta.dirname, '..');
const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const registry = JSON.parse(await readFile(resolve(root, 'data/futures-registry.json'), 'utf8'));
const seed = JSON.parse(gunzipSync(await readFile(resolve(root, 'data/us-stock-seed.json.gz'))));
const assets = [...registry.assets, ...seed.stocks.map(([id, symbol]) => ({ id, symbol, sourceKey: 'YAHOO', stock: true }))];
const output = resolve(root, 'public/data/close-metrics.json');
let previous = {};
try { previous = JSON.parse(await readFile(output, 'utf8')).assets ?? {}; } catch {}
const rows = {};
let cursor = 0, done = 0, errors = 0;

async function get(url) {
  let error;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 PriceAtlas' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { error = e; await new Promise(r => setTimeout(r, 500 * (attempt + 1))); }
  }
  throw error;
}

async function yahoo(asset) {
  // Explicit epoch bounds and daily interval: never use monthly summaries.
  const qs = new URLSearchParams({ period1: '0', period2: String(Math.floor(Date.now() / 1000)), interval: '1d', events: 'history' });
  let text;
  try { text = await get(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?${qs}`); }
  catch { text = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}?${qs}`); }
  const result = JSON.parse(text).chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error('No daily close history');
  const quote = result.indicators?.quote?.[0];
  // Yahoo close is split-adjusted, not dividend-adjusted; keep P in same basis.
  return result.timestamp.map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), quote?.close?.[i]]);
}

async function sina(asset) {
  const symbol = `${asset.symbol}0`;
  const body = await get(`https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var_${symbol}=/InnerFuturesNewService.getDailyKLine?symbol=${symbol}`);
  const data = JSON.parse(body.slice(body.indexOf('['), body.lastIndexOf(']') + 1));
  if (!data.length) throw new Error('No daily close history');
  return data.map(r => [r.d, r.c == null || r.c === '' ? null : Number(r.c)]);
}

function tradingView(asset) {
  return new Promise((resolveResult, reject) => {
    const symbol = asset.id.replace(/^TV:/, '');
    const session = `cs_${Math.random().toString(36).slice(2)}`;
    const ws = new WebSocket('wss://data.tradingview.com/socket.io/websocket', { headers: { Origin: 'https://www.tradingview.com' } });
    let settled = false;
    const points = new Map();
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); ws.close(); error ? reject(error) : resolveResult([...points.values()]); };
    const timer = setTimeout(() => finish(new Error('TradingView timeout')), 45000);
    const send = (m, p) => { const v = JSON.stringify({m,p}); ws.send(`~m~${v.length}~m~${v}`); };
    ws.on('open', () => {
      send('set_auth_token', ['unauthorized_user_token']); send('chart_create_session', [session, '']);
      send('switch_timezone', [session, 'Etc/UTC']);
      send('resolve_symbol', [session, 's', `={"symbol":"${symbol}","adjustment":"none","session":"regular"}`]);
      send('create_series', [session, 's1', 's1', 's', '1D', 20000, '']);
    });
    ws.on('message', raw => {
      const text = raw.toString();
      if (text.includes('~h~')) { ws.send(text); return; }
      for (const part of text.split(/~m~\d+~m~/).filter(Boolean)) {
        let m; try { m = JSON.parse(part); } catch { continue; }
        if (m.m === 'timescale_update') for (const p of m.p?.[1]?.s1?.s ?? []) {
          const [time, , , , close] = p.v;
          if (Number.isFinite(time)) points.set(time, [new Date(time * 1000).toISOString().slice(0, 10), close]);
        }
        if (['critical_error', 'symbol_error', 'series_error'].includes(m.m)) finish(new Error(m.m));
        if (m.m === 'series_completed') finish(points.size ? null : new Error('Empty series'));
      }
    });
    ws.on('error', finish);
  });
}

async function save() {
  await mkdir(resolve(root, 'public/data'), { recursive: true });
  await writeFile(`${output}.tmp`, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), asOf: end, method: 'all_available_daily_closes_trim_floor_10pct_each_tail_min_10_calendar_years', priceBasis: 'latest_completed_daily_close', assets: rows, status: { total: assets.length, processed: done, errors, eligible: Object.values(rows).filter(r => r.positionPct != null).length } }) + '\n');
  await rename(`${output}.tmp`, output);
}

await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < assets.length) {
    const asset = assets[cursor++];
    const checkedAt = new Date().toISOString();
    try {
      let points;
      if (asset.sourceKey === 'YAHOO') points = await yahoo(asset);
      else if (asset.sourceKey === 'SINA_CN_FUTURES') points = await sina(asset);
      else if (asset.sourceKey === 'TRADINGVIEW') points = await tradingView(asset);
      else {
        // Existing official files stored only low/high. Do not substitute them
        // or silently switch domestic instruments to unofficial close data.
        rows[asset.id] = { positionPct: null, widthPct: null, reason: 'official_close_history_not_collected', source: asset.sourceKey, checkedAt };
        done++; continue;
      }
      rows[asset.id] = { ...trimmedRange(points, end), source: asset.sourceKey, checkedAt, priceBasis: 'daily_close', historyCoverage: 'all_available_from_provider', error: null };
    } catch (e) {
      errors++;
      rows[asset.id] = { ...previous[asset.id], positionPct: null, widthPct: null, source: asset.sourceKey, checkedAt, reason: 'source_unavailable', error: String(e) };
    }
    done++;
    if (done % 100 === 0) console.log(`Daily close history: ${done}/${assets.length}, errors ${errors}`);
  }
}));
await save();
console.log(`Calculated ${Object.values(rows).filter(r => r.positionPct != null).length}/${assets.length}; errors ${errors}`);

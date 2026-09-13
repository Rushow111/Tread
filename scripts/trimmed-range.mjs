// Discrete trimming, not interpolated quantiles. Real dated daily closes only.
export function trimmedRange(points, asOf) {
  const byDate = new Map();
  for (const [date, close] of points ?? []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= asOf && typeof close === 'number' && Number.isFinite(close)) byDate.set(date, close);
  }
  const dates = [...byDate.keys()].sort();
  const cutoff = new Date(`${asOf}T00:00:00Z`);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 10);
  const base = { sampleCount: dates.length, start: dates[0] ?? null, priceDate: dates.at(-1) ?? null, price: byDate.get(dates.at(-1)) ?? null, positionPct: null, widthPct: null };
  if (!dates.length || dates[0] > cutoff.toISOString().slice(0, 10)) return { ...base, reason: 'history_under_10_years' };
  const sorted = [...byDate.values()].sort((a, b) => a - b);
  const k = Math.floor(sorted.length * 0.1);
  const low = sorted[k], high = sorted[sorted.length - k - 1];
  const width = high - low, middle = (low + high) / 2;
  const positionPct = width === 0 ? null : (base.price - low) / width * 100;
  const widthPct = middle === 0 ? null : width / middle * 100;
  return { ...base, trimmedEachSide: k, positionPct: Number.isFinite(positionPct) ? positionPct : null, widthPct: Number.isFinite(widthPct) ? widthPct : null, reason: width === 0 || middle === 0 ? 'degenerate_range' : null };
}

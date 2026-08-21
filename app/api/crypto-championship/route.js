export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const START = 100;
const FEE = 0.0002;
const SLIPPAGE = 0.0002;
const DAY = 86400000;
const BASE = 'https://api.binance.us/api/v3';

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Binance.US ${r.status}${t ? `: ${t.slice(0, 100)}` : ''}`);
  }
  return r.json();
}

async function getUniverse(limit = 15) {
  const [info, tickers] = await Promise.all([
    getJson(`${BASE}/exchangeInfo`),
    getJson(`${BASE}/ticker/24hr`)
  ]);
  const bySymbol = new Map(tickers.map(t => [t.symbol, t]));
  return info.symbols
    .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USD' && s.isSpotTradingAllowed !== false)
    .map(s => ({ symbol: s.symbol, baseAsset: s.baseAsset, quoteVolume: Number(bySymbol.get(s.symbol)?.quoteVolume || 0) }))
    .filter(s => s.quoteVolume > 0)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, limit);
}

async function fetchCandles(symbol, days = 30) {
  const end = Date.now();
  const start = end - days * DAY;
  const out = [];
  let cursor = start;
  while (cursor < end) {
    const rows = await getJson(`${BASE}/klines?symbol=${encodeURIComponent(symbol)}&interval=15m&startTime=${cursor}&endTime=${end}&limit=1000`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) out.push({ time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
    const next = Number(rows[rows.length - 1][0]) + 15 * 60 * 1000;
    if (next <= cursor) break;
    cursor = next;
    if (rows.length < 1000) break;
  }
  const map = new Map();
  out.forEach(c => map.set(c.time, c));
  return [...map.values()].filter(c => c.time >= start && c.time <= end).sort((a, b) => a.time - b.time);
}

function aggregate(candles, minutes) {
  if (minutes === 15) return candles;
  const size = minutes * 60 * 1000;
  const groups = new Map();
  for (const c of candles) {
    const key = Math.floor(c.time / size) * size;
    const g = groups.get(key);
    if (!g) groups.set(key, { ...c, time: key });
    else { g.high = Math.max(g.high, c.high); g.low = Math.min(g.low, c.low); g.close = c.close; g.volume += c.volume; }
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

function tradeBuy(cash, price) {
  const execution = price * (1 + SLIPPAGE);
  const fee = cash * FEE;
  return { btc: (cash - fee) / execution, fee };
}
function tradeSell(units, price) {
  const execution = price * (1 - SLIPPAGE);
  const gross = units * execution;
  const fee = gross * FEE;
  return { cash: gross - fee, fee };
}

function simulateReversal(candles, cfg) {
  let cash = START, units = 0, position = 'CASH', entry = 0, fees = 0, trades = 0, wins = 0, losses = 0;
  let peak = START, maxDrawdown = 0, entryCapital = 0, cooldown = 0;
  for (let i = Math.max(3, cfg.lookback); i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    if (cooldown > 0) cooldown--;
    const recent = candles.slice(i - cfg.lookback, i);
    const recentLow = Math.min(...recent.map(x => x.low));
    const recentHigh = Math.max(...recent.map(x => x.high));
    const fell = recent[0].close > recent[recent.length - 1].close;
    const rose = recent[0].close < recent[recent.length - 1].close;
    const rebound = c.close / recentLow - 1;
    const pullback = c.close / recentHigh - 1;
    const higherLow = c.low > recentLow && c.close > prev.high;
    const lowerHigh = c.high < recentHigh && c.close < prev.low;
    const buySignal = position === 'CASH' && cooldown === 0 && fell && higherLow && rebound >= cfg.confirm;
    const returnPct = position === 'COIN' ? c.close / entry - 1 : 0;
    const stopHit = position === 'COIN' && returnPct <= -cfg.stop;
    const sellSignal = position === 'COIN' && rose && lowerHigh && pullback <= -cfg.confirm && returnPct >= cfg.minProfit;

    if (buySignal) {
      entryCapital = cash;
      const t = tradeBuy(cash, c.close);
      units = t.btc; fees += t.fee; cash = 0; entry = c.close; position = 'COIN'; trades++;
    } else if (position === 'COIN' && (sellSignal || stopHit)) {
      const t = tradeSell(units, c.close);
      cash = t.cash; fees += t.fee; units = 0; trades++;
      if (cash > entryCapital) wins++; else losses++;
      position = 'CASH'; entry = 0; entryCapital = 0; cooldown = cfg.cooldown;
    }
    const equity = cash + units * c.close;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const last = candles[candles.length - 1].close;
  const endingBalance = cash + units * last;
  const cycles = wins + losses;
  return { ...cfg, endingBalance, returnPct: (endingBalance / START - 1) * 100, trades, fees, winRate: cycles ? wins / cycles * 100 : 0, maxDrawdown: maxDrawdown * 100 };
}

function buyHold(candles) {
  const first = candles[0].close, last = candles[candles.length - 1].close;
  return START * last / first;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { symbol: items[i].symbol, error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function GET() {
  try {
    const universe = await getUniverse(15);
    const configs = [];
    for (const minutes of [15, 30]) for (const lookback of [3, 5, 8]) for (const confirm of [0.0015, 0.003, 0.005]) {
      configs.push({ minutes, lookback, confirm, minProfit: 0.0015, stop: 0.02, cooldown: 1 });
    }
    const assets = await mapLimit(universe, 4, async asset => {
      const raw = await fetchCandles(asset.symbol, 30);
      if (raw.length < 2000) throw new Error(`Only ${raw.length} candles`);
      const hold = buyHold(raw);
      const byMinutes = new Map([[15, raw], [30, aggregate(raw, 30)]]);
      const results = configs.map(cfg => simulateReversal(byMinutes.get(cfg.minutes), cfg)).sort((a, b) => b.endingBalance - a.endingBalance);
      const best = results[0];
      return { ...asset, candles: raw.length, buyHoldEnding: hold, buyHoldReturnPct: (hold / START - 1) * 100, best, excessVsHold: best.endingBalance - hold };
    });
    const valid = assets.filter(a => !a.error).sort((a, b) => b.best.endingBalance - a.best.endingBalance);
    const positive = valid.filter(a => a.best.endingBalance > START);
    const beatHold = valid.filter(a => a.best.endingBalance > a.buyHoldEnding);
    return Response.json({
      startBalance: START,
      feeRate: FEE,
      slippageRate: SLIPPAGE,
      days: 30,
      marketsAttempted: universe.length,
      marketsTested: valid.length,
      strategyConfigs: configs.length,
      positiveCount: positive.length,
      beatHoldCount: beatHold.length,
      best: valid[0] || null,
      results: valid,
      errors: assets.filter(a => a.error)
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502 });
  }
}

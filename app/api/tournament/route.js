export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const START = 100;
const FEE = 0.006;
const DAY = 86400;
const WINDOW = 280 * 60;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWindow(start, end, attempt = 0) {
  const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (res.status === 429 && attempt < 5) {
    const retry = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 900 * (attempt + 1));
    return fetchWindow(start, end, attempt + 1);
  }
  if (!res.ok) throw new Error(`Coinbase history ${res.status}`);
  const rows = await res.json();
  return rows.map(([time, low, high, open, close, volume]) => ({ time:+time, low:+low, high:+high, open:+open, close:+close, volume:+volume }));
}

async function fetchSevenDays() {
  const end = Math.floor(Date.now() / 60000) * 60;
  const start = end - 7 * DAY;
  const all = [];
  for (let cursor = start; cursor < end; cursor += WINDOW) {
    const rows = await fetchWindow(cursor, Math.min(cursor + WINDOW, end));
    all.push(...rows);
    await sleep(350);
  }
  const map = new Map();
  all.forEach(c => map.set(c.time, c));
  return [...map.values()].filter(c => c.time >= start && c.time < end).sort((a,b) => a.time - b.time);
}

function aggregate(candles, minutes) {
  if (minutes === 1) return candles;
  const size = minutes * 60;
  const groups = new Map();
  for (const c of candles) {
    const key = Math.floor(c.time / size) * size;
    const g = groups.get(key);
    if (!g) groups.set(key, { time:key, open:c.open, high:c.high, low:c.low, close:c.close, volume:c.volume });
    else {
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
      g.volume += c.volume;
    }
  }
  return [...groups.values()].sort((a,b) => a.time - b.time);
}

function nextEma(prev, value, period) {
  const k = 2 / (period + 1);
  return value * k + prev * (1 - k);
}

function simulate(raw, cfg) {
  const candles = aggregate(raw, cfg.minutes);
  let cash = START, btc = 0, position = 'USD', entry = 0, entryCapital = 0;
  let fast = candles[0].close, slow = candles[0].close, prevFast = fast, prevSlow = slow;
  let fees = 0, wins = 0, losses = 0, trades = 0, barsHeld = 0, cooldown = 0;
  let peak = START, maxDrawdown = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    prevFast = fast; prevSlow = slow;
    fast = nextEma(fast, c.close, cfg.fast);
    slow = nextEma(slow, c.close, cfg.slow);
    if (cooldown > 0) cooldown--;
    if (position === 'BTC') barsHeld++;
    if (i >= cfg.slow) {
      const spread = Math.abs(fast - slow) / c.close;
      const upCross = fast > slow && prevFast <= prevSlow;
      const downCross = fast < slow && prevFast >= prevSlow;
      const trendUp = fast > slow && spread >= cfg.confirm;
      const trendDown = fast < slow && spread >= cfg.confirm;
      const breakoutLookback = cfg.breakout || 0;
      let breakoutOk = true;
      if (breakoutLookback > 0 && i > breakoutLookback) {
        const priorHigh = Math.max(...candles.slice(i - breakoutLookback, i).map(x => x.high));
        breakoutOk = c.close >= priorHigh;
      }
      const enter = cooldown === 0 && ((cfg.mode === 'trend' ? trendUp : upCross && spread >= cfg.confirm) && breakoutOk);
      if (position === 'USD' && enter) {
        entryCapital = cash;
        const fee = cash * FEE;
        btc = (cash - fee) / c.close;
        fees += fee; cash = 0; entry = c.close; position = 'BTC'; trades++; barsHeld = 0;
      } else if (position === 'BTC') {
        const returnPct = c.close / entry - 1;
        const stop = cfg.stop && returnPct <= -cfg.stop;
        const profitGuard = !cfg.minProfit || returnPct >= cfg.minProfit || stop;
        const exitSignal = cfg.mode === 'trend' ? trendDown : downCross;
        if (barsHeld >= cfg.minHold && profitGuard && (exitSignal || stop)) {
          const gross = btc * c.close;
          const fee = gross * FEE;
          cash = gross - fee; fees += fee; btc = 0; trades++;
          if (cash > entryCapital) wins++; else losses++;
          position = 'USD'; cooldown = cfg.cooldown; entry = 0; entryCapital = 0; barsHeld = 0;
        }
      }
    }
    const equity = cash + btc * c.close;
    if (equity > peak) peak = equity;
    const dd = peak ? (peak - equity) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const last = candles[candles.length - 1].close;
  const ending = cash + btc * last;
  const cycles = wins + losses;
  return {
    name: cfg.name,
    detail: cfg.detail,
    minutes: cfg.minutes,
    endingBalance: ending,
    returnPct: (ending / START - 1) * 100,
    fees,
    trades,
    cycles,
    wins,
    losses,
    winRate: cycles ? wins / cycles * 100 : 0,
    maxDrawdown: maxDrawdown * 100,
    finalPosition: position
  };
}

export async function GET() {
  try {
    const raw = await fetchSevenDays();
    if (raw.length < 1000) throw new Error('Not enough history returned');
    const configs = [
      { name:'1m Filtered', detail:'EMA 7/18, confirmation and cooldown', minutes:1, fast:7, slow:18, confirm:0.0008, minHold:5, cooldown:5 },
      { name:'3m Balanced', detail:'EMA 5/13 with fewer signals', minutes:3, fast:5, slow:13, confirm:0.0010, minHold:3, cooldown:2 },
      { name:'5m Balanced', detail:'EMA 5/15, stronger confirmation', minutes:5, fast:5, slow:15, confirm:0.0012, minHold:2, cooldown:2 },
      { name:'5m Profit Guard', detail:'Waits for a meaningful move or a 2% stop', minutes:5, fast:6, slow:18, confirm:0.0010, minHold:2, cooldown:2, minProfit:0.014, stop:0.02 },
      { name:'15m Trend Rider', detail:'Slow trend filter to avoid one minute noise', minutes:15, fast:5, slow:15, confirm:0.0015, minHold:1, cooldown:1, mode:'trend' },
      { name:'15m Breakout', detail:'Trend plus a six bar breakout confirmation', minutes:15, fast:5, slow:18, confirm:0.0012, minHold:1, cooldown:1, mode:'trend', breakout:6 }
    ];
    const first = raw[0].close;
    const last = raw[raw.length - 1].close;
    const buyHoldEnding = START * last / first;
    const strategies = configs.map(cfg => simulate(raw, cfg)).sort((a,b) => b.endingBalance - a.endingBalance);
    return Response.json({
      startBalance: START,
      feeRate: FEE,
      candles: raw.length,
      firstPrice: first,
      lastPrice: last,
      buyHoldEnding,
      buyHoldReturnPct: (buyHoldEnding / START - 1) * 100,
      strategies
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502 });
  }
}

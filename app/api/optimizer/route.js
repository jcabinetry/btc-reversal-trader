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
  if (res.status === 429 && attempt < 6) {
    const retry = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 1000 * (attempt + 1));
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
  const size = minutes * 60;
  const groups = new Map();
  for (const c of candles) {
    const key = Math.floor(c.time / size) * size;
    const g = groups.get(key);
    if (!g) groups.set(key, { time:key, open:c.open, high:c.high, low:c.low, close:c.close });
    else {
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
    }
  }
  return [...groups.values()].sort((a,b) => a.time - b.time);
}

function emaNext(prev, value, period) {
  const k = 2 / (period + 1);
  return value * k + prev * (1 - k);
}

function simulate(candles, cfg) {
  if (candles.length < cfg.slow + 2) return null;
  let cash = START, btc = 0, position = 'USD', entry = 0, entryCapital = 0;
  let fast = candles[0].close, slow = candles[0].close, prevFast = fast, prevSlow = slow;
  let fees = 0, trades = 0, wins = 0, losses = 0, barsHeld = 0, cooldown = 0;
  let peak = START, maxDrawdown = 0, highestSinceEntry = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    prevFast = fast;
    prevSlow = slow;
    fast = emaNext(fast, c.close, cfg.fast);
    slow = emaNext(slow, c.close, cfg.slow);
    if (cooldown > 0) cooldown--;
    if (position === 'BTC') {
      barsHeld++;
      highestSinceEntry = Math.max(highestSinceEntry, c.high);
    }

    if (i >= cfg.slow) {
      const spread = Math.abs(fast - slow) / c.close;
      const upCross = fast > slow && prevFast <= prevSlow && spread >= cfg.confirm;
      const downCross = fast < slow && prevFast >= prevSlow;

      if (position === 'USD' && cooldown === 0 && upCross) {
        entryCapital = cash;
        const fee = cash * FEE;
        btc = (cash - fee) / c.close;
        fees += fee;
        cash = 0;
        entry = c.close;
        highestSinceEntry = c.high;
        position = 'BTC';
        trades++;
        barsHeld = 0;
      } else if (position === 'BTC') {
        const returnPct = c.close / entry - 1;
        const trailHit = cfg.trail > 0 && highestSinceEntry > 0 && c.close / highestSinceEntry - 1 <= -cfg.trail;
        const stopHit = cfg.stop > 0 && returnPct <= -cfg.stop;
        const profitReady = returnPct >= cfg.minProfit;
        const exitSignal = downCross && (profitReady || stopHit || trailHit);
        if (barsHeld >= cfg.minHold && (exitSignal || stopHit || trailHit)) {
          const gross = btc * c.close;
          const fee = gross * FEE;
          cash = gross - fee;
          fees += fee;
          btc = 0;
          trades++;
          if (cash > entryCapital) wins++; else losses++;
          position = 'USD';
          cooldown = cfg.cooldown;
          entry = 0;
          entryCapital = 0;
          highestSinceEntry = 0;
          barsHeld = 0;
        }
      }
    }

    const equity = cash + btc * c.close;
    if (equity > peak) peak = equity;
    const dd = peak ? (peak - equity) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const last = candles[candles.length - 1].close;
  const endingBalance = cash + btc * last;
  const cycles = wins + losses;
  return {
    minutes: cfg.minutes,
    fast: cfg.fast,
    slow: cfg.slow,
    confirm: cfg.confirm,
    minHold: cfg.minHold,
    cooldown: cfg.cooldown,
    minProfit: cfg.minProfit,
    stop: cfg.stop,
    trail: cfg.trail,
    endingBalance,
    returnPct: (endingBalance / START - 1) * 100,
    fees,
    trades,
    cycles,
    winRate: cycles ? wins / cycles * 100 : 0,
    maxDrawdown: maxDrawdown * 100,
    finalPosition: position
  };
}

export async function GET() {
  try {
    const raw = await fetchSevenDays();
    if (raw.length < 1000) throw new Error('Not enough history returned');

    const minuteOptions = [3, 5, 10, 15, 30];
    const fastOptions = [3, 5, 7, 9];
    const slowOptions = [12, 18, 24, 36];
    const confirmOptions = [0.0005, 0.0010, 0.0015];
    const minProfitOptions = [0, 0.006, 0.012];
    const trailOptions = [0, 0.008, 0.015];
    const stop = 0.025;
    const aggregates = new Map(minuteOptions.map(m => [m, aggregate(raw, m)]));
    const results = [];

    for (const minutes of minuteOptions) {
      const candles = aggregates.get(minutes);
      for (const fast of fastOptions) {
        for (const slow of slowOptions) {
          if (fast >= slow) continue;
          for (const confirm of confirmOptions) {
            for (const minProfit of minProfitOptions) {
              for (const trail of trailOptions) {
                const cfg = { minutes, fast, slow, confirm, minHold:2, cooldown:2, minProfit, stop, trail };
                const r = simulate(candles, cfg);
                if (r) results.push(r);
              }
            }
          }
        }
      }
    }

    results.sort((a,b) => b.endingBalance - a.endingBalance || a.maxDrawdown - b.maxDrawdown);
    const first = raw[0].close;
    const last = raw[raw.length - 1].close;
    const buyHoldEnding = START * last / first;
    const top = results.slice(0, 20);
    const beatHold = results.filter(r => r.endingBalance > buyHoldEnding).length;

    return Response.json({
      startBalance: START,
      feeRate: FEE,
      candles: raw.length,
      combinations: results.length,
      buyHoldEnding,
      buyHoldReturnPct: (buyHoldEnding / START - 1) * 100,
      beatHold,
      best: top[0],
      top
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502 });
  }
}

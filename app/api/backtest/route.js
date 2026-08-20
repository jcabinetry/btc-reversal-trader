export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const START_BALANCE = 100;
const FEE_RATE = 0.006;
const FAST_PERIOD = 7;
const SLOW_PERIOD = 18;
const WINDOW_SECONDS = 300 * 60;
const DAY_SECONDS = 24 * 60 * 60;

function emaNext(previous, value, period) {
  const k = 2 / (period + 1);
  return value * k + previous * (1 - k);
}

async function fetchWindow(start, end) {
  const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`Coinbase history ${res.status}`);
  const rows = await res.json();
  return rows.map(([time, low, high, open, close, volume]) => ({
    time: Number(time),
    low: Number(low),
    high: Number(high),
    open: Number(open),
    close: Number(close),
    volume: Number(volume)
  }));
}

async function fetchSevenDays() {
  const end = Math.floor(Date.now() / 60000) * 60;
  const start = end - 7 * DAY_SECONDS;
  const windows = [];
  for (let cursor = start; cursor < end; cursor += WINDOW_SECONDS) {
    windows.push([cursor, Math.min(cursor + WINDOW_SECONDS, end)]);
  }

  const all = [];
  for (let i = 0; i < windows.length; i += 5) {
    const batch = windows.slice(i, i + 5);
    const results = await Promise.all(batch.map(([s, e]) => fetchWindow(s, e)));
    results.forEach(rows => all.push(...rows));
  }

  const byTime = new Map();
  all.forEach(c => byTime.set(c.time, c));
  return [...byTime.values()]
    .filter(c => c.time >= start && c.time < end)
    .sort((a, b) => a.time - b.time);
}

function runBacktest(candles) {
  if (candles.length < SLOW_PERIOD + 2) throw new Error('Not enough candle history');

  let cash = START_BALANCE;
  let btc = 0;
  let position = 'USD';
  let entry = null;
  let capitalAtEntry = null;
  let fees = 0;
  let wins = 0;
  let losses = 0;
  let fast = candles[0].close;
  let slow = candles[0].close;
  let previousFast = fast;
  let previousSlow = slow;
  let peakEquity = START_BALANCE;
  let maxDrawdown = 0;
  const trades = [];

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    previousFast = fast;
    previousSlow = slow;
    fast = emaNext(fast, candle.close, FAST_PERIOD);
    slow = emaNext(slow, candle.close, SLOW_PERIOD);

    if (i >= SLOW_PERIOD) {
      const upCross = fast > slow && previousFast <= previousSlow;
      const downCross = fast < slow && previousFast >= previousSlow;

      if (position === 'USD' && upCross && cash > 0) {
        capitalAtEntry = cash;
        const fee = cash * FEE_RATE;
        const spendable = cash - fee;
        btc = spendable / candle.close;
        cash = 0;
        entry = candle.close;
        fees += fee;
        position = 'BTC';
        trades.push({ side: 'BUY', time: candle.time, price: candle.close, fee, balance: capitalAtEntry });
      } else if (position === 'BTC' && downCross && btc > 0) {
        const gross = btc * candle.close;
        const fee = gross * FEE_RATE;
        cash = gross - fee;
        btc = 0;
        fees += fee;
        const netWin = capitalAtEntry != null && cash > capitalAtEntry;
        if (netWin) wins += 1; else losses += 1;
        trades.push({ side: 'SELL', time: candle.time, price: candle.close, fee, balance: cash, cycleReturn: capitalAtEntry ? ((cash / capitalAtEntry) - 1) * 100 : 0 });
        position = 'USD';
        entry = null;
        capitalAtEntry = null;
      }
    }

    const equity = cash + btc * candle.close;
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  const endingBalance = cash + btc * last;
  const buyHoldEnding = START_BALANCE * (last / first);
  const closedCycles = wins + losses;

  return {
    startBalance: START_BALANCE,
    endingBalance,
    profit: endingBalance - START_BALANCE,
    returnPct: ((endingBalance / START_BALANCE) - 1) * 100,
    buyHoldEnding,
    buyHoldReturnPct: ((buyHoldEnding / START_BALANCE) - 1) * 100,
    differenceVsHold: endingBalance - buyHoldEnding,
    fees,
    trades: trades.length,
    closedCycles,
    wins,
    losses,
    winRate: closedCycles ? (wins / closedCycles) * 100 : 0,
    maxDrawdown,
    position,
    entry,
    firstPrice: first,
    lastPrice: last,
    candles: candles.length,
    startTime: candles[0].time,
    endTime: candles[candles.length - 1].time,
    recentTrades: trades.slice(-30).reverse()
  };
}

export async function GET() {
  try {
    const candles = await fetchSevenDays();
    const results = runBacktest(candles);
    return Response.json(results);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502 });
  }
}

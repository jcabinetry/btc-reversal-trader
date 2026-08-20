'use client';

import { useEffect, useRef, useState } from 'react';

const START = 100;
const FEE = 0.006;
const STORAGE_KEY = 'btc-reversal-paper-v2';

function ema(values, n) {
  if (!values.length) return 0;
  const k = 2 / (n + 1);
  return values.slice(1).reduce((v, x) => x * k + v * (1 - k), values[0]);
}

function initialAccount() {
  return { cash: START, btc: 0, position: 'USD', entry: null, fees: 0, wins: 0, losses: 0, trades: [] };
}

export default function Home() {
  const [price, setPrice] = useState(null);
  const [status, setStatus] = useState('CONNECTING');
  const [signal, setSignal] = useState('WAIT IN USD');
  const [reason, setReason] = useState('Loading one minute BTC history');
  const [candles, setCandles] = useState([]);
  const [fast, setFast] = useState(null);
  const [slow, setSlow] = useState(null);
  const [account, setAccount] = useState(initialAccount());
  const [backtest, setBacktest] = useState(null);
  const [backtestStatus, setBacktestStatus] = useState('idle');
  const [backtestError, setBacktestError] = useState('');
  const accountRef = useRef(account);
  const lastCandleRef = useRef(null);
  const loadedRef = useRef(false);

  const saveAccount = next => {
    accountRef.current = next;
    setAccount(next);
    if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        accountRef.current = { ...initialAccount(), ...parsed };
        setAccount(accountRef.current);
      }
    } catch {}
    loadedRef.current = true;
  }, []);

  useEffect(() => {
    let timer;

    const load = async () => {
      try {
        const r = await fetch('/api/candles', { cache: 'no-store' });
        const d = await r.json();
        if (!d.price || !Array.isArray(d.candles)) throw new Error('No market data');

        const list = d.candles;
        const p = Number(d.price);
        setPrice(p);
        setCandles(list.slice(-60));
        setStatus('LIVE PAPER MODE');

        if (list.length < 24) {
          setReason(`Waiting for candle history ${list.length}/24`);
          return;
        }

        const closes = list.map(c => c.close);
        const currentFast = ema(closes.slice(-24), 7);
        const currentSlow = ema(closes.slice(-24), 18);
        const previousFast = ema(closes.slice(-25, -1), 7);
        const previousSlow = ema(closes.slice(-25, -1), 18);
        setFast(currentFast);
        setSlow(currentSlow);

        const newest = list[list.length - 1];
        const upCross = currentFast > currentSlow && previousFast <= previousSlow;
        const downCross = currentFast < currentSlow && previousFast >= previousSlow;
        const trend = currentFast > currentSlow ? 'UP' : 'DOWN';

        if (lastCandleRef.current === newest.time) {
          setSignal(accountRef.current.position === 'BTC' ? 'HOLD BTC' : 'WAIT IN USD');
          setReason(`Trend ${trend}. Waiting for the next completed one minute candle.`);
          return;
        }
        lastCandleRef.current = newest.time;

        if (!loadedRef.current) return;

        const a = accountRef.current;
        if (a.position === 'USD' && upCross && a.cash > 0) {
          const fee = a.cash * FEE;
          const spendable = a.cash - fee;
          const qty = spendable / newest.close;
          const trade = {
            side: 'BUY',
            price: newest.close,
            value: a.cash,
            fee,
            time: new Date(newest.time * 1000).toLocaleString(),
            reason: 'Fast EMA crossed above slow EMA on a completed one minute candle'
          };
          saveAccount({
            ...a,
            cash: 0,
            btc: qty,
            position: 'BTC',
            entry: newest.close,
            fees: a.fees + fee,
            trades: [trade, ...a.trades].slice(0, 50)
          });
          setSignal('BUY BTC');
          setReason(trade.reason);
        } else if (a.position === 'BTC' && downCross && a.btc > 0) {
          const gross = a.btc * newest.close;
          const fee = gross * FEE;
          const proceeds = gross - fee;
          const won = a.entry && newest.close > a.entry;
          const trade = {
            side: 'SELL',
            price: newest.close,
            value: proceeds,
            fee,
            time: new Date(newest.time * 1000).toLocaleString(),
            reason: 'Fast EMA crossed below slow EMA on a completed one minute candle'
          };
          saveAccount({
            ...a,
            cash: proceeds,
            btc: 0,
            position: 'USD',
            entry: null,
            fees: a.fees + fee,
            wins: a.wins + (won ? 1 : 0),
            losses: a.losses + (won ? 0 : 1),
            trades: [trade, ...a.trades].slice(0, 50)
          });
          setSignal('SELL BTC');
          setReason(trade.reason);
        } else {
          setSignal(a.position === 'BTC' ? 'HOLD BTC' : 'WAIT IN USD');
          setReason(`Trend ${trend}. No confirmed EMA reversal on the newest candle.`);
        }
      } catch {
        setStatus('RECONNECTING');
        setReason('Market feed temporarily unavailable');
      }
    };

    load();
    timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, []);

  const runBacktest = async () => {
    setBacktestStatus('loading');
    setBacktestError('');
    try {
      const r = await fetch('/api/backtest', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || 'Backtest failed');
      setBacktest(d);
      setBacktestStatus('done');
    } catch (error) {
      setBacktestStatus('error');
      setBacktestError(error.message || 'Backtest failed');
    }
  };

  const equity = account.cash + account.btc * (price || 0);
  const pnl = equity - START;
  const pnlPct = (pnl / START) * 100;
  const closedTrades = account.wins + account.losses;

  const reset = () => {
    if (!confirm('Reset the paper account back to $100?')) return;
    localStorage.removeItem(STORAGE_KEY);
    saveAccount(initialAccount());
    setSignal('WAIT IN USD');
    setReason('Paper account reset. Watching for the next reversal.');
  };

  return <main>
    <header>
      <div><span className="eyebrow">PAPER TRADING LAB</span><h1>BTC Reversal Trader</h1><p>One minute candles with live paper trading and historical testing.</p></div>
      <div className="live"><i />{status}</div>
    </header>

    <section className="hero">
      <div><span>BTC / USD</span><strong>{price ? `$${price.toLocaleString(undefined,{maximumFractionDigits:2})}` : 'Loading...'}</strong><small>Current Coinbase market price</small></div>
      <div className="signal"><span>CURRENT SIGNAL</span><strong>{signal}</strong><small>{reason}</small></div>
    </section>

    <section className="grid">
      <Card label="PAPER ACCOUNT" value={`$${equity.toFixed(2)}`} sub="Started with $100.00" />
      <Card label="PROFIT / LOSS" value={`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`} sub={`${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`} good={pnl >= 0} />
      <Card label="CASH" value={`$${account.cash.toFixed(2)}`} sub="Available USD" />
      <Card label="BTC HELD" value={account.btc.toFixed(8)} sub={account.entry ? `Entry $${account.entry.toLocaleString()}` : 'No open position'} />
    </section>

    <section className="panel">
      <div className="panelHead"><div><span className="eyebrow">ONE MINUTE ENGINE</span><h2>Reversal indicators</h2></div><span className="pill">{candles.length} recent candles</span></div>
      <div className="indicatorGrid">
        <Metric label="FAST EMA 7" value={fast ? `$${fast.toFixed(2)}` : 'Loading'} />
        <Metric label="SLOW EMA 18" value={slow ? `$${slow.toFixed(2)}` : 'Loading'} />
        <Metric label="POSITION" value={account.position} />
        <Metric label="FEES PAID" value={`$${account.fees.toFixed(2)}`} />
        <Metric label="CLOSED CYCLES" value={String(closedTrades)} />
        <Metric label="WINS / LOSSES" value={`${account.wins} / ${account.losses}`} />
      </div>
      <MiniChart candles={candles} />
    </section>

    <section className="panel backtestPanel">
      <div className="panelHead">
        <div><span className="eyebrow">HISTORICAL TEST</span><h2>Last 7 days with $100</h2></div>
        <button onClick={runBacktest} disabled={backtestStatus === 'loading'}>{backtestStatus === 'loading' ? 'Running test...' : backtest ? 'Run again' : 'Run 7 day backtest'}</button>
      </div>
      <p className="panelCopy">Uses the same 1 minute EMA 7 and EMA 18 reversal logic and the same simulated fee rate as the live paper trader.</p>
      {backtestStatus === 'idle' && <div className="empty">Press the button to replay the previous seven days of BTC one minute candles.</div>}
      {backtestStatus === 'loading' && <div className="empty">Downloading and replaying roughly ten thousand one minute BTC candles. This can take a little while.</div>}
      {backtestStatus === 'error' && <div className="empty errorText">Backtest could not finish: {backtestError}</div>}
      {backtest && <>
        <div className="backtestGrid">
          <Metric label="START" value={`$${backtest.startBalance.toFixed(2)}`} />
          <Metric label="BOT ENDING" value={`$${backtest.endingBalance.toFixed(2)}`} />
          <Metric label="BOT RETURN" value={`${backtest.returnPct >= 0 ? '+' : ''}${backtest.returnPct.toFixed(2)}%`} />
          <Metric label="BUY AND HOLD" value={`$${backtest.buyHoldEnding.toFixed(2)}`} />
          <Metric label="VS HOLD" value={`${backtest.differenceVsHold >= 0 ? '+' : ''}$${backtest.differenceVsHold.toFixed(2)}`} />
          <Metric label="FEES" value={`$${backtest.fees.toFixed(2)}`} />
          <Metric label="TRADES" value={String(backtest.trades)} />
          <Metric label="CYCLES" value={String(backtest.closedCycles)} />
          <Metric label="WIN RATE" value={`${backtest.winRate.toFixed(1)}%`} />
          <Metric label="MAX DRAWDOWN" value={`${backtest.maxDrawdown.toFixed(2)}%`} />
        </div>
        <div className="backtestSummary">
          <strong>{backtest.endingBalance > backtest.buyHoldEnding ? 'The reversal bot beat buy and hold for this seven day window.' : 'Buy and hold beat the reversal bot for this seven day window.'}</strong>
          <span>{backtest.candles.toLocaleString()} one minute candles tested. BTC moved from ${backtest.firstPrice.toLocaleString(undefined,{maximumFractionDigits:2})} to ${backtest.lastPrice.toLocaleString(undefined,{maximumFractionDigits:2})}.</span>
        </div>
        {backtest.recentTrades?.length > 0 && <div className="trades backtestTrades">{backtest.recentTrades.slice(0,12).map((t,i)=><div className="trade" key={`${t.time}-${i}`}><b className={t.side === 'BUY' ? 'buy' : 'sell'}>{t.side}</b><span>${t.price.toLocaleString(undefined,{maximumFractionDigits:2})}</span><span>{new Date(t.time * 1000).toLocaleString()}</span><time>{t.side === 'SELL' && typeof t.cycleReturn === 'number' ? `${t.cycleReturn >= 0 ? '+' : ''}${t.cycleReturn.toFixed(2)}% cycle` : `$${t.fee.toFixed(2)} fee`}</time></div>)}</div>}
      </>}
    </section>

    <section className="panel">
      <div className="panelHead"><div><span className="eyebrow">AUTOMATED LOG</span><h2>Recent paper trades</h2></div><button onClick={reset}>Reset $100 account</button></div>
      {account.trades.length === 0 ? <div className="empty">The bot already has recent candle history and is watching completed one minute candles for the first confirmed reversal.</div> : <div className="trades">{account.trades.map((t,i)=><div className="trade tradeWide" key={i}><b className={t.side==='BUY'?'buy':'sell'}>{t.side}</b><span>${t.price.toLocaleString()}</span><span>${t.value.toFixed(2)}</span><span className="why">{t.reason}</span><time>{t.time}</time></div>)}</div>}
    </section>

    <footer>Experimental paper trader only. Results are simulations and do not guarantee future returns.</footer>
  </main>;
}

function Card({label,value,sub,good}) { return <div className="card"><span>{label}</span><strong className={good ? 'positive' : ''}>{value}</strong><small>{sub}</small></div>; }
function Metric({label,value}) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }
function MiniChart({ candles }) {
  if (candles.length < 2) return <div className="chartEmpty">Loading candle chart</div>;
  const closes = candles.map(c => c.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const points = closes.map((v,i) => `${(i/(closes.length-1))*100},${95-((v-min)/range)*90}`).join(' ');
  return <div className="chartWrap"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.4" vectorEffect="non-scaling-stroke" /></svg><small>Last {candles.length} completed one minute closes</small></div>;
}

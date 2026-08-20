'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const START = 100;
const FEE = 0.006;

function ema(values, n) {
  if (!values.length) return 0;
  const k = 2 / (n + 1);
  return values.slice(1).reduce((v, x) => x * k + v * (1 - k), values[0]);
}

export default function Home() {
  const [price, setPrice] = useState(null);
  const [status, setStatus] = useState('CONNECTING');
  const [cash, setCash] = useState(START);
  const [btc, setBtc] = useState(0);
  const [signal, setSignal] = useState('WAIT IN USD');
  const [trades, setTrades] = useState([]);
  const prices = useRef([]);
  const position = useRef('USD');
  const entry = useRef(null);
  const lastTrade = useRef(0);

  useEffect(() => {
    let timer;
    const load = async () => {
      try {
        const r = await fetch('/api/price', { cache: 'no-store' });
        const d = await r.json();
        if (!d.price) throw new Error('No price');
        const p = Number(d.price);
        setPrice(p);
        setStatus('LIVE PAPER MODE');
        prices.current = [...prices.current.slice(-59), p];
        if (prices.current.length < 24 || Date.now() - lastTrade.current < 60000) return;
        const fast = ema(prices.current.slice(-12), 7);
        const slow = ema(prices.current.slice(-24), 18);
        const prevFast = ema(prices.current.slice(-13, -1), 7);
        const prevSlow = ema(prices.current.slice(-25, -1), 18);
        const up = fast > slow && prevFast <= prevSlow;
        const down = fast < slow && prevFast >= prevSlow;
        if (position.current === 'USD' && up) {
          setCash(c => {
            const afterFee = c * (1 - FEE);
            const qty = afterFee / p;
            setBtc(qty);
            position.current = 'BTC';
            entry.current = p;
            lastTrade.current = Date.now();
            setSignal('HOLD BTC');
            setTrades(t => [{ side: 'BUY', price: p, time: new Date().toLocaleTimeString(), value: c }, ...t].slice(0, 20));
            return 0;
          });
        } else if (position.current === 'BTC' && down) {
          setBtc(q => {
            const proceeds = q * p * (1 - FEE);
            setCash(proceeds);
            position.current = 'USD';
            lastTrade.current = Date.now();
            setSignal('WAIT IN USD');
            setTrades(t => [{ side: 'SELL', price: p, time: new Date().toLocaleTimeString(), value: proceeds }, ...t].slice(0, 20));
            return 0;
          });
        } else setSignal(position.current === 'BTC' ? 'HOLD BTC' : 'WAIT IN USD');
      } catch { setStatus('RECONNECTING'); }
    };
    load();
    timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  const equity = cash + btc * (price || 0);
  const pnl = equity - START;
  const pnlPct = (pnl / START) * 100;
  const positionLabel = btc > 0 ? 'BTC' : 'USD';

  return <main>
    <header><div><span className="eyebrow">PAPER TRADING LAB</span><h1>BTC Reversal Trader</h1><p>Follow upward momentum. Step aside when momentum reverses.</p></div><div className="live"><i />{status}</div></header>
    <section className="hero">
      <div><span>BTC / USD</span><strong>{price ? `$${price.toLocaleString(undefined,{maximumFractionDigits:2})}` : 'Loading...'}</strong><small>Coinbase market price</small></div>
      <div className="signal"><span>CURRENT SIGNAL</span><strong>{signal}</strong><small>Position: {positionLabel}</small></div>
    </section>
    <section className="grid">
      <Card label="PAPER ACCOUNT" value={`$${equity.toFixed(2)}`} sub="Started with $100.00" />
      <Card label="PROFIT / LOSS" value={`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`} sub={`${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`} good={pnl >= 0} />
      <Card label="CASH" value={`$${cash.toFixed(2)}`} sub="Available USD" />
      <Card label="BTC HELD" value={btc.toFixed(8)} sub={entry.current ? `Entry $${entry.current.toLocaleString()}` : 'No open position'} />
    </section>
    <section className="panel"><div className="panelHead"><div><span className="eyebrow">AUTOMATED LOG</span><h2>Recent paper trades</h2></div><span className="pill">No real money</span></div>
      {trades.length === 0 ? <div className="empty">Watching BTC for the first confirmed reversal. The bot will log simulated trades here.</div> : <div className="trades">{trades.map((t,i)=><div className="trade" key={i}><b className={t.side==='BUY'?'buy':'sell'}>{t.side}</b><span>${t.price.toLocaleString()}</span><span>${t.value.toFixed(2)} account</span><time>{t.time}</time></div>)}</div>}
    </section>
    <footer>Experimental paper trader. Results are simulations and do not guarantee future returns.</footer>
  </main>;
}

function Card({label,value,sub,good}) { return <div className="card"><span>{label}</span><strong className={good ? 'positive' : ''}>{value}</strong><small>{sub}</small></div>; }

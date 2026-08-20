'use client';

import { useState } from 'react';

export default function OptimizerPage() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  const run = async () => {
    setStatus('loading');
    setError('');
    try {
      const r = await fetch('/api/optimizer', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || 'Optimizer failed');
      setData(d);
      setStatus('done');
    } catch (e) {
      setStatus('error');
      setError(e.message || 'Optimizer failed');
    }
  };

  return <main>
    <header>
      <div>
        <span className="eyebrow">STRATEGY OPTIMIZER</span>
        <h1>BTC Strategy Optimizer</h1>
        <p>Search hundreds of strategy combinations across the same seven day BTC history.</p>
      </div>
      <a className="live" href="/">Back to trader</a>
    </header>

    <section className="panel" style={{marginTop:32}}>
      <div className="panelHead">
        <div>
          <span className="eyebrow">IN SAMPLE SEARCH</span>
          <h2>Find the strongest settings</h2>
        </div>
        <button onClick={run} disabled={status === 'loading'}>{status === 'loading' ? 'Testing combinations...' : data ? 'Run optimizer again' : 'Run optimizer'}</button>
      </div>
      <p className="panelCopy">Every test starts with $100 and pays the same simulated 0.6% fee on every transaction. The optimizer varies candle length, EMA speeds, confirmation strength, minimum profit and trailing exit behavior.</p>

      {status === 'idle' && <div className="empty">Press Run optimizer to test hundreds of combinations against the same week of BTC data.</div>}
      {status === 'loading' && <div className="empty">Downloading seven days of BTC history once and testing hundreds of combinations. This may take a little while.</div>}
      {status === 'error' && <div className="empty errorText">Optimizer could not finish: {error}</div>}

      {data && <>
        <div className="benchmarkRow">
          <Metric label="COMBINATIONS" value={data.combinations.toLocaleString()} />
          <Metric label="BUY AND HOLD" value={`$${data.buyHoldEnding.toFixed(2)}`} />
          <Metric label="BEAT HOLD" value={data.beatHold.toLocaleString()} />
        </div>

        <div className="backtestSummary">
          <strong>Best result: ${data.best.endingBalance.toFixed(2)} from $100</strong>
          <span>{describe(data.best)} This is the best result on this specific seven day sample only.</span>
        </div>

        <div className="rankList">
          {data.top.map((s, i) => <div className={`rankRow ${s.endingBalance > data.buyHoldEnding ? 'beatHold' : ''}`} key={`${s.minutes}-${s.fast}-${s.slow}-${s.confirm}-${s.minProfit}-${s.trail}-${i}`}>
            <div className="rankNum">#{i + 1}</div>
            <div className="rankName"><strong>{s.minutes} minute EMA {s.fast}/{s.slow}</strong><span>{describe(s)}</span></div>
            <RankMetric label="ENDING" value={`$${s.endingBalance.toFixed(2)}`} />
            <RankMetric label="RETURN" value={`${s.returnPct >= 0 ? '+' : ''}${s.returnPct.toFixed(2)}%`} />
            <RankMetric label="TRADES" value={String(s.trades)} />
            <RankMetric label="FEES" value={`$${s.fees.toFixed(2)}`} />
            <RankMetric label="WIN RATE" value={`${s.winRate.toFixed(1)}%`} />
            <RankMetric label="DRAWDOWN" value={`${s.maxDrawdown.toFixed(1)}%`} />
            <div className="holdBadge">{s.endingBalance > data.buyHoldEnding ? 'BEAT HOLD' : 'BELOW HOLD'}</div>
          </div>)}
        </div>

        <div className="backtestSummary">
          <strong>Important next step</strong>
          <span>The winning settings are not trusted yet. They need to be tested on different dates and longer periods to see whether the result survives outside the week used to optimize them.</span>
        </div>
      </>}
    </section>
  </main>;
}

function Metric({label,value}) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }
function RankMetric({label,value}) { return <div className="rankMetric"><span>{label}</span><strong>{value}</strong></div>; }
function pct(v) { return `${(v * 100).toFixed(2)}%`; }
function describe(s) {
  return `Confirm ${pct(s.confirm)}, min profit ${pct(s.minProfit)}, trail ${pct(s.trail)}, stop ${pct(s.stop)}.`;
}

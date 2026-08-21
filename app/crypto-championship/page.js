'use client';
import {useState} from 'react';

export default function CryptoChampionship(){
  const [data,setData]=useState(null),[status,setStatus]=useState('idle'),[error,setError]=useState('');
  async function run(){
    setStatus('loading');setError('');
    try{
      const r=await fetch('/api/crypto-championship',{cache:'no-store'});
      const text=await r.text();let d;
      try{d=JSON.parse(text);}catch{throw new Error(text?.slice(0,180)||`Server returned ${r.status}`)}
      if(!r.ok||d.error)throw new Error(d.error||'Championship failed');
      setData(d);setStatus('done');
    }catch(e){setError(e.message||'Championship failed');setStatus('error');}
  }
  return <main>
    <header><div><span className="eyebrow">MULTI CRYPTO TEST</span><h1>Crypto Reversal Championship</h1><p>Test the most liquid Binance.US USD markets with the same reversal search and realistic trading costs.</p></div><a className="live" href="/month-test">Historical lab</a></header>
    <section className="panel" style={{marginTop:32}}>
      <div className="panelHead"><div><span className="eyebrow">30 DAY SEARCH</span><h2>Which crypto fits the idea best?</h2></div><button onClick={run} disabled={status==='loading'}>{status==='loading'?'Testing markets...':data?'Run again':'Run crypto championship'}</button></div>
      <p className="panelCopy">The lab selects the most liquid active USD spot markets, tests 18 reversal configurations on each, starts every simulation at $100, charges a 0.02% taker fee plus 0.02% simulated slippage on each trade, and compares every winner with simply holding that same coin.</p>
      {status==='idle'&&<div className="empty">Press Run crypto championship. This can take a little while because it downloads 30 days of history for multiple markets.</div>}
      {status==='loading'&&<div className="empty">Downloading market history and testing hundreds of coin and strategy combinations. No real trades are placed.</div>}
      {status==='error'&&<div className="empty errorText">Championship could not finish: {error}</div>}
      {data&&<>
        <div className="benchmarkRow"><Metric label="MARKETS TESTED" value={`${data.marketsTested}/${data.marketsAttempted}`}/><Metric label="CONFIGS PER COIN" value={String(data.strategyConfigs)}/><Metric label="PROFITABLE COINS" value={String(data.positiveCount)}/><Metric label="BEAT HOLD" value={String(data.beatHoldCount)}/></div>
        {data.best&&<div className="backtestSummary"><strong>Top result: {data.best.symbol} ended at ${data.best.best.endingBalance.toFixed(2)}</strong><span>{describe(data.best.best)} It {data.best.best.endingBalance>data.best.buyHoldEnding?'beat':'did not beat'} buying and holding {data.best.symbol} over the same 30 days.</span></div>}
        <div className="rankList">{data.results.map((a,i)=><div className={`rankRow ${a.best.endingBalance>a.buyHoldEnding?'beatHold':''}`} key={a.symbol}>
          <div className="rankNum">#{i+1}</div>
          <div className="rankName"><strong>{a.symbol}</strong><span>{describe(a.best)}</span></div>
          <RM label="BOT" value={`$${a.best.endingBalance.toFixed(2)}`}/><RM label="RETURN" value={`${a.best.returnPct>=0?'+':''}${a.best.returnPct.toFixed(2)}%`}/><RM label="HOLD" value={`$${a.buyHoldEnding.toFixed(2)}`}/><RM label="TRADES" value={String(a.best.trades)}/><RM label="FEES" value={`$${a.best.fees.toFixed(2)}`}/><RM label="DRAWDOWN" value={`${a.best.maxDrawdown.toFixed(1)}%`}/><div className="holdBadge">{a.best.endingBalance>a.buyHoldEnding?'BEAT HOLD':'BELOW HOLD'}</div>
        </div>)}</div>
        {data.errors?.length>0&&<div className="backtestSummary"><strong>{data.errors.length} markets skipped</strong><span>Some markets did not have enough history or returned an exchange error, so they were excluded rather than guessed.</span></div>}
        <div className="backtestSummary"><strong>Do not trust the winner yet</strong><span>This is a 30 day search across many coins and settings, so the top result can be overfit. Any profitable winner must next survive a frozen 90 day test before we consider live paper trading.</span></div>
      </>}
    </section>
  </main>;
}
function Metric({label,value}){return <div className="metric"><span>{label}</span><strong>{value}</strong></div>}
function RM({label,value}){return <div className="rankMetric"><span>{label}</span><strong>{value}</strong></div>}
function describe(s){return `${s.minutes} minute reversal, lookback ${s.lookback}, confirm ${(s.confirm*100).toFixed(2)}%, minimum profit ${(s.minProfit*100).toFixed(2)}%, stop ${(s.stop*100).toFixed(1)}%.`;}

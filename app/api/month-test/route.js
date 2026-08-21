export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const START = 100;
const FEE = 0.006;
const DAY = 86400;
const GRANULARITY = 300;
const WINDOW = 280 * GRANULARITY;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWindow(start, end, attempt = 0) {
  const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${GRANULARITY}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
  const res = await fetch(url, { headers:{Accept:'application/json'}, cache:'no-store' });
  if (res.status === 429 && attempt < 7) {
    const retry = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 900 * (attempt + 1));
    return fetchWindow(start, end, attempt + 1);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Coinbase history ${res.status}${detail ? `: ${detail.slice(0,120)}` : ''}`);
  }
  const rows = await res.json();
  return rows.map(([time,low,high,open,close,volume]) => ({time:+time,low:+low,high:+high,open:+open,close:+close,volume:+volume}));
}

async function fetchThirtyDays() {
  const end = Math.floor(Date.now()/GRANULARITY)*GRANULARITY;
  const start = end - 30*DAY;
  const all=[];
  for (let cursor=start; cursor<end; cursor+=WINDOW) {
    const requestEnd = Math.min(cursor + WINDOW - GRANULARITY, end - GRANULARITY);
    all.push(...await fetchWindow(cursor, requestEnd));
    await sleep(120);
  }
  const map=new Map(); all.forEach(c=>map.set(c.time,c));
  return [...map.values()].filter(c=>c.time>=start&&c.time<end).sort((a,b)=>a.time-b.time);
}

function aggregate(candles, minutes) {
  const size=minutes*60, groups=new Map();
  for (const c of candles) {
    const key=Math.floor(c.time/size)*size, g=groups.get(key);
    if (!g) groups.set(key,{time:key,open:c.open,high:c.high,low:c.low,close:c.close});
    else { g.high=Math.max(g.high,c.high); g.low=Math.min(g.low,c.low); g.close=c.close; }
  }
  return [...groups.values()].sort((a,b)=>a.time-b.time);
}
function emaNext(prev,value,period){const k=2/(period+1);return value*k+prev*(1-k);}

function simulate(candles,cfg){
  let cash=START,btc=0,position='USD',entry=0,entryCapital=0,fast=candles[0].close,slow=fast,prevFast=fast,prevSlow=slow;
  let fees=0,trades=0,wins=0,losses=0,barsHeld=0,cooldown=0,peak=START,maxDrawdown=0;
  for(let i=1;i<candles.length;i++){
    const c=candles[i]; prevFast=fast;prevSlow=slow;fast=emaNext(fast,c.close,cfg.fast);slow=emaNext(slow,c.close,cfg.slow);
    if(cooldown>0)cooldown--; if(position==='BTC')barsHeld++;
    if(i>=cfg.slow){
      const spread=Math.abs(fast-slow)/c.close,upCross=fast>slow&&prevFast<=prevSlow&&spread>=cfg.confirm,downCross=fast<slow&&prevFast>=prevSlow;
      if(position==='USD'&&cooldown===0&&upCross){entryCapital=cash;const fee=cash*FEE;btc=(cash-fee)/c.close;fees+=fee;cash=0;entry=c.close;position='BTC';trades++;barsHeld=0;}
      else if(position==='BTC'){
        const returnPct=c.close/entry-1,stopHit=returnPct<=-cfg.stop,profitReady=returnPct>=cfg.minProfit;
        if(barsHeld>=2&&((downCross&&(profitReady||stopHit))||stopHit)){
          const gross=btc*c.close,fee=gross*FEE;cash=gross-fee;fees+=fee;btc=0;trades++;if(cash>entryCapital)wins++;else losses++;position='USD';cooldown=2;entry=0;entryCapital=0;barsHeld=0;
        }
      }
    }
    const equity=cash+btc*c.close;if(equity>peak)peak=equity;const dd=(peak-equity)/peak;if(dd>maxDrawdown)maxDrawdown=dd;
  }
  const endingBalance=cash+btc*candles[candles.length-1].close,cycles=wins+losses;
  return {...cfg,endingBalance,returnPct:(endingBalance/START-1)*100,fees,trades,cycles,winRate:cycles?wins/cycles*100:0,maxDrawdown:maxDrawdown*100,finalPosition:position};
}

export async function GET(){
  try{
    const raw=await fetchThirtyDays(); if(raw.length<8000)throw new Error(`Not enough 30 day history returned: ${raw.length} candles`);
    const configs=[
      {name:'7 day winner',minutes:30,fast:3,slow:18,confirm:0.0005,minProfit:0.006,stop:0.025},
      {name:'Runner up',minutes:30,fast:3,slow:18,confirm:0.0005,minProfit:0.012,stop:0.025},
      {name:'30m 3/24',minutes:30,fast:3,slow:24,confirm:0.0005,minProfit:0.006,stop:0.025},
      {name:'15m 3/36',minutes:15,fast:3,slow:36,confirm:0.0005,minProfit:0.006,stop:0.025},
      {name:'15m 5/36',minutes:15,fast:5,slow:36,confirm:0.0005,minProfit:0.006,stop:0.025},
      {name:'30m 5/12',minutes:30,fast:5,slow:12,confirm:0.0005,minProfit:0.006,stop:0.025}
    ];
    const cache=new Map(); const results=configs.map(cfg=>{if(!cache.has(cfg.minutes))cache.set(cfg.minutes,aggregate(raw,cfg.minutes));return simulate(cache.get(cfg.minutes),cfg);}).sort((a,b)=>b.endingBalance-a.endingBalance);
    const first=raw[0].close,last=raw[raw.length-1].close,buyHoldEnding=START*last/first;
    return Response.json({startBalance:START,feeRate:FEE,candles:raw.length,candleMinutes:5,days:30,firstPrice:first,lastPrice:last,buyHoldEnding,buyHoldReturnPct:(buyHoldEnding/START-1)*100,best:results[0],results});
  }catch(error){return Response.json({error:error.message},{status:502});}
}

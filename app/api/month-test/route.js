export const dynamic='force-dynamic';
export const maxDuration=60;

const START=100,FEE=0.006,STEP=5*60*1000,LIMIT=1000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function fetchBatch(symbol,startTime,endTime){
 const url=`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=${LIMIT}`;
 const res=await fetch(url,{headers:{Accept:'application/json'},cache:'no-store'});
 const text=await res.text();
 if(!res.ok) throw new Error(`Binance.US ${res.status}: ${text.slice(0,140)}`);
 const rows=JSON.parse(text);
 return rows.map(r=>({time:+r[0],open:+r[1],high:+r[2],low:+r[3],close:+r[4],volume:+r[5]}));
}

async function fetchHistory(days){
 const end=Math.floor(Date.now()/STEP)*STEP;
 const start=end-days*86400000;
 for(const symbol of ['BTCUSD','BTCUSDT']){
  try{
   const all=[]; let cursor=start;
   while(cursor<end){
    const rows=await fetchBatch(symbol,cursor,end);
    if(!rows.length) break;
    all.push(...rows);
    const next=rows[rows.length-1].time+STEP;
    if(next<=cursor) break;
    cursor=next;
    await sleep(60);
   }
   const map=new Map();all.forEach(c=>map.set(c.time,c));
   const candles=[...map.values()].filter(c=>c.time>=start&&c.time<end).sort((a,b)=>a.time-b.time);
   if(candles.length>=days*250) return {candles,symbol};
  }catch(e){ if(symbol==='BTCUSDT') throw e; }
 }
 throw new Error('Binance.US did not return enough BTC history');
}

function aggregate(candles,minutes){
 const size=minutes*60000,groups=new Map();
 for(const c of candles){const key=Math.floor(c.time/size)*size,g=groups.get(key);if(!g)groups.set(key,{time:key,open:c.open,high:c.high,low:c.low,close:c.close});else{g.high=Math.max(g.high,c.high);g.low=Math.min(g.low,c.low);g.close=c.close;}}
 return [...groups.values()].sort((a,b)=>a.time-b.time);
}
function emaNext(prev,value,period){const k=2/(period+1);return value*k+prev*(1-k);}
function simulate(candles,cfg){
 let cash=START,btc=0,pos='USD',entry=0,entryCapital=0,fast=candles[0].close,slow=fast,pf=fast,ps=slow,fees=0,trades=0,wins=0,losses=0,held=0,cool=0,peak=START,maxDD=0;
 for(let i=1;i<candles.length;i++){
  const c=candles[i];pf=fast;ps=slow;fast=emaNext(fast,c.close,cfg.fast);slow=emaNext(slow,c.close,cfg.slow);if(cool>0)cool--;if(pos==='BTC')held++;
  if(i>=cfg.slow){const spread=Math.abs(fast-slow)/c.close,up=fast>slow&&pf<=ps&&spread>=cfg.confirm,down=fast<slow&&pf>=ps;
   if(pos==='USD'&&cool===0&&up){entryCapital=cash;const fee=cash*FEE;btc=(cash-fee)/c.close;fees+=fee;cash=0;entry=c.close;pos='BTC';trades++;held=0;}
   else if(pos==='BTC'){const ret=c.close/entry-1,stop=ret<=-cfg.stop,profit=ret>=cfg.minProfit;if(held>=2&&((down&&(profit||stop))||stop)){const gross=btc*c.close,fee=gross*FEE;cash=gross-fee;fees+=fee;btc=0;trades++;cash>entryCapital?wins++:losses++;pos='USD';cool=2;entry=0;entryCapital=0;held=0;}}
  }
  const equity=cash+btc*c.close;if(equity>peak)peak=equity;maxDD=Math.max(maxDD,(peak-equity)/peak);
 }
 const endingBalance=cash+btc*candles[candles.length-1].close,cycles=wins+losses;
 return {...cfg,endingBalance,returnPct:(endingBalance/START-1)*100,fees,trades,cycles,winRate:cycles?wins/cycles*100:0,maxDrawdown:maxDD*100,finalPosition:pos};
}

export async function GET(request){
 try{
  const u=new URL(request.url),days=Math.min(90,Math.max(30,Number(u.searchParams.get('days'))||30));
  const {candles:raw,symbol}=await fetchHistory(days);
  const configs=[
   {name:'7 day winner',minutes:30,fast:3,slow:18,confirm:0.0005,minProfit:0.006,stop:0.025},
   {name:'Runner up',minutes:30,fast:3,slow:18,confirm:0.0005,minProfit:0.012,stop:0.025},
   {name:'30m 3/24',minutes:30,fast:3,slow:24,confirm:0.0005,minProfit:0.006,stop:0.025},
   {name:'15m 3/36',minutes:15,fast:3,slow:36,confirm:0.0005,minProfit:0.006,stop:0.025},
   {name:'15m 5/36',minutes:15,fast:5,slow:36,confirm:0.0005,minProfit:0.006,stop:0.025},
   {name:'30m 5/12',minutes:30,fast:5,slow:12,confirm:0.0005,minProfit:0.006,stop:0.025}
  ];
  const cache=new Map(),results=configs.map(cfg=>{if(!cache.has(cfg.minutes))cache.set(cfg.minutes,aggregate(raw,cfg.minutes));return simulate(cache.get(cfg.minutes),cfg);}).sort((a,b)=>b.endingBalance-a.endingBalance);
  const first=raw[0].close,last=raw[raw.length-1].close,buyHoldEnding=START*last/first;
  return Response.json({source:'Binance.US',symbol,days,startBalance:START,feeRate:FEE,candles:raw.length,candleMinutes:5,firstPrice:first,lastPrice:last,buyHoldEnding,buyHoldReturnPct:(buyHoldEnding/START-1)*100,best:results[0],results});
 }catch(error){return Response.json({error:error.message},{status:502});}
}

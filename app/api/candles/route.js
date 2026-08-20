export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [candlesRes, tickerRes] = await Promise.all([
      fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60', {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      }),
      fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker', {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      })
    ]);

    if (!candlesRes.ok) throw new Error(`Coinbase candles ${candlesRes.status}`);
    if (!tickerRes.ok) throw new Error(`Coinbase ticker ${tickerRes.status}`);

    const raw = await candlesRes.json();
    const ticker = await tickerRes.json();
    const currentMinute = Math.floor(Date.now() / 60000) * 60;

    const candles = raw
      .map(([time, low, high, open, close, volume]) => ({
        time: Number(time),
        low: Number(low),
        high: Number(high),
        open: Number(open),
        close: Number(close),
        volume: Number(volume)
      }))
      .filter(c => c.time < currentMinute)
      .sort((a, b) => a.time - b.time)
      .slice(-180);

    return Response.json({
      price: Number(ticker.price),
      candles,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502 });
  }
}

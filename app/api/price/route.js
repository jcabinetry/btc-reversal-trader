export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const res = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker', {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`Coinbase ${res.status}`);
    const data = await res.json();
    return Response.json({ price: Number(data.price), time: data.time || new Date().toISOString() });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502 });
  }
}

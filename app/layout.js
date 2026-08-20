import './globals.css';

export const metadata = { title: 'BTC Reversal Trader', description: 'Live BTC paper trading dashboard' };

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}

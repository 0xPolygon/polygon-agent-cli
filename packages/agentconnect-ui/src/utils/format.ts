export const usd = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const signedUsd = (n: number) => (n < 0 ? '-' : '+') + usd(Math.abs(n));

export const shortAddr = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function when(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function qty(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 });
}

export const usd = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const signedUsd = (n: number) => (n < 0 ? '-' : '+') + usd(Math.abs(n));

export const shortAddr = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

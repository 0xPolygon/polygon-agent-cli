// POSIX single quotes: nothing inside is expanded. A quote becomes '\''.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

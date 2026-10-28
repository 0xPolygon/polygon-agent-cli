// The approval link's preview: the image and tags a chat app shows when the
// link is pasted (the amount large, the store under it, and our label), so
// the owner sees what they are approving before they open it. Drawn from the
// bitmaps in og-glyphs.ts and encoded as a PNG here: no font engine or image
// library in the worker.

import type { Face } from './og-glyphs.ts';

import { BITMAPS, FACES } from './og-glyphs.ts';

export const WIDTH = 1200;
export const HEIGHT = 630;
const BAND = 150;
const PAD = 80;

type RGB = [number, number, number];
const INK: RGB = [11, 11, 15];
const MUTED: RGB = [107, 107, 118];
const PAPER: RGB = [255, 255, 255];
const BAND_BG: RGB = [242, 242, 245];
const PURPLE: RGB = [108, 0, 246];

let coverage: Promise<Uint8Array> | null = null;
function bitmaps(): Promise<Uint8Array> {
  coverage ??= inflate(Uint8Array.from(atob(BITMAPS), (c) => c.charCodeAt(0)));
  return coverage;
}

class Canvas {
  readonly px = new Uint8Array(WIDTH * HEIGHT * 3);

  fill(x0: number, y0: number, x1: number, y1: number, [r, g, b]: RGB) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * WIDTH + x) * 3;
        this.px[i] = r;
        this.px[i + 1] = g;
        this.px[i + 2] = b;
      }
    }
  }

  /** Blends an 8-bit coverage bitmap at (x, y) in one colour. */
  blit(src: Uint8Array, at: number, w: number, h: number, x: number, y: number, ink: RGB) {
    for (let j = 0; j < h; j++) {
      const py = y + j;
      if (py < 0 || py >= HEIGHT) continue;
      for (let i = 0; i < w; i++) {
        const px = x + i;
        const a = src[at + j * w + i];
        if (!a || px < 0 || px >= WIDTH) continue;
        const k = (py * WIDTH + px) * 3;
        for (let c = 0; c < 3; c++) {
          this.px[k + c] = Math.round((ink[c] * a + this.px[k + c] * (255 - a)) / 255);
        }
      }
    }
  }
}

/** Width of `text` in `face`, or null when a character has no glyph. */
export function measure(face: Face, text: string): number | null {
  let w = 0;
  for (const ch of text) {
    const g = face.glyphs[ch];
    if (!g) return null;
    w += g[5];
  }
  return w;
}

function write(
  c: Canvas,
  src: Uint8Array,
  face: Face,
  text: string,
  x: number,
  baseline: number,
  ink: RGB
) {
  let pen = x;
  for (const ch of text) {
    const [at, w, h, dx, dy, advance] = face.glyphs[ch];
    if (w) c.blit(src, at, w, h, pen + dx, baseline + dy, ink);
    pen += advance;
  }
}

/** Shortens `text` with an ellipsis to fit `max` pixels; drops characters we can't draw. */
export function fit(face: Face, text: string, max: number): string {
  let out = [...text].filter((ch) => face.glyphs[ch]).join('');
  if ((measure(face, out) ?? 0) <= max) return out;
  while (out && (measure(face, out + '...') ?? 0) > max) out = out.slice(0, -1);
  return out.trimEnd() + '...';
}

/** The preview image: the amount, the store and our label, as a PNG. */
export async function previewPng(amount: string, merchant: string): Promise<Uint8Array> {
  const src = await bitmaps();
  const c = new Canvas();
  c.fill(0, 0, WIDTH, HEIGHT, PAPER);
  c.fill(0, HEIGHT - BAND, WIDTH, HEIGHT, BAND_BG);

  const big = measure(FACES.amount, amount) !== null ? FACES.amount : FACES.text;
  write(c, src, big, fit(big, amount, WIDTH - PAD * 2), PAD, 250, INK);
  const store = fit(FACES.text, merchant, WIDTH - PAD * 2);
  if (store) write(c, src, FACES.text, store, PAD, 340, MUTED);

  const [at, w, h] = FACES.mark;
  const mid = HEIGHT - BAND / 2;
  c.blit(src, at, w, h, PAD, Math.round(mid - h / 2), PURPLE);
  write(c, src, FACES.text, 'Approve with Open Money Agent', PAD + w + 24, mid + 15, INK);

  return png(c.px);
}

// PNG: 8-bit RGB, no interlace, every row unfiltered.
async function png(rgb: Uint8Array): Promise<Uint8Array> {
  const stride = WIDTH * 3;
  const raw = new Uint8Array((stride + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, WIDTH);
  v.setUint32(4, HEIGHT);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return concat([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0))
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// zlib streams, which is what PNG's IDAT and og-glyphs.ts both hold.
function deflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('deflate'));
}
function inflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('deflate'));
}
async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const body = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * The approval page's HTML with the preview's tags: the amount and store as
 * the title, and the image. Only what the link already shows to whoever has
 * it: never the address, the card or the items.
 */
export function withPreviewTags(
  html: string,
  p: { origin: string; id: string; amount: string; merchant: string } | null
): string {
  const title = p ? `${p.amount} at ${p.merchant}` : 'Approve a purchase';
  const description = 'Approve or decline this purchase with Open Money Agent.';
  const tags = [
    ['og:type', 'website'],
    ['og:site_name', 'Open Money Agent'],
    ['og:title', title],
    ['og:description', description],
    ...(p
      ? [
          ['og:image', `${p.origin}/api/approve/preview.png?r=${encodeURIComponent(p.id)}`],
          ['og:image:width', String(WIDTH)],
          ['og:image:height', String(HEIGHT)],
          ['og:image:alt', title]
        ]
      : [])
  ]
    .map(([k, v]) => `<meta property="${k}" content="${esc(v)}" />`)
    .concat(
      `<meta name="twitter:card" content="${p ? 'summary_large_image' : 'summary'}" />`,
      `<meta name="description" content="${esc(description)}" />`
    )
    .join('\n    ');
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace('</head>', `    ${tags}\n  </head>`);
}

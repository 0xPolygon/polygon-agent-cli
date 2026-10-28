import { describe, expect, it } from 'vitest';

import { FACES } from './og-glyphs.ts';
import { fit, HEIGHT, measure, previewPng, WIDTH, withPreviewTags } from './og-image.ts';

describe('previewPng', () => {
  it('draws a PNG of the preview size', async () => {
    const png = await previewPng('€14.95', 'Noordcode');
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const v = new DataView(png.buffer, png.byteOffset);
    expect(v.getUint32(16)).toBe(WIDTH);
    expect(v.getUint32(20)).toBe(HEIGHT);
    expect(new TextDecoder().decode(png.subarray(-8, -4))).toBe('IEND');
  });

  it('still draws a store name it has no glyphs for', async () => {
    const png = await previewPng('¥1,500', 'カフェ');
    expect(png.length).toBeGreaterThan(1000);
  });
});

describe('fit', () => {
  it('keeps text that fits and shortens text that does not', () => {
    expect(fit(FACES.text, 'Noordcode', 1000)).toBe('Noordcode');
    const short = fit(FACES.text, 'x'.repeat(200), 400);
    expect(short.endsWith('...')).toBe(true);
    expect(measure(FACES.text, short)!).toBeLessThanOrEqual(400);
  });
});

describe('withPreviewTags', () => {
  const html = '<html><head><title>Polygon Agent Wallet</title></head><body></body></html>';

  it('titles the page with the amount and store and links the image', () => {
    const out = withPreviewTags(html, {
      origin: 'https://agents.test',
      id: 'apr_1',
      amount: '€14.95',
      merchant: 'Noordcode'
    });
    expect(out).toContain('<title>€14.95 at Noordcode</title>');
    expect(out).toContain('<meta property="og:title" content="€14.95 at Noordcode" />');
    expect(out).toContain(
      '<meta property="og:image" content="https://agents.test/api/approve/preview.png?r=apr_1" />'
    );
    expect(out).toContain('summary_large_image');
  });

  it('escapes the store name', () => {
    const out = withPreviewTags(html, {
      origin: 'https://agents.test',
      id: 'apr_1',
      amount: '$1.00',
      merchant: '"><script>x</script>'
    });
    expect(out).not.toContain('<script>');
  });

  it('has a plain title and no image without an approval', () => {
    const out = withPreviewTags(html, null);
    expect(out).toContain('<title>Approve a purchase</title>');
    expect(out).not.toContain('og:image');
  });
});

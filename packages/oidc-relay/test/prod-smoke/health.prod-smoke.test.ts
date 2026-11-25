import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { shouldRun, smokeFetch } from './smoke.ts';

const HealthSchema = z.object({ ok: z.literal(true), service: z.literal('oidc-relay') });

describe.skipIf(!shouldRun)('oidc-relay prod smoke', () => {
  it('GET /health reports the relay is up', async () => {
    const res = await smokeFetch('/health');
    expect(res.status).toBe(200);
    HealthSchema.parse(await res.json(), { reportInput: true });
  });
});

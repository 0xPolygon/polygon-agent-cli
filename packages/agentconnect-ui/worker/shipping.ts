// The shipping address as agents and the dashboard see it, and its encoding
// into OMS customer metadata (the only customer field OMS returns as written;
// residentialAddress is write-only and tied to KYC).

export interface ShippingAddress {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
}

export const ADDRESS_FIELDS = [
  'name',
  'line1',
  'line2',
  'city',
  'state',
  'zip',
  'country',
  'phone'
] as const;
const REQUIRED: (keyof ShippingAddress)[] = ['name', 'line1', 'city', 'country'];
const MAX_LENGTH = 200;
const PREFIX = 'ship_';

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string
  ) {
    super(message);
  }
}

/** Trim and check an address from a request body. */
export function parseAddress(input: unknown): ShippingAddress {
  if (!input || typeof input !== 'object')
    throw new ValidationError('Send the address as a JSON object');
  const raw = input as Record<string, unknown>;
  const out = {} as ShippingAddress;
  for (const f of ADDRESS_FIELDS) {
    const v = raw[f];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw new ValidationError(`${f} must be a string`, f);
    }
    const s = (v ?? '').trim();
    if (s.length > MAX_LENGTH) throw new ValidationError(`${f} is too long`, f);
    out[f] = s;
  }
  for (const f of REQUIRED) {
    if (!out[f]) throw new ValidationError(`${f} is required`, f);
  }
  return out;
}

/** Every field, so a PATCH replaces the whole address whether OMS merges or replaces metadata. */
export function addressToMetadata(a: ShippingAddress | null): Record<string, string> {
  return Object.fromEntries(ADDRESS_FIELDS.map((f) => [PREFIX + f, a ? a[f] : '']));
}

export function addressFromMetadata(
  meta: Record<string, string> | null | undefined
): ShippingAddress | null {
  if (!meta) return null;
  const a = Object.fromEntries(
    ADDRESS_FIELDS.map((f) => [f, meta[PREFIX + f] ?? ''])
  ) as unknown as ShippingAddress;
  return a.line1 ? a : null;
}

import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ShippingAddress } from './credentials-api.js';

import { CredentialsError, EMPTY_ADDRESS, getAddress, saveAddress } from './credentials-api.js';
import { EmptyState, Panel } from './ui.js';

const FIELDS: { key: keyof ShippingAddress; label: string; wide?: boolean; auto: string }[] = [
  { key: 'name', label: 'Full name', wide: true, auto: 'name' },
  { key: 'line1', label: 'Street address', auto: 'address-line1' },
  { key: 'line2', label: 'Apartment, suite (optional)', auto: 'address-line2' },
  { key: 'city', label: 'City', auto: 'address-level2' },
  { key: 'state', label: 'State', auto: 'address-level1' },
  { key: 'zip', label: 'ZIP code', auto: 'postal-code' },
  { key: 'country', label: 'Country', auto: 'country-name' },
  { key: 'phone', label: 'Phone for delivery (optional)', auto: 'tel' }
];

type Load = 'loading' | 'ready' | 'expired' | 'unavailable' | 'error';

function SignInFirst() {
  return (
    <Panel className="flex flex-col gap-4 items-start">
      <EmptyState title="Sign in to see your saved details">
        Your address and cards are only shown after you sign in.
      </EmptyState>
      <a href="/" className="btn btn-primary btn-lg">
        Sign in
      </a>
    </Panel>
  );
}

export function CredentialsTab({
  token,
  onSaved
}: {
  token: string | null;
  onSaved: (msg: string) => void;
}) {
  const [load, setLoad] = useState<Load>(token ? 'loading' : 'expired');
  const [address, setAddress] = useState<ShippingAddress>(EMPTY_ADDRESS);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // Shown on the button for a moment after a save, so the click visibly lands.
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    getAddress(token)
      .then((a) => {
        if (!active) return;
        setAddress(a ?? EMPTY_ADDRESS);
        setSaved(!!a);
        setLoad('ready');
      })
      .catch((err: unknown) => {
        if (!active) return;
        const status = err instanceof CredentialsError ? err.status : 0;
        setLoad(status === 401 ? 'expired' : status === 503 ? 'unavailable' : 'error');
      });
    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 2000);
    return () => clearTimeout(t);
  }, [justSaved]);

  if (load === 'expired') return <SignInFirst />;

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setError(null);
    try {
      // Keep "Saving…" up long enough to read; the request is often instant.
      const [next] = await Promise.all([
        saveAddress(token, address),
        new Promise((r) => setTimeout(r, 600))
      ]);
      setAddress(next);
      setSaved(true);
      setJustSaved(true);
      onSaved('Address saved');
    } catch (err) {
      if (err instanceof CredentialsError && err.status === 401) setLoad('expired');
      else setError(err instanceof Error ? err.message : 'Could not save the address');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="m-0 text-base leading-snug text-[var(--slate-600)] max-w-[620px]">
        Save the details agents need when they buy for you. They are only shared with the store at
        checkout.
      </p>
      <Panel className="flex flex-col gap-5">
        <div className="flex justify-between items-center gap-3">
          <span className="text-lg font-bold">Shipping address</span>
          {saved && <span className="oms-badge oms-badge--success oms-badge--sm">Saved</span>}
        </div>
        {load === 'loading' ? (
          <div className="h-40 rounded-xl bg-[var(--slate-50)] animate-pulse" />
        ) : load === 'unavailable' || load === 'error' ? (
          <EmptyState title="Saved addresses aren't available right now">
            {load === 'unavailable'
              ? 'This deployment is not set up to store addresses yet.'
              : 'Refresh the page to try again.'}
          </EmptyState>
        ) : (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
            >
              {FIELDS.map((f) => (
                <label
                  key={f.key}
                  className="flex flex-col gap-2"
                  style={{ gridColumn: f.wide ? '1 / -1' : undefined }}
                >
                  <span className="text-sm font-medium text-[var(--slate-600)]">{f.label}</span>
                  <input
                    value={address[f.key]}
                    autoComplete={f.auto}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSaved(false);
                      setJustSaved(false);
                      setAddress((a) => ({ ...a, [f.key]: v }));
                    }}
                    className="h-11 border border-[var(--slate-300)] rounded-xl px-3.5 text-[15px] bg-white outline-none focus:border-[var(--purple-500)] focus:ring-2 focus:ring-[var(--purple-200)]"
                  />
                </label>
              ))}
            </div>
            {error && <span className="text-sm text-[var(--red-700)]">{error}</span>}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving || justSaved}
                className="btn btn-primary btn-lg"
              >
                {saving ? (
                  'Saving…'
                ) : justSaved ? (
                  <span className="flex items-center gap-2">
                    <Check className="w-[18px] h-[18px]" />
                    Address saved
                  </span>
                ) : (
                  'Save address'
                )}
              </button>
            </div>
          </form>
        )}
      </Panel>
    </div>
  );
}

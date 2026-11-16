import { useEffect, useState } from 'react';

import type { Loadable } from '../dashboard/types.js';

import { runLoad } from './runLoad.js';

export function useLoad<T>(load: (() => Promise<T>) | null, deps: unknown[]): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ data: null, loading: !!load, error: false });
  useEffect(() => {
    if (!load) {
      setState({ data: null, loading: false, error: false });
      return;
    }
    setState({ data: null, loading: true, error: false });
    return runLoad({
      load,
      onDone: (data) => setState({ data, loading: false, error: false }),
      onFail: (err) => {
        console.warn(err);
        setState({ data: null, loading: false, error: true });
      }
    });
  }, deps);
  return state;
}

// One source that accepts a request and never answers would otherwise keep the headline total on a skeleton forever.
export const LOAD_LIMIT_MS = 15_000;

interface RunLoadParams<T> {
  load: () => Promise<T>;
  onDone: (data: T) => void;
  onFail: (err: unknown) => void;
}

// Whichever of result, failure, expiry or cancel comes first wins; later ones are dropped, so nothing writes state after.
export function runLoad<T>({ load, onDone, onFail }: RunLoadParams<T>): () => void {
  let live = true;
  const settle = (then: () => void) => {
    if (!live) return;
    live = false;
    clearTimeout(timer);
    then();
  };
  const timer = setTimeout(
    () => settle(() => onFail(new Error(`Load timed out after ${LOAD_LIMIT_MS}ms`))),
    LOAD_LIMIT_MS
  );
  load().then(
    (data) => settle(() => onDone(data)),
    (err: unknown) => settle(() => onFail(err))
  );
  return () => {
    live = false;
    clearTimeout(timer);
  };
}

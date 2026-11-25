// One JSON line per event so Workers Logs can index fields. A cause chain
// is serialised because MoneyError keeps the original failure as its native `cause`.

const MAX_CAUSE_DEPTH = 5;

type SerializedError = {
  type: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: SerializedError;
};

function serializeError(err: unknown, depth = 0): SerializedError {
  if (!(err instanceof Error)) {
    return { type: typeof err, message: typeof err === 'string' ? err : safeString(err) };
  }
  const out: SerializedError = { type: err.constructor.name, message: err.message };
  if ('code' in err && typeof err.code === 'string') out.code = err.code;
  if (err.stack) out.stack = err.stack;
  if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out.cause = serializeError(err.cause, depth + 1);
  }
  return out;
}

// A thrown value may not stringify (null-prototype object, throwing toString); logging must not throw.
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

type LogFields = { err?: unknown } & Record<string, unknown>;

function line(params: { level: 'error' | 'warn'; msg: string; fields: LogFields }): string {
  const { err, ...context } = params.fields;
  return JSON.stringify({
    level: params.level,
    msg: params.msg,
    ...context,
    ...(err === undefined ? {} : { err: serializeError(err) })
  });
}

export function logError(msg: string, fields: LogFields = {}): void {
  console.error(line({ level: 'error', msg, fields }));
}

export function logWarn(msg: string, fields: LogFields = {}): void {
  console.warn(line({ level: 'warn', msg, fields }));
}

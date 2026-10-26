// Spends the owner confirms one by one, outside the agent's app. For clients
// whose platform wants the user to approve every transaction themselves
// (ChatGPT), a spending tool doesn't spend: it saves the request as a pending
// action and answers with a link to /approve on this site. The owner, signed in
// here, sees what it does and approves or declines it; approving runs it with
// the connection's key, within its allowance like any other spend.

import type { KeyStorage } from './agent-key.ts';

import { MoneyError } from './errors.ts';

// How long the owner has to decide.
export const ACTION_TTL_MS = 15 * 60 * 1000;

export type ActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'declined' | 'expired';

export interface PendingAction<R = unknown> {
  id: string;
  // The request it runs once approved (a KeyRequest without the wallet).
  request: R;
  // What it does, in the owner's words, shown on the approval page.
  title: string;
  details: { label: string; value: string }[];
  // The app that asked.
  appName: string;
  status: ActionStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  result?: unknown;
  error?: ReturnType<MoneyError['toJSON']>;
}

const key = (id: string) => `action:${id}`;

export async function proposeAction<R>(params: {
  storage: KeyStorage;
  request: R;
  title: string;
  details: PendingAction['details'];
  appName: string;
  now: Date;
}): Promise<PendingAction<R>> {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  const action: PendingAction<R> = {
    id,
    request: params.request,
    title: params.title,
    details: params.details,
    appName: params.appName,
    status: 'pending',
    createdAt: params.now.toISOString(),
    expiresAt: new Date(params.now.getTime() + ACTION_TTL_MS).toISOString()
  };
  await params.storage.put(key(id), action);
  return action;
}

export async function loadAction<R>(
  storage: KeyStorage,
  id: string,
  now: Date
): Promise<PendingAction<R>> {
  const action = /^[0-9a-f]{24}$/.test(id)
    ? await storage.get<PendingAction<R>>(key(id))
    : undefined;
  if (!action) {
    throw new MoneyError({ code: 'invalid_input', message: 'No such request on this connection.' });
  }
  if (action.status === 'pending' && Date.parse(action.expiresAt) <= now.getTime()) {
    const expired = { ...action, status: 'expired' as const };
    await storage.put(key(id), expired);
    return expired;
  }
  return action;
}

/**
 * The owner's answer. Approving runs the request once: a decided action is
 * never run again, whatever comes back.
 */
export async function decideAction<R>(params: {
  storage: KeyStorage;
  id: string;
  approve: boolean;
  run: (request: R) => Promise<unknown>;
  now: () => Date;
}): Promise<PendingAction<R>> {
  const action = await loadAction<R>(params.storage, params.id, params.now());
  if (action.status !== 'pending') {
    throw new MoneyError({
      code: 'invalid_input',
      message:
        action.status === 'expired'
          ? 'This request expired. Ask the agent to try again.'
          : 'This request was already answered.'
    });
  }
  const decidedAt = params.now().toISOString();
  if (!params.approve) {
    const declined = { ...action, status: 'declined' as const, decidedAt };
    await params.storage.put(key(action.id), declined);
    return declined;
  }
  // Marked before running, so nothing can run it a second time.
  await params.storage.put(key(action.id), { ...action, status: 'running', decidedAt });
  try {
    const result = await params.run(action.request);
    const done = { ...action, status: 'done' as const, decidedAt, result };
    await params.storage.put(key(action.id), done);
    return done;
  } catch (error) {
    const failed = {
      ...action,
      status: 'failed' as const,
      decidedAt,
      error:
        error instanceof MoneyError
          ? error.toJSON()
          : {
              error: error instanceof Error ? error.message : String(error),
              code: 'upstream_error' as const
            }
    };
    await params.storage.put(key(action.id), failed);
    return failed;
  }
}

/** What the agent and the approval page see of an action. */
export function viewAction(action: PendingAction) {
  return {
    actionId: action.id,
    status: action.status,
    title: action.title,
    details: action.details,
    appName: action.appName,
    expiresAt: action.expiresAt,
    ...(action.result !== undefined ? { result: action.result } : {}),
    ...(action.error ? { error: action.error } : {})
  };
}

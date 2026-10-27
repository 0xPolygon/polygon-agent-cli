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
// An approved spend that hasn't reported back by then has lost its result.
export const RUN_TTL_MS = 30 * 60 * 1000;

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
  // Set when it runs as the owner (signed in on the approval page), not with
  // the connection's key: these transactions, sent from the owner's wallet.
  owner?: { chainId: number; transactions: { to: string; data: string }[] };
  // What the owner action needs on its chain first: bridged there from the
  // wallet's other chains, within the allowance, once approved.
  fund?: { chainId: number; symbol: string; amount: string };
  status: ActionStatus;
  // Approved and waiting to run in the background (the owner isn't kept waiting).
  queued?: boolean;
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
  owner?: PendingAction['owner'];
  fund?: PendingAction['fund'];
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
    ...(params.owner ? { owner: params.owner } : {}),
    ...(params.fund ? { fund: params.fund } : {}),
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
  if (
    action.status === 'running' &&
    action.decidedAt &&
    Date.parse(action.decidedAt) + RUN_TTL_MS <= now.getTime()
  ) {
    const lost: PendingAction<R> = {
      ...action,
      status: 'failed',
      queued: false,
      error: {
        error:
          'No result came back in time. Check the wallet before trying again: it may have gone through.',
        code: 'upstream_error'
      }
    };
    await storage.put(key(id), lost);
    return lost;
  }
  return action;
}

/**
 * The owner's answer. Approving runs the request once: a decided action is
 * never run again, whatever comes back. With `defer`, approving only queues it
 * (runQueuedActions runs it), so the owner gets an answer at once.
 */
export async function decideAction<R>(params: {
  storage: KeyStorage;
  id: string;
  approve: boolean;
  run: (request: R) => Promise<unknown>;
  now: () => Date;
  defer?: boolean;
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
  if (params.approve && action.owner) {
    throw new MoneyError({
      code: 'invalid_input',
      message: 'This one runs from your wallet: sign in on the page to approve it.'
    });
  }
  if (!params.approve) {
    const declined = { ...action, status: 'declined' as const, decidedAt };
    await params.storage.put(key(action.id), declined);
    return declined;
  }
  if (params.defer) {
    const queued = { ...action, status: 'running' as const, decidedAt, queued: true };
    await params.storage.put(key(action.id), queued);
    return queued;
  }
  return runAction(params.storage, { ...action, decidedAt }, params.run);
}

/** Runs the approved actions waiting in the queue, one after another. */
export async function runQueuedActions<R>(
  storage: KeyStorage,
  run: (request: R) => Promise<unknown>
): Promise<void> {
  const actions = await storage.list<PendingAction<R>>({ prefix: 'action:' });
  for (const action of actions.values()) {
    if (action.status === 'running' && action.queued) await runAction(storage, action, run);
  }
}

async function runAction<R>(
  storage: KeyStorage,
  action: PendingAction<R>,
  run: (request: R) => Promise<unknown>
): Promise<PendingAction<R>> {
  const decidedAt = action.decidedAt;
  // Marked before running, so nothing can run it a second time.
  await storage.put(key(action.id), { ...action, status: 'running', queued: false });
  try {
    const result = await run(action.request);
    const done = { ...action, status: 'done' as const, queued: false, decidedAt, result };
    await storage.put(key(action.id), done);
    return done;
  } catch (error) {
    const failed = {
      ...action,
      status: 'failed' as const,
      queued: false,
      decidedAt,
      error:
        error instanceof MoneyError
          ? error.toJSON()
          : {
              error: error instanceof Error ? error.message : String(error),
              code: 'upstream_error' as const
            }
    };
    await storage.put(key(action.id), failed);
    return failed;
  }
}

/** An owner action, approved: marked running and handed to the worker to send. */
export async function beginOwnerAction(
  storage: KeyStorage,
  id: string,
  now: Date,
  // Runs before it's marked running: a failure here leaves it to retry.
  fund?: (f: NonNullable<PendingAction['fund']>) => Promise<unknown>
): Promise<NonNullable<PendingAction['owner']>> {
  const action = await loadAction(storage, id, now);
  if (!action.owner)
    throw new MoneyError({ code: 'invalid_input', message: 'Not an owner action.' });
  if (action.status !== 'pending') {
    throw new MoneyError({
      code: 'invalid_input',
      message:
        action.status === 'expired'
          ? 'This request expired. Ask the agent to try again.'
          : 'This request was already answered.'
    });
  }
  if (action.fund && fund) await fund(action.fund);
  await storage.put(key(id), { ...action, status: 'running', decidedAt: now.toISOString() });
  return action.owner;
}

export async function endOwnerAction(
  storage: KeyStorage,
  id: string,
  outcome: { result: unknown } | { error: ReturnType<MoneyError['toJSON']> },
  now: Date
): Promise<PendingAction> {
  const action = await loadAction(storage, id, now);
  const ended =
    'result' in outcome
      ? { ...action, status: 'done' as const, result: outcome.result }
      : { ...action, status: 'failed' as const, error: outcome.error };
  await storage.put(key(id), ended);
  return ended;
}

/** What the agent and the approval page see of an action. */
export function viewAction(action: PendingAction) {
  return {
    actionId: action.id,
    status: action.status,
    title: action.title,
    details: action.details,
    appName: action.appName,
    // Approving it means signing in on the page: it runs from the owner's wallet.
    ownerSignIn: !!action.owner,
    expiresAt: action.expiresAt,
    ...(action.result !== undefined ? { result: action.result } : {}),
    ...(action.error ? { error: action.error } : {})
  };
}

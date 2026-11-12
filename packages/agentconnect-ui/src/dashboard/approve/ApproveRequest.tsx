import { Card } from '@polygonlabs/design-system';

import type { Action } from '../Approve.js';

interface ApproveRequestProps {
  action: Action;
}

export function ApproveRequest({ action }: ApproveRequestProps) {
  return (
    <>
      <div className="flex flex-col gap-3 text-center">
        <span className="text-sm text-muted">{action.appName} asks you to approve</span>
        <h1 className="m-0 text-2xl leading-tight font-bold text-black">{action.title}</h1>
      </div>
      {action.details.length > 0 && (
        <Card variant="outline" className="rounded-2xl px-4 py-1">
          {action.details.map((d) => (
            <div
              key={d.label}
              className="flex justify-between gap-4 border-t border-slate-200 py-3.5 text-base first:border-t-0"
            >
              <span className="text-muted">{d.label}</span>
              <span className="text-right font-bold break-all">{d.value}</span>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

import type React from 'react';

import { render } from 'ink';

export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

export async function inkRender(
  element: React.ReactElement,
  opts?: { useStderr?: boolean }
): Promise<void> {
  const stream = opts?.useStderr ? process.stderr : process.stdout;
  const instance = render(element, { exitOnCtrlC: true, stdout: stream as NodeJS.WriteStream });
  await instance.waitUntilExit();
}

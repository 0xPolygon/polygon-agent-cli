export interface RacScenario {
  revokeStatus?: number;
}

// The client's own unauthorized error (code 7207) for a 401, a generic failure otherwise.
const refusal = (status: number) =>
  Response.json(
    status === 401
      ? { error: 'Unauthorized', code: 7207, msg: 'refused', cause: '', status }
      : { error: 'Unavailable', code: 0, msg: 'refused', cause: '', status },
    { status }
  );

// Only the credential calls the key object makes are answered; anything else is 501.
export const handle = (req: Request, scenario: RacScenario | undefined): Response => {
  const { pathname } = new URL(req.url);
  if (pathname === '/v1/Waas/RegisterCredential')
    return Response.json({ credentialId: 'cred-test-1' });
  if (pathname === '/v1/Waas/RevokeCredential') {
    const status = scenario?.revokeStatus ?? 200;
    return status === 200 ? Response.json({}) : refusal(status);
  }
  return Response.json({ error: 'not faked' }, { status: 501 });
};

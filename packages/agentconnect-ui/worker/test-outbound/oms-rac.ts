export interface RacScenario {
  revokeStatus?: number;
}

// Only the credential calls the key object makes are answered; anything else is 501.
export const handle = (req: Request, scenario: RacScenario | undefined): Response => {
  const { pathname } = new URL(req.url);
  if (pathname === '/v1/Waas/RegisterCredential')
    return Response.json({ credentialId: 'cred-test-1' });
  if (pathname === '/v1/Waas/RevokeCredential') {
    const status = scenario?.revokeStatus ?? 200;
    return Response.json(
      status === 200
        ? {}
        : { error: 'Unauthorized', code: 1000, msg: 'refused', cause: '', status },
      { status }
    );
  }
  return Response.json({ error: 'not faked' }, { status: 501 });
};

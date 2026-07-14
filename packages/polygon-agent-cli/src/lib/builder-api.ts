// Sequence Builder API helpers (GetAuthToken / CreateProject / GetDefaultAccessKey).
// Used by `setup` and by the post-login auto-provisioning in lib/builder-provision.ts.

export async function getAuthToken(proofString: string): Promise<string> {
  const apiUrl = process.env.SEQUENCE_BUILDER_API_URL || 'https://api.sequence.build';
  const url = `${apiUrl}/rpc/Builder/GetAuthToken`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ethauthProof: proofString })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GetAuthToken failed: ${response.status} ${errorText}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await response.json();

  if (!data.ok || !data.auth?.jwtToken) {
    throw new Error('GetAuthToken returned invalid response');
  }

  return data.auth.jwtToken;
}

export async function createProject(
  name: string,
  jwtToken: string
): Promise<{ id: number; name: string }> {
  const apiUrl = process.env.SEQUENCE_BUILDER_API_URL || 'https://api.sequence.build';
  const url = `${apiUrl}/rpc/Builder/CreateProject`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwtToken}`
    },
    body: JSON.stringify({ name })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`CreateProject failed: ${response.status} ${errorText}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await response.json();

  if (!data.project) {
    throw new Error('CreateProject returned invalid response');
  }

  return data.project;
}

export async function getDefaultAccessKey(projectId: number, jwtToken: string): Promise<string> {
  const apiUrl = process.env.SEQUENCE_BUILDER_API_URL || 'https://api.sequence.build';
  const url = `${apiUrl}/rpc/QuotaControl/GetDefaultAccessKey`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwtToken}`
    },
    body: JSON.stringify({ projectID: projectId })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GetDefaultAccessKey failed: ${response.status} ${errorText}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await response.json();

  if (!data.accessKey?.accessKey) {
    throw new Error('GetDefaultAccessKey returned invalid response');
  }

  return data.accessKey.accessKey;
}

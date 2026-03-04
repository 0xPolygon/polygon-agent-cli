import { ethers } from 'ethers';

const ETH_AUTH_VERSION = '1';
const ETH_AUTH_PREFIX = 'eth';

const ETH_AUTH_DOMAIN = {
  name: 'ETHAuth',
  version: '1'
};

interface Claims {
  app?: string;
  iat?: number;
  exp?: number;
  n?: number;
  typ?: string;
  ogn?: string;
  v?: string;
}

interface TypeField {
  name: string;
  type: string;
}

function buildTypedData(claims: Claims) {
  const types: TypeField[] = [];
  const message: Record<string, string | number> = {};

  if (claims.app && claims.app.length > 0) {
    types.push({ name: 'app', type: 'string' });
    message['app'] = claims.app;
  }

  if (claims.iat && claims.iat > 0) {
    types.push({ name: 'iat', type: 'int64' });
    message['iat'] = claims.iat;
  }

  if (claims.exp && claims.exp > 0) {
    types.push({ name: 'exp', type: 'int64' });
    message['exp'] = claims.exp;
  }

  if (claims.n && claims.n > 0) {
    types.push({ name: 'n', type: 'uint64' });
    message['n'] = claims.n;
  }

  if (claims.typ && claims.typ.length > 0) {
    types.push({ name: 'typ', type: 'string' });
    message['typ'] = claims.typ;
  }

  if (claims.ogn && claims.ogn.length > 0) {
    types.push({ name: 'ogn', type: 'string' });
    message['ogn'] = claims.ogn;
  }

  if (claims.v && claims.v.length > 0) {
    types.push({ name: 'v', type: 'string' });
    message['v'] = claims.v;
  }

  return {
    domain: ETH_AUTH_DOMAIN,
    types: { Claims: types },
    message,
    primaryType: 'Claims'
  };
}

function encodeClaimsToBase64(claims: Claims): string {
  const json = JSON.stringify(claims);
  return Buffer.from(json).toString('base64url');
}

export async function generateEthAuthProof(
  privateKey: string,
  customClaims?: Claims
): Promise<string> {
  const prefixedKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;

  const wallet = new ethers.Wallet(prefixedKey);
  const now = Math.floor(Date.now() / 1000);

  const claims: Claims = {
    app: customClaims?.app || 'sequence-builder',
    iat: customClaims?.iat || now,
    exp: customClaims?.exp || now + 3600,
    v: ETH_AUTH_VERSION,
    ...(customClaims?.n && { n: customClaims.n }),
    ...(customClaims?.typ && { typ: customClaims.typ }),
    ...(customClaims?.ogn && { ogn: customClaims.ogn })
  };

  const typedData = buildTypedData(claims);

  const signature = await wallet.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message
  );

  const address = wallet.address.toLowerCase();
  const encodedClaims = encodeClaimsToBase64(claims);
  return `${ETH_AUTH_PREFIX}.${address}.${encodedClaims}.${signature}`;
}

export async function generateEthAuthProofWithExpiration(
  privateKey: string,
  expirationSeconds = 3600
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return generateEthAuthProof(privateKey, {
    iat: now,
    exp: now + expirationSeconds
  });
}

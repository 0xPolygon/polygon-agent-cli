export interface ImplicitSession {
  pk: string;
  attestation: string;
  identity_sig: string;
  /** Optional fields preserved for Sequence wallet path compatibility */
  guard?: string;
  login_method?: string;
  user_email?: string;
}

export interface SessionPermissions {
  /** Max native token spend, as wei string */
  native_limit?: string;
  erc20_limits?: Array<{ token_address: string; limit: string }>;
  contract_calls?: Array<{ address: string; functions: string[] }>;
}

export interface SessionPayload {
  version: 1;
  wallet_address: string;
  chain_id: number;
  /** Hex-encoded explicit session private key */
  session_private_key: string;
  /** Explicit session signer address */
  session_address: string;
  permissions: SessionPermissions;
  /** Unix timestamp — expiry of explicit session */
  expiry: number;
  ecosystem_wallet_url: string;
  dapp_origin: string;
  project_access_key: string;
  relayer_url?: string;
  /** Full explicit session config, JSON-stringified (for dapp-client reconstruction) */
  session_config?: string;
  implicit_session?: ImplicitSession;
}

export interface EncryptedPayload {
  wallet_pk_hex: string;
  nonce_hex: string;
  ciphertext_b64url: string;
  code_hash_hex: string;
}

export interface RelayCreateResponse {
  request_id: string;
}

export interface RelayStatusResponse {
  status: 'pending' | 'ready';
}

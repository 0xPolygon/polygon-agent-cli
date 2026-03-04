// Ambient declarations for untyped dependencies

declare module 'tweetnacl-sealedbox-js' {
  export function open(
    ciphertext: Uint8Array,
    publicKey: Uint8Array,
    secretKey: Uint8Array
  ): Uint8Array | null;

  export function seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;

  export function overheadLength(): number;
}

declare module '@0xsequence/dapp-client-cli/dist/state.js' {
  export class StateManager {
    constructor(statePath: string, passphrase: string);
    update(fn: (state: unknown) => void): Promise<void>;
  }
}

declare module '@0xsequence/dapp-client-cli/dist/storage.js' {
  import type { StateManager } from '@0xsequence/dapp-client-cli/dist/state.js';

  export class FileSequenceStorage {
    constructor(stateManager: StateManager, opts?: { suppressPendingRedirect?: boolean });
    saveExplicitSession(session: unknown): Promise<void>;
    saveImplicitSession(session: unknown): Promise<void>;
    setPendingRedirectRequest(value: boolean): Promise<void>;
    savePendingRequest(value: unknown): Promise<void>;
    saveTempSessionPk(value: unknown): Promise<void>;
  }

  export class FileSessionStorage {
    constructor(stateManager: StateManager);
    removeItem(key: string): Promise<void>;
  }
}

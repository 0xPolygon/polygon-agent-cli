/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TRAILS_API_KEY?: string;
  readonly VITE_INDEXER_ACCESS_KEY?: string;
  readonly VITE_POLYGON_INDEXER_ACCESS_KEY?: string;
  readonly VITE_PROJECT_ACCESS_KEY?: string;
  readonly VITE_INDEXER_URL?: string;
  readonly VITE_OIDC_RELAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

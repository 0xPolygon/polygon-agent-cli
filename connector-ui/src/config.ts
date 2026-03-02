// Configured via VITE_WALLET_URL secret
const walletUrlRaw = import.meta.env.VITE_WALLET_URL as string
// Avoid double slashes in wallet routing (walletUrl should not end with /)
export const walletUrl = walletUrlRaw.replace(/\/+$/, '')

// If not explicitly provided, default to the current origin.
export const dappOrigin = (import.meta.env.VITE_DAPP_ORIGIN as string | undefined) || window.location.origin

export const projectAccessKey = import.meta.env.VITE_PROJECT_ACCESS_KEY as string
export const relayerUrl = (import.meta.env.VITE_RELAYER_URL as string | undefined) || undefined

// Pass the base gateway URL; the Sequence SDK composes the final URL with the access key.
export const nodesUrl =
  (import.meta.env.VITE_NODES_URL as string | undefined) || 'https://nodes.sequence.app/{network}'


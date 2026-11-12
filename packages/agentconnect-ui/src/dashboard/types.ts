export type Loadable<T> = { data: T | null; loading: boolean; error: boolean };

// Shared by every tab: the copy state.
export interface AgentContext {
  copied: string | null;
  copy: (id: string, text: string) => void;
}

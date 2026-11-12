export type Loadable<T> = { data: T | null; loading: boolean; error: boolean };

// The copy state, for the components that hand the user a prompt.
export interface AgentContext {
  copied: string | null;
  copy: (id: string, text: string) => void;
}

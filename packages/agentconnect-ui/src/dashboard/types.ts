export type Loadable<T> = { data: T | null; loading: boolean; error: boolean };

export interface AgentContext {
  copied: string | null;
  copy: (id: string, text: string) => void;
}

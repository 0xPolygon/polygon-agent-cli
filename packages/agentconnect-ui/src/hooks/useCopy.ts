import { useCallback, useEffect, useRef, useState } from 'react';

export function useCopy(): [string | null, (id: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((id: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(id);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1600);
  }, []);
  return [copied, copy];
}

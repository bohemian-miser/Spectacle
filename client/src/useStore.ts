import { useEffect, useState } from 'react';
import type { Store } from './store';

/** Re-render on every store change (cheap: the store batches per server message). */
export function useStore(store: Store): number {
  const [v, setV] = useState(store.version);
  useEffect(() => store.subscribe(() => setV(store.version)), [store]);
  return v;
}

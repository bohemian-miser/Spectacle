import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultRule, type PlayerRule } from '../../shared/game/rule';
import { Arena } from './Arena';
import { Lobby } from './Lobby';
import { Connection } from './net';
import { Store } from './store';
import { useStore } from './useStore';

type Screen = 'lobby' | 'arena';

function loadName(): string {
  try {
    return localStorage.getItem('spectacle.name') ?? '';
  } catch {
    return '';
  }
}

export function App(): JSX.Element {
  const store = useMemo(() => new Store(), []);
  const conn = useMemo(() => new Connection(store), [store]);
  useStore(store);
  const [screen, setScreen] = useState<Screen>('lobby');
  const [name, setName] = useState(loadName);
  const [rule, setRule] = useState<PlayerRule | null>(null);
  const joined = useRef(false);
  const retry = useRef(0);

  // Connect (and reconnect with backoff).
  useEffect(() => {
    let timer = 0;
    const connect = (): void => {
      conn.open(
        () => {
          retry.current = 0;
        },
        () => {
          joined.current = false;
          store.reset();
          setScreen('lobby');
          const delay = Math.min(10_000, 500 * 2 ** retry.current++);
          timer = window.setTimeout(connect, delay);
        },
      );
    };
    connect();
    return () => {
      window.clearTimeout(timer);
      conn.close();
    };
  }, [conn, store]);

  // Once we know the arena's family, offer a starting rule for it.
  useEffect(() => {
    if (store.hello && (!rule || rule.family !== store.hello.field.family)) setRule(defaultRule(store.hello.field.family));
  }, [store.hello, rule]);

  const enter = (): void => {
    if (!rule) return;
    try {
      localStorage.setItem('spectacle.name', name);
    } catch {
      /* private mode */
    }
    if (joined.current) conn.send({ t: 'rule', rule });
    else {
      conn.send({ t: 'join', name, rule });
      joined.current = true;
    }
    setScreen('arena');
  };

  if (screen === 'arena' && store.you) {
    return <Arena store={store} conn={conn} onNewRule={() => setScreen('lobby')} />;
  }
  return (
    <Lobby
      store={store}
      rule={rule ?? defaultRule('hex')}
      name={name}
      inArena={joined.current && !!store.you}
      onRule={setRule}
      onName={setName}
      onEnter={enter}
      onCancel={() => setScreen('arena')}
    />
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  benchmarkIdentity,
  createBrowserClient,
  type BrowserBenchmarkClient,
  type TransportChoice,
} from '../../../benchmark/client';

/**
 * Player benchmark page — DEVELOPMENT ONLY.
 *
 * This is the page to open on a phone. The "BUZZ" button is a network probe,
 * not the Family Feud buzzer.
 *
 * Clock sync here is FOR DISPLAY ONLY (ARCHITECTURE.md §6). The countdown is
 * rendered from an estimated offset so several phones agree visually, but the
 * server alone decides deadlines and who buzzed first.
 */

const SERVER = process.env['NEXT_PUBLIC_BENCHMARK_URL'] ?? 'http://localhost:4500';

interface StateResponse {
  paused: boolean;
  buzzerOpen: boolean;
  serverTime: number;
  timer: { active: boolean; remainingMs: number; paused: boolean };
}

export default function BenchmarkPlayerPage() {
  const [transport, setTransport] = useState<TransportChoice>('socketio');
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>(
    'disconnected',
  );
  const [state, setState] = useState<StateResponse | null>(null);
  const [rtt, setRtt] = useState<number | null>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const [lastAck, setLastAck] = useState('');
  const clientRef = useRef<BrowserBenchmarkClient | null>(null);
  const identity = useRef('');

  if (identity.current === '' && typeof window !== 'undefined') {
    identity.current = benchmarkIdentity('player');
  }

  useEffect(() => {
    const id = setInterval(() => {
      fetch(`${SERVER}/benchmark/state`, { cache: 'no-store' })
        .then((res) => res.json())
        .then((data: StateResponse) => setState(data))
        .catch(() => undefined);
    }, 400);
    return () => clearInterval(id);
  }, []);

  const connect = useCallback(async () => {
    clientRef.current?.disconnect();
    const client = createBrowserClient(transport, SERVER, {
      onStatus: setStatus,
      onEvent: () => undefined,
    });
    clientRef.current = client;
    try {
      await client.connect();
      await client.submit('BENCHMARK_HELLO', {
        benchmarkClientId: identity.current,
        isHost: false,
        label: `phone-${identity.current.slice(-4)}`,
      });
      setLastAck('Connected.');
    } catch (err) {
      setLastAck(`Connect failed: ${String(err)}`);
    }
  }, [transport]);

  /** RTT measured on one clock only, so no skew contaminates it. */
  const ping = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const sentAt = Date.now();
    try {
      await client.submit('BENCHMARK_PING', { pingId: String(sentAt), clientSentAt: sentAt });
      const receivedAt = Date.now();
      const roundTrip = receivedAt - sentAt;
      setRtt(roundTrip);
      if (state) {
        // Midpoint assumption; display only.
        setOffset(Math.round(state.serverTime - (sentAt + roundTrip / 2)));
      }
    } catch (err) {
      setLastAck(String(err));
    }
  }, [state]);

  const buzz = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const ack = await client.submit('BENCHMARK_BUZZ', { clientSentAt: Date.now() });
      setLastAck(ack.ok ? `ACCEPTED (seq ${ack.seq})` : `REJECTED: ${ack.error.code}`);
    } catch (err) {
      setLastAck(String(err));
    }
  }, []);

  return (
    <main style={{ padding: 16, fontFamily: 'system-ui, sans-serif', maxWidth: 480 }}>
      <h1 style={{ fontSize: 20, marginTop: 12 }}>Benchmark Player</h1>

      <section style={card}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['socketio', 'websocket'] as const).map((choice) => (
            <label key={choice} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input type="radio" checked={transport === choice} onChange={() => setTransport(choice)} />
              {choice}
            </label>
          ))}
        </div>
        <button style={{ ...button, width: '100%', marginTop: 10 }} onClick={() => void connect()}>
          Connect
        </button>
        <p style={{ margin: '8px 0 0', color: status === 'connected' ? '#5ec27e' : '#d1495b' }}>
          {status}
        </p>
        <p style={muted}>ID: {identity.current}</p>
      </section>

      <section style={card}>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 14 }}>
          <span style={muted}>Timer</span>
          <span>
            {state?.timer.active
              ? `${Math.ceil(state.timer.remainingMs / 1000)}s${state.timer.paused ? ' (PAUSED)' : ''}`
              : 'inactive'}
          </span>
          <span style={muted}>Buzzer</span>
          <span style={{ color: state?.buzzerOpen ? '#5ec27e' : '#9a9aa6' }}>
            {state?.buzzerOpen ? 'OPEN' : 'closed'}
          </span>
          <span style={muted}>RTT</span><span>{rtt === null ? '—' : `${rtt} ms`}</span>
          <span style={muted}>Clock offset</span>
          <span>{offset === null ? '—' : `${offset} ms (display only)`}</span>
        </div>
        <button style={{ ...button, width: '100%', marginTop: 10 }} onClick={() => void ping()}>
          Measure RTT
        </button>
      </section>

      <button
        style={{
          ...button,
          width: '100%',
          padding: 26,
          fontSize: 20,
          marginTop: 14,
          background: state?.buzzerOpen ? '#2f6b45' : '#2f2f3d',
        }}
        onClick={() => void buzz()}
      >
        BENCHMARK BUZZ
      </button>
      <p style={muted}>Network probe only. Not the Family Feud buzzer.</p>

      {lastAck !== '' && (
        <section style={card}>
          <span style={muted}>Last acknowledgement</span>
          <p style={{ margin: '4px 0 0', fontFamily: 'monospace', fontSize: 13 }}>{lastAck}</p>
        </section>
      )}
    </main>
  );
}

const card = {
  border: '1px solid #2c2c36',
  background: '#17171d',
  borderRadius: 8,
  padding: 14,
  marginTop: 14,
} as const;
const muted = { color: '#9a9aa6', fontSize: 12 } as const;
const button = {
  padding: '9px 12px',
  background: '#2f2f3d',
  color: '#f2f2f5',
  border: '1px solid #45455a',
  borderRadius: 5,
  cursor: 'pointer',
  fontSize: 14,
} as const;

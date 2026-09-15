'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventEnvelope } from '@bb/protocol';
import {
  benchmarkIdentity,
  createBrowserClient,
  type BrowserBenchmarkClient,
  type TransportChoice,
} from '../../../benchmark/client';

/**
 * Host benchmark panel — DEVELOPMENT ONLY.
 *
 * Deliberately unstyled beyond legibility. These are not the real Host
 * controls; Host game tooling is a much later phase.
 */

const SERVER = process.env['NEXT_PUBLIC_BENCHMARK_URL'] ?? 'http://localhost:4500';

interface SnapshotState {
  seq: number;
  serverTime: number;
  paused: boolean;
  pauseReason: 'host_requested' | 'player_disconnect' | null;
  pausedByClientId: string | null;
  buzzerOpen: boolean;
  buzzerRound: number;
  acceptedBuzz: { benchmarkClientId: string; elapsedSinceOpenMs: number } | null;
  timer: { active: boolean; durationMs: number; remainingMs: number; paused: boolean };
  clients: { benchmarkClientId: string; connected: boolean; isHost: boolean; label: string }[];
}

export default function BenchmarkHostPage() {
  const [transport, setTransport] = useState<TransportChoice>('socketio');
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>(
    'disconnected',
  );
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [snapshot, setSnapshot] = useState<SnapshotState | null>(null);
  const [lastMessage, setLastMessage] = useState<string>('');
  const clientRef = useRef<BrowserBenchmarkClient | null>(null);

  // Resolved client-side only, after mount — see the identical comment in
  // benchmark/player/page.tsx. This page happened not to trigger a hydration
  // mismatch because it never rendered identity.current in JSX before mount,
  // but computing it during render was equally unsafe here.
  const [identityValue, setIdentityValue] = useState('');
  useEffect(() => {
    setIdentityValue(benchmarkIdentity('host'));
  }, []);
  const identity = useRef<string>('');
  identity.current = identityValue;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER}/benchmark/state`, { cache: 'no-store' });
      setSnapshot((await res.json()) as SnapshotState);
    } catch {
      /* server not running */
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => void refresh(), 500);
    return () => clearInterval(id);
  }, [refresh]);

  const connect = useCallback(async () => {
    clientRef.current?.disconnect();
    const client = createBrowserClient(transport, SERVER, {
      onStatus: setStatus,
      onEvent: (event) => setEvents((prev) => [event, ...prev].slice(0, 25)),
    });
    clientRef.current = client;
    try {
      await client.connect();
      await client.submit('BENCHMARK_HELLO', {
        benchmarkClientId: identity.current,
        isHost: true,
        label: 'browser-host',
      });
      setLastMessage('Connected as benchmark Host.');
    } catch (err) {
      setLastMessage(`Connect failed: ${String(err)}`);
    }
  }, [transport]);

  const send = useCallback(async (type: string, payload: unknown = {}) => {
    const client = clientRef.current;
    if (!client) {
      setLastMessage('Not connected.');
      return;
    }
    try {
      const ack = await client.submit(type, payload);
      setLastMessage(ack.ok ? `${type}: accepted (seq ${ack.seq})` : `${type}: ${ack.error.code} — ${ack.error.message}`);
    } catch (err) {
      setLastMessage(`${type}: ${String(err)}`);
    }
    void refresh();
  }, [refresh]);

  return (
    <main style={{ padding: 16, fontFamily: 'system-ui, sans-serif', maxWidth: 900 }}>
      <h1 style={{ fontSize: 22, marginTop: 12 }}>Benchmark Host Panel</h1>

      <section style={card}>
        <h2 style={h2}>Transport</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['socketio', 'websocket'] as const).map((choice) => (
            <label key={choice} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="radio"
                checked={transport === choice}
                onChange={() => setTransport(choice)}
              />
              {choice}
            </label>
          ))}
          <button style={button} onClick={() => void connect()}>
            Connect
          </button>
          <span style={{ color: status === 'connected' ? '#5ec27e' : '#d1495b' }}>{status}</span>
        </div>
        <p style={muted}>Server: {SERVER}</p>
      </section>

      <section style={card}>
        <h2 style={h2}>Controls</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={button} onClick={() => void send('BENCHMARK_START_TIMER', { durationMs: 30000 })}>
            Start timer test (30s)
          </button>
          <button style={button} onClick={() => void send('BENCHMARK_OPEN_BUZZER')}>
            Open benchmark buzzer
          </button>
          <button style={button} onClick={() => void send('BENCHMARK_RESET_BUZZER')}>
            Reset benchmark buzzer
          </button>
          <button style={button} onClick={() => void send('BENCHMARK_PAUSE')}>
            Pause
          </button>
          <button style={button} onClick={() => void send('BENCHMARK_RESUME')}>
            Resume (Host only)
          </button>
          <button style={button} onClick={() => void send('BENCHMARK_CLEAR_STATS')}>
            Clear statistics
          </button>
        </div>
        {lastMessage !== '' && <p style={{ marginTop: 10, fontSize: 13 }}>{lastMessage}</p>}
      </section>

      <section style={card}>
        <h2 style={h2}>Server state</h2>
        {snapshot === null ? (
          <p style={muted}>No benchmark server. Run: pnpm benchmark:server</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 14 }}>
            <span style={muted}>Sequence</span><span>{snapshot.seq}</span>
            <span style={muted}>Server time</span><span>{snapshot.serverTime}</span>
            <span style={muted}>Status</span>
            <span style={{ color: snapshot.paused ? '#d99a2b' : '#5ec27e', fontWeight: 600 }}>
              {snapshot.paused
                ? snapshot.pauseReason === 'player_disconnect'
                  ? `PAUSED — player disconnected (${snapshot.pausedByClientId ?? 'unknown'})`
                  : 'PAUSED — Host requested'
                : 'ACTIVE'}
            </span>
            <span style={muted}>Buzzer</span>
            <span>{snapshot.buzzerOpen ? `OPEN (round ${snapshot.buzzerRound})` : 'closed'}</span>
            <span style={muted}>Accepted buzz</span>
            <span>
              {snapshot.acceptedBuzz
                ? `${snapshot.acceptedBuzz.benchmarkClientId} (+${snapshot.acceptedBuzz.elapsedSinceOpenMs}ms)`
                : '—'}
            </span>
            <span style={muted}>Timer</span>
            <span>
              {snapshot.timer.active
                ? `${Math.ceil(snapshot.timer.remainingMs / 1000)}s remaining${snapshot.timer.paused ? ' (PAUSED)' : ''}`
                : 'inactive'}
            </span>
          </div>
        )}
      </section>

      <section style={card}>
        <h2 style={h2}>Benchmark clients ({snapshot?.clients.length ?? 0})</h2>
        {(snapshot?.clients ?? []).map((client) => (
          <div key={client.benchmarkClientId} style={{ fontSize: 13, padding: '2px 0' }}>
            <span style={{ color: client.connected ? '#5ec27e' : '#d1495b' }}>●</span>{' '}
            {client.label} {client.isHost && '(host)'}{' '}
            <span style={muted}>{client.benchmarkClientId}</span>
          </div>
        ))}
      </section>

      <section style={card}>
        <h2 style={h2}>Recent events</h2>
        <div style={{ fontFamily: 'monospace', fontSize: 12, maxHeight: 220, overflowY: 'auto' }}>
          {events.length === 0 && <p style={muted}>None yet.</p>}
          {events.map((event) => (
            <div key={`${event.seq}-${event.type}`} style={{ padding: '1px 0' }}>
              #{event.seq} {event.type}
            </div>
          ))}
        </div>
      </section>
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

const h2 = { fontSize: 15, margin: '0 0 10px' } as const;
const muted = { color: '#9a9aa6', fontSize: 13 } as const;
const button = {
  padding: '7px 12px',
  background: '#2f2f3d',
  color: '#f2f2f5',
  border: '1px solid #45455a',
  borderRadius: 5,
  cursor: 'pointer',
  fontSize: 13,
} as const;

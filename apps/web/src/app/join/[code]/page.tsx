'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { DISPLAY_NAME_MAX_LENGTH, type EventEnvelope, type LobbySnapshot } from '@bb/protocol';
import {
  BrowserRoomClient,
  clearIdentity,
  loadIdentity,
  type ConnectionStatus,
} from '../../../rooms/client';
import { serverUrl } from '../../../rooms/config';
import { PlayerLobby } from '../../../rooms/PlayerLobby';
import * as ui from '../../../rooms/ui';

/**
 * The page a QR code opens: /join/<ROOMCODE>.
 *
 * Two jobs. First, restore a player who already belongs to this room — a
 * refresh, a reopened browser, a phone coming back from sleep — WITHOUT asking
 * for a name again and without creating a second player. Only if that fails does
 * it ask for a name.
 *
 * The room code comes from the URL, so a scanned QR needs no typing at all.
 */
export default function JoinPage() {
  const params = useParams<{ code: string }>();
  const roomCode = (params.code ?? '').toUpperCase();

  const [snapshot, setSnapshot] = useState<LobbySnapshot | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [evicted, setEvicted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Null until the restore attempt finishes, so the form does not flash on
  // screen for a player who is about to be restored automatically.
  const [checkedStorage, setCheckedStorage] = useState(false);

  const clientRef = useRef<BrowserRoomClient | null>(null);

  useEffect(() => {
    // Client-side only: localStorage and WebSocket do not exist during SSR, and
    // reading them while rendering caused a hydration mismatch in Phase 3.
    const client = new BrowserRoomClient(serverUrl(), {
      onSnapshot: setSnapshot,
      onEvent: (event: EventEnvelope) => {
        // Any room-state event may change what this player should see. The
        // snapshot is authoritative, so re-read rather than patching locally.
        if (event.type.startsWith('PLAYER_') || event.type.startsWith('TEAM')) {
          void client.refreshSnapshot();
        }
      },
      onStatus: setStatus,
      onEvicted: (reason) => {
        setEvicted(reason);
        setSnapshot(null);
      },
    });
    clientRef.current = client;

    void client
      .connect()
      .then(async () => {
        const stored = loadIdentity(roomCode);
        if (stored !== null) {
          const ack = await client.resumeIdentity(stored);
          if (!ack.ok) {
            // Credential rejected: left, removed, or the server restarted and
            // lost every room. Fall through to the join form.
            setError(null);
          }
        }
      })
      .catch(() => setError('Could not reach the game server.'))
      .finally(() => setCheckedStorage(true));

    return () => client.disconnect();
  }, [roomCode]);

  const handleJoin = useCallback(async () => {
    const client = clientRef.current;
    if (client === null) return;

    setBusy(true);
    setError(null);
    const ack = await client.join(roomCode, displayName);
    setBusy(false);

    if (!ack.ok) setError(ack.error.message);
  }, [displayName, roomCode]);

  const handleLeave = useCallback(async () => {
    const client = clientRef.current;
    if (client === null) return;
    await client.leave();
    clearIdentity(roomCode);
    setSnapshot(null);
    setEvicted('You left the room.');
  }, [roomCode]);

  if (evicted !== null) {
    return (
      <main style={ui.page}>
        <div style={ui.card}>
          <h1 style={ui.title}>BRAINS &amp; BACCHANAL</h1>
          <p style={ui.tagline}>Where knowledge meets foolishness</p>
          <p style={{ textAlign: 'center' }}>{evicted}</p>
          <button
            type="button"
            style={ui.button}
            onClick={() => {
              setEvicted(null);
              window.location.reload();
            }}
          >
            Join again
          </button>
        </div>
      </main>
    );
  }

  if (snapshot !== null) {
    return <PlayerLobby snapshot={snapshot} status={status} onLeave={handleLeave} />;
  }

  return (
    <main style={ui.page}>
      <div style={ui.card}>
        <h1 style={ui.title}>BRAINS &amp; BACCHANAL</h1>
        <p style={ui.tagline}>Where knowledge meets foolishness</p>

        <p style={{ ...ui.label, textAlign: 'center' }}>Room</p>
        <p style={{ ...ui.roomCode, marginTop: 0, marginBottom: ui.SPACING.lg }}>{roomCode}</p>

        {!checkedStorage ? (
          <p style={{ ...ui.muted, textAlign: 'center' }}>Connecting…</p>
        ) : (
          <>
            <label style={ui.label} htmlFor="displayName">
              Your name
            </label>
            <input
              id="displayName"
              style={ui.input}
              value={displayName}
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && displayName.trim() !== '') void handleJoin();
              }}
              placeholder="e.g. Javal"
              autoComplete="off"
              // Phones default to a capitalised first letter for names, which
              // is what people want here.
              autoCapitalize="words"
            />

            <div style={{ marginTop: ui.SPACING.lg }}>
              <button
                type="button"
                style={{
                  ...ui.button,
                  opacity: busy || displayName.trim() === '' ? 0.5 : 1,
                }}
                disabled={busy || displayName.trim() === ''}
                onClick={() => void handleJoin()}
              >
                {busy ? 'Joining…' : 'Join game'}
              </button>
            </div>

            {error !== null && <p style={ui.errorText}>{error}</p>}
          </>
        )}
      </div>
    </main>
  );
}

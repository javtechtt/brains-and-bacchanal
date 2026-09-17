'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  DISPLAY_NAME_MAX_LENGTH,
  type EventEnvelope,
  type LobbySnapshot,
  type PlayerGameSnapshot,
} from '@bb/protocol';
import {
  BrowserRoomClient,
  clearIdentity,
  loadIdentity,
  type ConnectionStatus,
} from '../../../rooms/client';
import { serverUrl } from '../../../rooms/config';
import { PlayerGame } from '../../../rooms/PlayerGame';
import { PlayerLobby } from '../../../rooms/PlayerLobby';
import * as ui from '../../../rooms/ui';

/**
 * Event names that mean "the game state changed".
 *
 * Matched by prefix rather than listed exhaustively, so a Phase 6 event does not
 * silently fail to refresh a phone. The payloads themselves are never
 * interpreted here — the phone re-reads the authoritative snapshot instead,
 * which is what keeps round knowledge out of the client entirely.
 *
 * PHASE 6 ADDITIONS. The comment above already stated this intent when Phase 5
 * shipped, but the list itself was never actually extended when the shared
 * systems arrived — every Phase 6 event (a card dealt, a Clash opening or
 * resolving, the Market opening/closing, a Maco Mail draw, an advantage used, a
 * Host Deal or a wager) fell through this filter unmatched. A phone's own
 * REQUEST_GAME_SNAPSHOT reply still updated the screen, and the next matched
 * event (a BB change, say) would drag a stale card/Market view along with it —
 * which is why the symptom looked like "needs a refresh, or a few other actions
 * first" rather than "never updates at all". See packages/protocol/src/
 * shared-systems.ts SHARED_EVENTS for the full set these prefixes must cover.
 */
const GAME_EVENT_PREFIXES = [
  'GAME_',
  'BB_',
  'CHALLENGE_',
  'TURN_',
  'TIMER_',
  'ACTIVE_PLAYERS_',
  'HOST_RULING',
  'PHASE_',
  'REVIEW_',
  'BACCHANAL_',
  'CARD_',
  'CLASH_',
  'PART_DAT_FIGHT',
  'MARKET_',
  'MACO_MAIL_',
  'ADVANTAGE_',
  'HELD_EFFECT_',
  'HOST_DEAL_',
  'WAGER_',
];

/**
 * The page a QR code opens: /join/<ROOMCODE>.
 *
 * Two jobs. First, restore a player who already belongs to this room — a
 * refresh, a reopened browser, a phone coming back from sleep — WITHOUT asking
 * for a name again and without creating a second player. Only if that fails does
 * it ask for a name.
 *
 * Once the Host starts the game it switches from the lobby view to the generic
 * game view; a mid-game refresh comes back INTO the game, not to a waiting
 * screen.
 *
 * The room code comes from the URL, so a scanned QR needs no typing at all.
 */
export default function JoinPage() {
  const params = useParams<{ code: string }>();
  const roomCode = (params.code ?? '').toUpperCase();

  const [snapshot, setSnapshot] = useState<LobbySnapshot | null>(null);
  // Non-null once a game is running. The page shows the game view in
  // preference to the lobby, so a player leaves the waiting screen the moment
  // the Host starts.
  const [game, setGame] = useState<PlayerGameSnapshot | null>(null);
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
      onGameSnapshot: setGame,
      onEvent: (event: EventEnvelope) => {
        // Any room-state event may change what this player should see. The
        // snapshot is authoritative, so re-read rather than patching locally.
        if (event.type.startsWith('PLAYER_') || event.type.startsWith('TEAM')) {
          void client.refreshSnapshot();
        }

        // Gameplay events all resolve to "the game state changed"; the phone
        // re-reads rather than interpreting each payload, which keeps round
        // knowledge out of the client entirely.
        if (GAME_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix))) {
          void client.refreshGameSnapshot();
        }
      },
      onStatus: setStatus,
      onEvicted: (reason) => {
        setEvicted(reason);
        setSnapshot(null);
        setGame(null);
      },
    });
    clientRef.current = client;

    void client
      .connect()
      .then(async () => {
        const stored = loadIdentity(roomCode);
        if (stored !== null) {
          // resumeIdentity re-reads the game snapshot itself, so a refresh
          // mid-game comes back INTO the game rather than to a waiting screen.
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

    if (!ack.ok) {
      setError(ack.error.message);
      return;
    }
    // Covers the rare case of joining a room whose game has already begun.
    await client.refreshGameSnapshot();
  }, [displayName, roomCode]);

  const handleLeave = useCallback(async () => {
    const client = clientRef.current;
    if (client === null) return;
    await client.leave();
    clearIdentity(roomCode);
    setSnapshot(null);
    setGame(null);
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

  // The game view wins while a game is running; the lobby is what comes before.
  if (game !== null && game.game !== null) {
    return (
      <PlayerGame
        snapshot={game}
        status={status}
        // Phase 6: a team acts on its own behalf — a card, a purchase, a deal
        // answer, a wager. The server still decides every one of them; this only
        // carries the request. After it lands, the snapshot is refreshed so the
        // phone renders the SERVER's new state rather than assuming its own.
        submit={async (type, payload) => {
          const client = clientRef.current;
          if (client === null) return { ok: false, message: 'Not connected.' };
          const ack = await client.submit(type, payload);
          await client.refreshGameSnapshot();
          return ack.ok
            ? { ok: true }
            : { ok: false, message: ack.error.message };
        }}
      />
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

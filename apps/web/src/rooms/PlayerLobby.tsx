'use client';

import { DEFAULT_TEAM_LABELS, type LobbySnapshot } from '@bb/protocol';
import type { ConnectionStatus } from './client';
import * as ui from './ui';

/**
 * The player's lobby view.
 *
 * Shows ONLY what a player is entitled to know: the room, their own name, their
 * team, and whether teams are locked. No Host controls, and nothing about
 * gameplay — there is none yet, and CONTENT_POLICY.md forbids sending players
 * anything unrevealed even once there is.
 *
 * A player cannot change their own team here. Team assignment is the Host's
 * (Phase 4 spec §12), and the server enforces that regardless of what any UI
 * offers.
 */
export function PlayerLobby({
  snapshot,
  status,
  onLeave,
}: {
  snapshot: LobbySnapshot;
  status: ConnectionStatus;
  onLeave: () => void;
}) {
  const me = snapshot.players.find((p) => p.playerId === snapshot.you);
  const teamId = me?.teamId ?? null;
  const teamLabel =
    teamId === null
      ? null
      : (DEFAULT_TEAM_LABELS[teamId as keyof typeof DEFAULT_TEAM_LABELS] ?? teamId);

  return (
    <main style={ui.page}>
      <div style={ui.card}>
        <h1 style={ui.title}>BRAINS &amp; BACCHANAL</h1>
        <p style={ui.tagline}>Where knowledge meets foolishness</p>

        <p style={{ ...ui.label, textAlign: 'center' }}>Room</p>
        <p style={{ ...ui.roomCode, marginTop: 0 }}>{snapshot.room.roomCode}</p>

        <div
          style={{
            textAlign: 'center',
            marginTop: ui.SPACING.lg,
            paddingTop: ui.SPACING.lg,
            borderTop: `1px solid ${ui.COLOR.border}`,
          }}
        >
          <p
            style={{
              fontSize: ui.FONT_SIZE.xl,
              fontWeight: ui.FONT_WEIGHT.bold,
              margin: 0,
            }}
          >
            {me?.displayName ?? 'Player'}
          </p>

          {teamLabel === null ? (
            <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>Waiting to be put on a team…</p>
          ) : (
            <p
              style={{
                fontSize: ui.FONT_SIZE.lg,
                fontWeight: ui.FONT_WEIGHT.bold,
                color: ui.COLOR.accent,
                marginTop: ui.SPACING.sm,
                letterSpacing: 2,
                textTransform: 'uppercase',
              }}
            >
              {teamLabel}
            </p>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: ui.SPACING.sm,
            marginTop: ui.SPACING.lg,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: ui.RADIUS.pill,
              background: ui.statusColor(status),
              display: 'inline-block',
            }}
          />
          <span style={ui.muted}>
            {status === 'connected'
              ? 'Connected'
              : status === 'reconnecting'
                ? 'Reconnecting…'
                : status === 'connecting'
                  ? 'Connecting…'
                  : 'Offline — trying to reconnect'}
          </span>
        </div>

        <p
          style={{
            ...ui.muted,
            textAlign: 'center',
            marginTop: ui.SPACING.lg,
            paddingTop: ui.SPACING.md,
            borderTop: `1px solid ${ui.COLOR.border}`,
          }}
        >
          {snapshot.room.teamsLocked
            ? 'Teams are locked. Waiting for the Host to start…'
            : 'Waiting for the Host…'}
        </p>

        <div style={{ marginTop: ui.SPACING.lg }}>
          <button
            type="button"
            style={ui.secondaryButton}
            onClick={() => {
              // Leaving is deliberate and irreversible — it destroys the
              // reconnect credential — so it is worth one confirmation.
              if (window.confirm('Leave the game? You will need to join again.')) onLeave();
            }}
          >
            Leave game
          </button>
        </div>
      </div>
    </main>
  );
}

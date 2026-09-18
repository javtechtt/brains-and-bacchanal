'use client';

import { DEFAULT_TEAM_LABELS, type PlayerGameSnapshot } from '@bb/protocol';
import { useEffect, useState } from 'react';
import type { ConnectionStatus } from './client';
import { PlayerRound2 } from './PlayerRound2';
import { PlayerRound1 } from './PlayerRound1';
import { PlayerRound3 } from './PlayerRound3';
import { PlayerRound4 } from './PlayerRound4';
import { PlayerSuddenDeath } from './PlayerSuddenDeath';
import { PlayerSharedSystems } from './PlayerSharedSystems';
import * as ui from './ui';

/**
 * The player's in-game view.
 *
 * Minimal on purpose (Phase 5 spec §23): team, BB, phase, whose turn it is,
 * the timer and whether the game is paused. There is no question, no answer
 * box, no card and no buzzer — those belong to the rounds, which do not exist
 * yet and several of whose rules are still open.
 *
 * CONTENT SAFETY: this renders only what the player-safe snapshot carries, and
 * that snapshot has nowhere to put an unrevealed answer. No Host controls
 * appear here at any time, because a phone has no authority to begin with —
 * the server refuses a Host intent from a player connection whatever this UI
 * offers.
 */
export function PlayerGame({
  snapshot,
  status,
  submit,
}: {
  snapshot: PlayerGameSnapshot;
  status: ConnectionStatus;
  /**
   * Send an intent on this player's behalf. Phase 6.
   *
   * A team decides its own card, purchase, deal answer and wager; the server
   * decides whether any of that is legal. This only carries the request and
   * reports what came back.
   */
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const me = snapshot.players.find((p) => p.playerId === snapshot.you);
  const teamId = snapshot.yourTeamId;
  const team = snapshot.teams.find((t) => t.teamId === teamId);
  const teamLabel =
    teamId === null
      ? 'No team'
      : (DEFAULT_TEAM_LABELS[teamId as keyof typeof DEFAULT_TEAM_LABELS] ?? teamId);

  const game = snapshot.game;
  const paused = game?.paused ?? false;

  return (
    <main style={ui.page}>
      <div style={ui.card}>
        <h1 style={ui.title}>BRAINS &amp; BACCHANAL</h1>
        <p style={ui.tagline}>Where knowledge meets foolishness</p>

        <div style={{ textAlign: 'center' }}>
          <p
            style={{
              fontSize: ui.FONT_SIZE.lg,
              fontWeight: ui.FONT_WEIGHT.bold,
              color: ui.COLOR.accent,
              letterSpacing: 2,
              textTransform: 'uppercase',
              margin: 0,
            }}
          >
            {teamLabel}
          </p>
          <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>{me?.displayName ?? 'Player'}</p>

          {/* The single number that matters to a player. Server-authoritative:
              this is displayed, never calculated here. */}
          <p
            style={{
              fontSize: ui.FONT_SIZE.xxl,
              fontWeight: ui.FONT_WEIGHT.bold,
              margin: `${ui.SPACING.md}px 0 0`,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {(team?.bb ?? 0).toLocaleString()} <span style={{ fontSize: ui.FONT_SIZE.md }}>BB</span>
          </p>
        </div>

        <div
          style={{
            marginTop: ui.SPACING.lg,
            paddingTop: ui.SPACING.lg,
            borderTop: `1px solid ${ui.COLOR.border}`,
            textAlign: 'center',
          }}
        >
          {paused ? <PausedNotice /> : <PlayStatus snapshot={snapshot} />}
        </div>

        {/* PHASE 7C — Round 1. Null in every other round, so no round can
            inherit another's screen. */}
        {game?.round1 !== null && game?.round1 !== undefined && (
          <PlayerRound1
            round1={game.round1}
            yourTeamId={teamId}
            paused={paused}
            {...(submit === undefined ? {} : { submit })}
          />
        )}

        {/* PHASE 7A — Round 2. Rendered only while Round 2 is being played;
            `round2` is null in every other round, so no other round inherits
            this screen. */}
        {game?.round2 !== null && game?.round2 !== undefined && (
          <PlayerRound2 round2={game.round2} yourTeamId={teamId} />
        )}

        {/* PHASE 7B — Round 3. Null in every other round. */}
        {game?.round3 !== null && game?.round3 !== undefined && (
          <PlayerRound3
            round3={game.round3}
            yourTeamId={teamId}
            paused={paused}
            {...(submit === undefined ? {} : { submit })}
          />
        )}

        {/* PHASE 7D-B — Round 4, Family Feud. Null in every other round. */}
        {game?.round4 !== null && game?.round4 !== undefined && (
          <PlayerRound4
            round4={game.round4}
            teams={snapshot.teams}
            yourTeamId={teamId}
            yourPlayerId={snapshot.you}
            paused={paused}
            {...(submit === undefined ? {} : { submit })}
          />
        )}

        {/* PHASE 7D-B2 — Sudden Death. §21 / D-034. Null outside Sudden Death. */}
        {game?.suddenDeath !== null && game?.suddenDeath !== undefined && (
          <PlayerSuddenDeath
            suddenDeath={game.suddenDeath}
            yourTeamId={teamId}
            paused={paused}
            {...(submit === undefined ? {} : { submit })}
          />
        )}

        {/* Other teams' balances. Not secret — a party game shows the scores —
            and useful on a phone when the TV is behind you. */}
        <div
          style={{
            marginTop: ui.SPACING.lg,
            paddingTop: ui.SPACING.md,
            borderTop: `1px solid ${ui.COLOR.border}`,
          }}
        >
          {snapshot.teams.map((t) => (
            <div
              key={t.teamId}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: `${ui.SPACING.xs}px 0`,
                opacity: t.teamId === teamId ? 1 : 0.6,
              }}
            >
              <span style={ui.muted}>{t.displayName}</span>
              <span style={{ ...ui.muted, fontVariantNumeric: 'tabular-nums' }}>
                {t.bb.toLocaleString()} BB
              </span>
            </div>
          ))}
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
            {status === 'connected' ? 'Connected' : 'Reconnecting…'}
          </span>
        </div>

        {/* PHASE 6 TEST UI. Rendered only when the player's team actually has
            shared-system state — before HOST_DEAL_BACCHANAL_CARDS there is
            nothing to show, and an empty panel would just be noise. */}
        {snapshot.shared !== null && submit !== undefined && (
          <PlayerSharedSystems shared={snapshot.shared} paused={paused} submit={submit} />
        )}
      </div>
    </main>
  );
}

/**
 * What the player should be doing.
 *
 * Deliberately vague about the challenge itself: the engine is generic, so
 * "your turn" is as specific as Phase 5 can honestly be.
 */
function PlayStatus({ snapshot }: { snapshot: PlayerGameSnapshot }) {
  const game = snapshot.game;
  if (game === null) {
    return <p style={ui.muted}>Waiting for the Host to start…</p>;
  }

  return (
    <>
      {snapshot.yourTurn ? (
        <p
          style={{
            fontSize: ui.FONT_SIZE.lg,
            fontWeight: ui.FONT_WEIGHT.bold,
            color: ui.COLOR.success,
            margin: 0,
          }}
        >
          YOUR TURN
        </p>
      ) : (
        <p style={{ ...ui.muted, margin: 0 }}>Waiting for the Host…</p>
      )}

      {game.challenge?.timer !== undefined && game.challenge?.timer !== null && (
        <TimerDisplay
          remainingMs={game.challenge.timer.remainingMs}
          paused={game.challenge.timer.paused}
          key={game.challenge.timer.timerId}
        />
      )}

      <p style={{ ...ui.muted, marginTop: ui.SPACING.md, fontSize: ui.FONT_SIZE.xs }}>
        {game.phase.replace(/_/g, ' ')}
      </p>
    </>
  );
}

/**
 * A local countdown.
 *
 * ARCHITECTURE.md §6 — this interpolates between server updates purely so the
 * number moves smoothly; it NEVER decides that time ran out. Expiry is the
 * server's, announced as an event. The display floors at zero and waits.
 */
function TimerDisplay({ remainingMs, paused }: { remainingMs: number; paused: boolean }) {
  const [displayMs, setDisplayMs] = useState(remainingMs);

  useEffect(() => {
    setDisplayMs(remainingMs);

    // A paused timer holds still. The server banks the remaining time and
    // excludes the pause from elapsed time, so counting down here would
    // contradict it — and would show a player's clock draining while the game
    // is stopped waiting for them.
    if (paused) return undefined;

    const startedAt = Date.now();
    const id = setInterval(() => {
      setDisplayMs(Math.max(0, remainingMs - (Date.now() - startedAt)));
    }, 100);
    return () => clearInterval(id);
  }, [remainingMs, paused]);

  return (
    <p
      style={{
        fontSize: ui.FONT_SIZE.xxl,
        fontWeight: ui.FONT_WEIGHT.bold,
        margin: `${ui.SPACING.md}px 0 0`,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {Math.ceil(displayMs / 1_000)}
    </p>
  );
}

/**
 * The pause overlay.
 *
 * D-011 — only the Host resumes, so this offers the player nothing to do. It
 * says so plainly, because a phone that simply froze would look broken.
 */
function PausedNotice() {
  return (
    <>
      <p
        style={{
          fontSize: ui.FONT_SIZE.lg,
          fontWeight: ui.FONT_WEIGHT.bold,
          color: ui.COLOR.warning,
          margin: 0,
        }}
      >
        GAME PAUSED
      </p>
      <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>
        Waiting for the Host to resume.
      </p>
    </>
  );
}

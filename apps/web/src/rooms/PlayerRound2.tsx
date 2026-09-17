'use client';

import {
  DEFAULT_TEAM_LABELS,
  ROUND2_CHALLENGE_COUNT,
  type Round2StateView,
  type TeamId,
} from '@bb/protocol';
import * as ui from './ui';

/**
 * The player's Round 2 screen. Phase 7A spec §20.
 *
 * ================== NO CONTROL FOR THE PHYSICAL GAME ==================
 * §20 — "Do not provide digital controls for performing the physical challenge
 * itself." There is no button here to grab, bomb, match or battle, no timer to
 * start and no score to submit. D-003 puts the game itself in the room, not in
 * the phone.
 *
 * What a phone IS for during Round 2: knowing which game is on, what your team
 * is worth, whether a card can be played, and what the result was. That is what
 * this renders.
 * =====================================================================
 *
 * Everything shown comes from the server's player-safe snapshot. `Round2StateView`
 * is entirely public — which game, who won, what was paid — so nothing here
 * needs to be filtered; the secrets (hands, hidden purchases, unrevealed Clash
 * responses) live in the Phase 6 view and are rendered by `PlayerSharedSystems`.
 */
export function PlayerRound2({
  round2,
  yourTeamId,
}: {
  round2: Round2StateView;
  yourTeamId: TeamId | null;
}) {
  const current = round2.current;

  return (
    <div
      style={{
        marginTop: ui.SPACING.lg,
        paddingTop: ui.SPACING.lg,
        borderTop: `1px solid ${ui.COLOR.border}`,
      }}
    >
      <p
        style={{
          ...ui.muted,
          textAlign: 'center',
          letterSpacing: 2,
          textTransform: 'uppercase',
          margin: 0,
        }}
      >
        Round 2 · Shake Up Yuhself
      </p>

      {round2.complete ? (
        <RoundComplete round2={round2} yourTeamId={yourTeamId} />
      ) : (
        <CurrentChallenge round2={round2} yourTeamId={yourTeamId} />
      )}

      <Progress round2={round2} />

      {/* Results so far. A phone is useful when the TV is behind you. */}
      {round2.resolvedCount > 0 && <ResultList round2={round2} yourTeamId={yourTeamId} />}

      {current !== null && (
        <p
          style={{
            ...ui.muted,
            textAlign: 'center',
            marginTop: ui.SPACING.md,
            fontSize: ui.FONT_SIZE.xs,
          }}
        >
          The Host runs this game in the room and decides the winner.
        </p>
      )}
    </div>
  );
}

function CurrentChallenge({
  round2,
  yourTeamId,
}: {
  round2: Round2StateView;
  yourTeamId: TeamId | null;
}) {
  const current = round2.current;
  if (current === null) return null;

  const pending = round2.pendingWinnerTeamId;

  return (
    <div style={{ textAlign: 'center', marginTop: ui.SPACING.md }}>
      <p
        style={{
          fontSize: ui.FONT_SIZE.xl,
          fontWeight: ui.FONT_WEIGHT.bold,
          margin: 0,
          textTransform: 'uppercase',
          letterSpacing: 1,
        }}
      >
        {current.displayName}
      </p>
      <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>
        {current.baseRewardBb.toLocaleString()} BB
      </p>

      {/* The Host has picked but not confirmed. Shown so a team is not
          surprised by the award — and so a wrong pick is visible before it
          pays. */}
      {pending !== null && current.progress === 'in_progress' && (
        <p
          style={{
            marginTop: ui.SPACING.md,
            fontSize: ui.FONT_SIZE.md,
            fontWeight: ui.FONT_WEIGHT.bold,
            color: ui.COLOR.warning,
          }}
        >
          {teamLabel(pending)} selected — awaiting the Host&rsquo;s confirmation
        </p>
      )}

      {pending === null && current.progress === 'in_progress' && (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.md }}>
          Playing now. Waiting for the Host to call the winner…
        </p>
      )}

      {current.progress === 'not_started' && (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.md }}>Waiting for the Host to start…</p>
      )}

      {yourTeamId !== null && pending === yourTeamId && (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.xs, fontSize: ui.FONT_SIZE.xs }}>
          That&rsquo;s your team.
        </p>
      )}
    </div>
  );
}

/** Four dots: done, current, still to come. */
function Progress({ round2 }: { round2: Round2StateView }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        gap: ui.SPACING.sm,
        marginTop: ui.SPACING.md,
      }}
    >
      {round2.challenges.map((challenge) => (
        <span
          key={challenge.challengeType}
          title={challenge.displayName}
          style={{
            width: 10,
            height: 10,
            borderRadius: ui.RADIUS.pill,
            display: 'inline-block',
            background:
              challenge.progress === 'resolved'
                ? ui.COLOR.success
                : challenge.progress === 'in_progress'
                  ? ui.COLOR.accent
                  : ui.COLOR.border,
          }}
        />
      ))}
    </div>
  );
}

function ResultList({
  round2,
  yourTeamId,
}: {
  round2: Round2StateView;
  yourTeamId: TeamId | null;
}) {
  const resolved = round2.challenges.filter((c) => c.progress === 'resolved');

  return (
    <div style={{ marginTop: ui.SPACING.md }}>
      {resolved.map((challenge) => (
        <div
          key={challenge.challengeType}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            padding: `${ui.SPACING.xs}px 0`,
            opacity: challenge.winningTeamId === yourTeamId ? 1 : 0.6,
          }}
        >
          <span style={ui.muted}>{challenge.displayName}</span>
          <span style={{ ...ui.muted, fontVariantNumeric: 'tabular-nums' }}>
            {challenge.winningTeamId === null ? '—' : teamLabel(challenge.winningTeamId)}
            {challenge.awardedBb !== null && ` +${challenge.awardedBb.toLocaleString()}`}
            {/* Named explicitly: a team that sees +1,000 where it expected
                +500 should be able to see why. */}
            {challenge.doubled && ' ×2'}
          </span>
        </div>
      ))}
    </div>
  );
}

function RoundComplete({
  round2,
  yourTeamId,
}: {
  round2: Round2StateView;
  yourTeamId: TeamId | null;
}) {
  const wins = round2.challenges.filter((c) => c.winningTeamId === yourTeamId).length;

  return (
    <div style={{ textAlign: 'center', marginTop: ui.SPACING.md }}>
      <p
        style={{
          fontSize: ui.FONT_SIZE.lg,
          fontWeight: ui.FONT_WEIGHT.bold,
          color: ui.COLOR.success,
          margin: 0,
        }}
      >
        ROUND 2 COMPLETE
      </p>
      {yourTeamId !== null && (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>
          Your team won {wins} of {ROUND2_CHALLENGE_COUNT}.
        </p>
      )}
    </div>
  );
}

function teamLabel(teamId: TeamId): string {
  return DEFAULT_TEAM_LABELS[teamId as keyof typeof DEFAULT_TEAM_LABELS] ?? teamId;
}

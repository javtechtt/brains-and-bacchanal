'use client';

import {
  DEFAULT_TEAM_LABELS,
  RPS_CHOICES,
  type Round3StateView,
  type RpsChoice,
  type TeamId,
} from '@bb/protocol';
import { useState } from 'react';
import * as ui from './ui';

/**
 * The player's Round 3 screen. Phase 7B.
 *
 * ================== WHAT A PHONE IS FOR IN ROUND 3 ==================
 * Every Round 3 challenge is spoken and Host-judged (§14-§17), so there is no
 * answer box, no buzzer and no way to award yourself a point. A phone shows the
 * current item, the score, whose turn it is in Think Fast, and the round's
 * standings.
 *
 * The ONE thing a phone actually decides is a rock-paper-scissors throw in the
 * tiebreaker (§18) — a team chooses its own, which is why that is the only
 * player intent in the round.
 * ====================================================================
 *
 * Everything rendered comes from the player-safe snapshot. An unrevealed RPS
 * choice cannot appear here because the view does not carry one, and a future
 * content item cannot appear because only the current item is ever sent.
 */
export function PlayerRound3({
  round3,
  yourTeamId,
  paused,
  submit,
}: {
  round3: Round3StateView;
  yourTeamId: TeamId | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const current = round3.current;

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
        Round 3
      </p>

      {round3.tiebreaker !== null ? (
        <Tiebreaker
          round3={round3}
          yourTeamId={yourTeamId}
          paused={paused}
          {...(submit === undefined ? {} : { submit })}
        />
      ) : round3.complete ? (
        <RoundComplete round3={round3} yourTeamId={yourTeamId} />
      ) : (
        <CurrentChallenge round3={round3} yourTeamId={yourTeamId} />
      )}

      {current !== null && round3.tiebreaker === null && <Progress round3={round3} />}
      <ChallengeWins round3={round3} yourTeamId={yourTeamId} />
    </div>
  );
}

function CurrentChallenge({
  round3,
  yourTeamId,
}: {
  round3: Round3StateView;
  yourTeamId: TeamId | null;
}) {
  const current = round3.current;
  if (current === null) return null;

  const item = current.currentItem;
  const thinkFast = current.thinkFast;
  const yourTurn = thinkFast !== null && thinkFast.currentTeamId === yourTeamId;
  const youAreOut =
    thinkFast !== null && yourTeamId !== null && thinkFast.eliminatedTeamIds.includes(yourTeamId);

  return (
    <div style={{ textAlign: 'center', marginTop: ui.SPACING.md }}>
      <p
        style={{
          fontSize: ui.FONT_SIZE.xl,
          fontWeight: ui.FONT_WEIGHT.bold,
          margin: 0,
          textTransform: 'uppercase',
        }}
      >
        {current.displayName}
      </p>

      {/* The game-supplied item. Only ever the current one. */}
      {item !== null && (
        <div
          style={{
            marginTop: ui.SPACING.md,
            padding: ui.SPACING.md,
            border: `1px solid ${ui.COLOR.border}`,
            borderRadius: ui.RADIUS.md,
          }}
        >
          {item.letter !== null && (
            <p
              style={{
                fontSize: ui.FONT_SIZE.xxl,
                fontWeight: ui.FONT_WEIGHT.bold,
                margin: 0,
                color: ui.COLOR.accent,
              }}
            >
              {item.letter}
            </p>
          )}
          <p style={{ margin: 0, fontSize: ui.FONT_SIZE.md }}>{item.body}</p>
          <p style={{ ...ui.muted, marginTop: ui.SPACING.xs, fontSize: ui.FONT_SIZE.xs }}>
            #{item.index}
            {item.remainingMs !== null && ` · ${Math.ceil(item.remainingMs / 1_000)}s`}
          </p>
        </div>
      )}

      {/* Think Fast: whose turn, and whether you are still in. */}
      {thinkFast !== null && (
        <div style={{ marginTop: ui.SPACING.md }}>
          {youAreOut ? (
            <p style={{ ...ui.muted, margin: 0, color: ui.COLOR.warning }}>
              Your team is out of this challenge.
            </p>
          ) : yourTurn ? (
            <p
              style={{
                fontSize: ui.FONT_SIZE.lg,
                fontWeight: ui.FONT_WEIGHT.bold,
                color: ui.COLOR.success,
                margin: 0,
              }}
            >
              YOUR TURN — ANSWER NOW
            </p>
          ) : (
            <p style={{ ...ui.muted, margin: 0 }}>
              {thinkFast.currentTeamId === null
                ? 'Waiting for the Host…'
                : `${teamLabel(thinkFast.currentTeamId)} is answering…`}
            </p>
          )}
        </div>
      )}

      {/* Points-scored challenges: the score and the normal target. */}
      {current.format === 'points' && (
        <div style={{ marginTop: ui.SPACING.md }}>
          {Object.entries(current.scores).map(([team, score]) => (
            <div
              key={team}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: `${ui.SPACING.xs}px 0`,
                opacity: team === yourTeamId ? 1 : 0.6,
              }}
            >
              <span style={ui.muted}>{teamLabel(team as TeamId)}</span>
              <span style={{ ...ui.muted, fontVariantNumeric: 'tabular-nums' }}>{score}</span>
            </div>
          ))}
          {current.targetScore !== null && (
            <p style={{ ...ui.muted, fontSize: ui.FONT_SIZE.xs, marginTop: ui.SPACING.xs }}>
              {current.targetReached
                ? 'Target reached — the Host decides when it ends.'
                : `First to ${current.targetScore}`}
            </p>
          )}
        </div>
      )}

      <p style={{ ...ui.muted, marginTop: ui.SPACING.md, fontSize: ui.FONT_SIZE.xs }}>
        The Host judges this challenge.
      </p>
    </div>
  );
}

/**
 * The rock-paper-scissors tiebreaker. §18.
 *
 * NOT a Bacchanal Clash, and deliberately not built from its UI — different
 * rules, no cards, and a separate type all the way down.
 */
function Tiebreaker({
  round3,
  yourTeamId,
  paused,
  submit,
}: {
  round3: Round3StateView;
  yourTeamId: TeamId | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const tb = round3.tiebreaker;
  if (tb === null) return null;

  const attempt = tb.current;
  const youArePlaying = yourTeamId !== null && (attempt?.participatingTeamIds.includes(yourTeamId) ?? false);
  const youHaveChosen = tb.yourChoice !== null;

  const choose = async (choice: RpsChoice): Promise<void> => {
    if (submit === undefined || busy) return;
    setBusy(true);
    try {
      await submit('SUBMIT_RPS_CHOICE', { choice });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ textAlign: 'center', marginTop: ui.SPACING.md }}>
      <p
        style={{
          fontSize: ui.FONT_SIZE.lg,
          fontWeight: ui.FONT_WEIGHT.bold,
          margin: 0,
          color: ui.COLOR.accent,
        }}
      >
        ROUND 3 TIED
      </p>
      <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>
        {tb.tiedTeamIds.map((t) => teamLabel(t)).join(' vs ')}
      </p>

      {tb.complete ? (
        <p
          style={{
            fontSize: ui.FONT_SIZE.lg,
            fontWeight: ui.FONT_WEIGHT.bold,
            color: ui.COLOR.success,
            marginTop: ui.SPACING.md,
          }}
        >
          {tb.winningTeamId === null ? '—' : `${teamLabel(tb.winningTeamId)} WINS ROUND 3`}
        </p>
      ) : !youArePlaying ? (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.md }}>
          Waiting for the tied teams to choose…
        </p>
      ) : youHaveChosen ? (
        <>
          <p style={{ marginTop: ui.SPACING.md, fontSize: ui.FONT_SIZE.md }}>
            You chose <strong>{tb.yourChoice}</strong>
          </p>
          <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>
            Waiting for the other team…
          </p>
        </>
      ) : (
        <>
          <p style={{ ...ui.muted, marginTop: ui.SPACING.md }}>Choose — hidden until both are in.</p>
          <div style={{ display: 'flex', gap: ui.SPACING.sm, marginTop: ui.SPACING.sm }}>
            {RPS_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                disabled={busy || paused || submit === undefined}
                onClick={() => void choose(choice)}
                style={{ ...ui.button, flex: 1, opacity: busy || paused ? 0.5 : 1 }}
              >
                {choice}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Earlier attempts, once revealed. A replay is worth seeing. */}
      {tb.history.length > 0 && (
        <div style={{ marginTop: ui.SPACING.md }}>
          {tb.history.map((past) => (
            <p key={past.attemptId} style={{ ...ui.muted, fontSize: ui.FONT_SIZE.xs, margin: 0 }}>
              #{past.attemptNumber}:{' '}
              {Object.entries(past.choices)
                .map(([team, choice]) => `${teamLabel(team as TeamId)} ${choice}`)
                .join(' · ')}
              {past.outcome === 'replay' ? ' — replay' : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** Four dots: done, current, still to come. */
function Progress({ round3 }: { round3: Round3StateView }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        gap: ui.SPACING.sm,
        marginTop: ui.SPACING.md,
      }}
    >
      {round3.challenges.map((challenge) => (
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

/** The counter that decides the round — not BB, and labelled so. */
function ChallengeWins({
  round3,
  yourTeamId,
}: {
  round3: Round3StateView;
  yourTeamId: TeamId | null;
}) {
  return (
    <div
      style={{
        marginTop: ui.SPACING.md,
        paddingTop: ui.SPACING.sm,
        borderTop: `1px solid ${ui.COLOR.border}`,
      }}
    >
      <p style={{ ...ui.muted, fontSize: ui.FONT_SIZE.xs, margin: 0, textAlign: 'center' }}>
        Round 3 wins
      </p>
      {Object.entries(round3.challengeWins).map(([team, wins]) => (
        <div
          key={team}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: `${ui.SPACING.xs}px 0`,
            opacity: team === yourTeamId ? 1 : 0.6,
          }}
        >
          <span style={ui.muted}>{teamLabel(team as TeamId)}</span>
          <span style={{ ...ui.muted, fontVariantNumeric: 'tabular-nums' }}>{wins}</span>
        </div>
      ))}
    </div>
  );
}

function RoundComplete({
  round3,
  yourTeamId,
}: {
  round3: Round3StateView;
  yourTeamId: TeamId | null;
}) {
  const winner = round3.winningTeamId;
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
        ROUND 3 COMPLETE
      </p>
      {winner !== null && (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>
          {winner === yourTeamId ? 'Your team wins Round 3.' : `${teamLabel(winner)} wins Round 3.`}
        </p>
      )}
    </div>
  );
}

function teamLabel(teamId: TeamId): string {
  return DEFAULT_TEAM_LABELS[teamId as keyof typeof DEFAULT_TEAM_LABELS] ?? teamId;
}

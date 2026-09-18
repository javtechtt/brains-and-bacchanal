'use client';

import {
  DEFAULT_TEAM_LABELS,
  SUDDEN_DEATH_INTENTS,
  type SuddenDeathStateView,
  type TeamId,
} from '@bb/protocol';
import { useEffect, useState } from 'react';
import * as ui from './ui';

/**
 * The player's Sudden Death screen. Phase 7D-B2.
 *
 * GAME_RULES_LOCKED.md §21, replaced by DECISION_LOG.md D-034: a face-off
 * sequence (same mechanic as Round 4's own face-off, §19) between exactly
 * two teams — first to win two face-offs IN A ROW wins the whole game.
 *
 * Every button here sends exactly one of the Sudden Death PLAYER intents
 * the room already accepts (SUBMIT_SUDDEN_DEATH_BUZZ,
 * SUBMIT_SUDDEN_DEATH_ANSWER) and DECIDES NOTHING — the server grades every
 * answer and rules every face-off, and refuses either intent from a team
 * the room does not authorize.
 *
 * CONTENT SAFETY: `SuddenDeathFaceoffView` never carries the question's
 * ranked board, only its prompt and (once decided) the winner — the same
 * structural protection Round 4's own face-off already relies on.
 *
 * TIMER: the post-buzz answer window is shown as an exact countdown via
 * `Round4TimerView`, the same shape/discipline `PlayerRound4.tsx` already
 * uses. There is deliberately no separate "buzzer is open" countdown — the
 * buzzer just stays open until someone buzzes or the Host moves on, same as
 * Round 4's own face-off buzzer.
 */
export function PlayerSuddenDeath({
  suddenDeath,
  yourTeamId,
  paused,
  submit,
}: {
  suddenDeath: SuddenDeathStateView;
  yourTeamId: TeamId | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const current = suddenDeath.current;

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
        Sudden Death
      </p>

      <Streaks suddenDeath={suddenDeath} yourTeamId={yourTeamId} />

      {suddenDeath.complete ? (
        <div style={{ textAlign: 'center', marginTop: ui.SPACING.md }}>
          <p
            style={{
              fontSize: ui.FONT_SIZE.xl,
              fontWeight: ui.FONT_WEIGHT.bold,
              color: suddenDeath.winnerTeamId === yourTeamId ? ui.COLOR.success : ui.COLOR.danger,
            }}
          >
            {suddenDeath.winnerTeamId === yourTeamId
              ? 'YOUR TEAM WINS!'
              : `${teamLabel(suddenDeath.winnerTeamId)} WINS`}
          </p>
        </div>
      ) : current === null ? (
        <p style={{ ...ui.muted, textAlign: 'center', marginTop: ui.SPACING.md }}>
          Waiting for the Host to start the next face-off…
        </p>
      ) : (
        <Faceoff
          faceoff={current}
          yourTeamId={yourTeamId}
          paused={paused}
          {...(submit === undefined ? {} : { submit })}
        />
      )}
    </div>
  );
}

function Streaks({
  suddenDeath,
  yourTeamId,
}: {
  suddenDeath: SuddenDeathStateView;
  yourTeamId: TeamId | null;
}) {
  return (
    <div style={{ textAlign: 'center', marginTop: ui.SPACING.sm }}>
      <p style={{ ...ui.muted, margin: 0, fontSize: ui.FONT_SIZE.xs }}>
        First to 2 face-off wins in a row takes the game
      </p>
      <div style={{ display: 'flex', justifyContent: 'center', gap: ui.SPACING.md, marginTop: ui.SPACING.xs }}>
        {suddenDeath.streaks.map((s) => (
          <p
            key={s.teamId}
            style={{
              margin: 0,
              fontWeight: s.teamId === yourTeamId ? ui.FONT_WEIGHT.bold : ui.FONT_WEIGHT.regular,
            }}
          >
            {teamLabel(s.teamId)}: {s.consecutiveWins} in a row
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * Face-off: buzzer, then the answer window for whoever buzzed.
 *
 * The buzzer is enabled ONLY for the two participants, and only while
 * genuinely open (`status === 'reading'`) — anyone else sees a waiting
 * state. Unlike a normal Round 4 face-off, there is no opponent's-chance
 * fallback: whoever buzzed either wins or loses the WHOLE face-off outright.
 */
function Faceoff({
  faceoff,
  yourTeamId,
  paused,
  submit,
}: {
  faceoff: NonNullable<SuddenDeathStateView['current']>;
  yourTeamId: TeamId | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const [buzzSent, setBuzzSent] = useState(false);

  const isParticipant = yourTeamId !== null && faceoff.participantTeamIds.includes(yourTeamId);
  const buzzerOpen = faceoff.status === 'reading';
  const youHaveTheFloor = faceoff.status === 'buzzed' && faceoff.buzzedTeamId === yourTeamId;

  const buzz = async () => {
    if (submit === undefined || busy || buzzSent) return;
    setBusy(true);
    setBuzzSent(true);
    try {
      await submit(SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_BUZZ);
    } finally {
      setBusy(false);
    }
  };

  const submitAnswer = async () => {
    if (submit === undefined || busy || answer.trim() === '') return;
    setBusy(true);
    try {
      await submit(SUDDEN_DEATH_INTENTS.SUBMIT_SUDDEN_DEATH_ANSWER, { answer: answer.trim() });
      setAnswer('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ textAlign: 'center', marginTop: ui.SPACING.md }}>
      <p style={{ fontSize: ui.FONT_SIZE.lg, fontWeight: ui.FONT_WEIGHT.bold, margin: 0 }}>
        FACE-OFF
      </p>

      {!isParticipant ? (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>Watching — not your face-off.</p>
      ) : buzzerOpen ? (
        <button
          type="button"
          disabled={busy || paused || buzzSent || submit === undefined}
          onClick={() => void buzz()}
          style={{
            ...ui.button,
            marginTop: ui.SPACING.md,
            minHeight: 96,
            fontSize: ui.FONT_SIZE.xxl,
            fontWeight: ui.FONT_WEIGHT.bold,
            opacity: busy || buzzSent ? 0.6 : 1,
          }}
        >
          BUZZ
        </button>
      ) : faceoff.buzzedTeamId !== null ? (
        <>
          <p
            style={{
              fontSize: ui.FONT_SIZE.lg,
              fontWeight: ui.FONT_WEIGHT.bold,
              color: faceoff.buzzedTeamId === yourTeamId ? ui.COLOR.success : ui.COLOR.warning,
              marginTop: ui.SPACING.sm,
            }}
          >
            {faceoff.buzzedTeamId === yourTeamId ? 'YOU BUZZED FIRST' : 'OPPONENT BUZZED FIRST'}
          </p>

          {youHaveTheFloor ? (
            <>
              {faceoff.answerTimer !== null && (
                <TimerDisplay
                  remainingMs={faceoff.answerTimer.remainingMs}
                  paused={faceoff.answerTimer.paused}
                  key={faceoff.answerTimer.startedAt}
                />
              )}
              <p style={{ ...ui.muted, marginTop: ui.SPACING.xs, color: ui.COLOR.danger }}>
                Wrong or no answer loses this face-off outright.
              </p>
              <input
                type="text"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Your answer"
                style={{ ...ui.input, marginTop: ui.SPACING.sm }}
                disabled={busy || paused}
              />
              <button
                type="button"
                disabled={busy || paused || answer.trim() === '' || submit === undefined}
                onClick={() => void submitAnswer()}
                style={{ ...ui.button, marginTop: ui.SPACING.sm }}
              >
                SUBMIT ANSWER
              </button>
            </>
          ) : (
            <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>Waiting on the Host's ruling…</p>
          )}
        </>
      ) : (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>
          {faceoff.status === 'decided'
            ? faceoff.noDecision
              ? 'No decision — a fresh face-off is coming.'
              : faceoff.winningTeamId === yourTeamId
                ? 'Your team won that face-off!'
                : 'The other team won that face-off.'
            : 'Waiting…'}
        </p>
      )}
    </div>
  );
}

/**
 * A local countdown built from a `Round4TimerView`. Same shape/discipline
 * as `PlayerRound4.tsx`'s own `TimerDisplay` — the server decides expiry,
 * this only interpolates smoothly between snapshots.
 */
function TimerDisplay({ remainingMs, paused }: { remainingMs: number; paused: boolean }) {
  const [displayMs, setDisplayMs] = useState(remainingMs);

  useEffect(() => {
    setDisplayMs(remainingMs);
    if (paused) return undefined;

    const startedAt = Date.now();
    const id = setInterval(() => {
      setDisplayMs(Math.max(0, remainingMs - (Date.now() - startedAt)));
    }, 100);
    return () => clearInterval(id);
  }, [remainingMs, paused]);

  return (
    <p style={{ ...ui.muted, marginTop: ui.SPACING.xs, fontVariantNumeric: 'tabular-nums' }}>
      {Math.ceil(displayMs / 1_000)}s{paused ? ' (paused)' : ''}
    </p>
  );
}

function teamLabel(teamId: TeamId | null): string {
  if (teamId === null) return '';
  return DEFAULT_TEAM_LABELS[teamId as keyof typeof DEFAULT_TEAM_LABELS] ?? teamId;
}

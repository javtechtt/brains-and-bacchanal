'use client';

import {
  DEFAULT_TEAM_LABELS,
  ROUND1_DIFFICULTIES,
  type Round1Difficulty,
  type Round1StateView,
  type TeamId,
} from '@bb/protocol';
import { useEffect, useState } from 'react';
import * as ui from './ui';

/**
 * The player's Round 1 screen. Phase 7C.
 *
 * ================== WHAT A PHONE IS FOR IN ROUND 1 ==================
 * Round 1 is the FIRST round where a phone does real work: the nominated
 * answerer types their team's answer, and nobody else can. Everyone else sees
 * the question, the clock and their team's state, with no enabled input.
 *
 * That restriction is presentation only. The SERVER decides who may submit
 * (spec §15), so hiding the box is a courtesy rather than a control — a phone
 * that sent the intent anyway would simply be refused.
 * ====================================================================
 *
 * Everything rendered comes from the player-safe snapshot. The canonical answer
 * cannot appear before the reveal because the view carries null until then, a
 * future question cannot appear because only the current one is ever sent, and
 * another team's answer cannot appear because the room scopes it per viewer.
 *
 * The ONE deliberate exception is the Maco! panel, which shows exactly one
 * already-submitted opponent answer to exactly one player for ten seconds.
 */
export function PlayerRound1({
  round1,
  yourTeamId,
  paused,
  submit,
}: {
  round1: Round1StateView;
  yourTeamId: TeamId | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
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
        Round 1 — Nah, That Too Easy!
      </p>

      {round1.phase === 'nominating' ? (
        <Nominating
          round1={round1}
          yourTeamId={yourTeamId}
          {...(submit === undefined ? {} : { submit })}
        />
      ) : round1.phase === 'tiebreak' ? (
        <Tiebreak
          round1={round1}
          yourTeamId={yourTeamId}
          paused={paused}
          {...(submit === undefined ? {} : { submit })}
        />
      ) : (
        <Question
          round1={round1}
          yourTeamId={yourTeamId}
          paused={paused}
          {...(submit === undefined ? {} : { submit })}
        />
      )}

      {round1.macoView !== null ? (
        <MacoPanel round1={round1} />
      ) : (
        <MacoTargets
          round1={round1}
          yourTeamId={yourTeamId}
          {...(submit === undefined ? {} : { submit })}
        />
      )}

      <Standings round1={round1} yourTeamId={yourTeamId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nomination
// ---------------------------------------------------------------------------

/**
 * Choosing who answers which difficulty. §11.
 *
 * Any player may nominate themselves for any of the three; teams sort it out at
 * the table. There is deliberately no uniqueness rule (spec §2), so one player
 * may take all three — which a team of one needs.
 */
function Nominating({
  round1,
  yourTeamId,
  submit,
}: {
  round1: Round1StateView;
  yourTeamId: TeamId | null;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [busy, setBusy] = useState<Round1Difficulty | null>(null);
  const yours = round1.nominees.find((n) => n.teamId === yourTeamId);

  const nominate = async (difficulty: Round1Difficulty) => {
    if (submit === undefined) return;
    setBusy(difficulty);
    await submit('NOMINATE_ANSWERER', { difficulty });
    setBusy(null);
  };

  return (
    <div style={{ marginTop: ui.SPACING.md }}>
      <p style={{ ...ui.muted, textAlign: 'center' }}>
        Pick who answers each difficulty. Only that player can submit for your team.
      </p>

      <div style={{ display: 'grid', gap: ui.SPACING.sm, marginTop: ui.SPACING.md }}>
        {ROUND1_DIFFICULTIES.map((difficulty) => {
          const taken =
            difficulty === 'EASY'
              ? yours?.easyPlayerId
              : difficulty === 'MEDIUM'
                ? yours?.mediumPlayerId
                : yours?.hardPlayerId;

          return (
            <button
              key={difficulty}
              type="button"
              onClick={() => void nominate(difficulty)}
              disabled={submit === undefined || busy !== null}
              style={{
                ...ui.button,
                ...(taken === null || taken === undefined
                  ? {}
                  : { background: ui.COLOR.surface, color: ui.COLOR.textSecondary }),
              }}
            >
              {difficulty}
              {taken === null || taken === undefined ? ' — nobody yet' : ' — taken'}
            </button>
          );
        })}
      </div>

      <p style={{ ...ui.muted, textAlign: 'center', marginTop: ui.SPACING.md }}>
        {round1.nominationsComplete
          ? 'Every team is ready. Waiting for the Host to start.'
          : 'Waiting for every team to nominate all three.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A question
// ---------------------------------------------------------------------------

function Question({
  round1,
  yourTeamId,
  paused,
  submit,
}: {
  round1: Round1StateView;
  yourTeamId: TeamId | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const question = round1.current;

  if (question === null) {
    return (
      <p style={{ ...ui.muted, textAlign: 'center', marginTop: ui.SPACING.md }}>
        {round1.winningTeamId === null
          ? 'Waiting for the first question.'
          : `Round 1 is over. ${teamLabel(round1.winningTeamId)} takes it.`}
      </p>
    );
  }

  const yours = question.answers.find((a) => a.teamId === yourTeamId);

  return (
    <div style={{ marginTop: ui.SPACING.md }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={ui.muted}>
          Question {question.questionNumber} / {question.totalQuestions}
        </span>
        <span style={{ ...ui.muted, color: ui.COLOR.accent }}>
          {question.difficulty} · {question.value} BB
        </span>
      </div>

      <p
        style={{
          fontSize: ui.FONT_SIZE.lg,
          fontWeight: ui.FONT_WEIGHT.medium,
          margin: `${ui.SPACING.md}px 0`,
          textAlign: 'center',
        }}
      >
        {question.prompt}
      </p>

      {question.remainingMs !== null && question.phase === 'open' && (
        <Countdown remainingMs={question.remainingMs} paused={paused} />
      )}

      {/* ⚠ The correct answer appears ONLY once the server has revealed it.
          Before that the field is null and there is nothing here to show —
          §11, and the reason the reveal is last. */}
      {question.phase === 'revealed' && question.correctAnswer !== null && (
        <div
          style={{
            marginTop: ui.SPACING.md,
            padding: ui.SPACING.md,
            background: ui.COLOR.surface,
            borderRadius: ui.RADIUS.md,
            textAlign: 'center',
          }}
        >
          <p style={{ ...ui.muted, margin: 0 }}>The answer was</p>
          <p
            style={{
              fontSize: ui.FONT_SIZE.lg,
              fontWeight: ui.FONT_WEIGHT.bold,
              margin: `${ui.SPACING.xs}px 0 0`,
            }}
          >
            {question.correctAnswer}
          </p>
        </div>
      )}

      <AnswerBox
        round1={round1}
        yourTeamId={yourTeamId}
        paused={paused}
        {...(submit === undefined ? {} : { submit })}
      />

      {yours !== undefined && <YourResult answer={yours} phase={question.phase} />}

      <SubmissionStatus round1={round1} yourTeamId={yourTeamId} />
    </div>
  );
}

/**
 * The one interactive control in Round 1, and only for the nominee.
 *
 * `youMaySubmit` comes from the SERVER — it already accounts for the phase, the
 * difficulty, whether this team has answered, and whether a retry is running.
 * The component asks no questions of its own, so the button and the server can
 * never disagree.
 */
function AnswerBox({
  round1,
  yourTeamId,
  paused,
  submit,
}: {
  round1: Round1StateView;
  yourTeamId: TeamId | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const question = round1.current;
  const itemId = question?.itemId ?? null;

  // Clear the box when the question changes, so a stale draft cannot be sent
  // into the next question by a quick tap.
  useEffect(() => {
    setAnswer('');
    setError(null);
  }, [itemId, question?.phase]);

  if (!round1.youMaySubmit || submit === undefined) {
    if (round1.yourNomineeRole === null) {
      return (
        <p style={{ ...ui.muted, textAlign: 'center', marginTop: ui.SPACING.md }}>
          You are not answering this one. Help your team out loud.
        </p>
      );
    }
    return null;
  }

  const isRetry = question?.phase === 'retry';

  // The retry clock is PER TEAM — §11 gives the retry to one team at a time and
  // each window starts when the Host opens it, so it lives on this team's own
  // answer row rather than on the question (whose 60 seconds are long gone).
  const ownAnswer = question?.answers.find((a) => a.teamId === yourTeamId);
  const retryRemainingMs =
    ownAnswer?.retryOpen === true ? (ownAnswer.retryRemainingMs ?? null) : null;

  const send = async () => {
    if (answer.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const result = await submit('SUBMIT_ROUND1_ANSWER', { answer });
    setBusy(false);
    if (!result.ok) setError(result.message ?? 'That did not go through.');
  };

  return (
    <div style={{ marginTop: ui.SPACING.md }}>
      <p
        style={{
          ...ui.label,
          color: isRetry ? ui.COLOR.warning : ui.COLOR.textPrimary,
        }}
      >
        {isRetry ? 'FORGIVE MEH! — one last answer' : `Your answer (${round1.yourNomineeRole})`}
      </p>

      {/* The retry's own 10-second clock (D-032). Per team, so it comes from
          this team's answer row rather than from the question. */}
      {retryRemainingMs !== null && (
        <Countdown remainingMs={retryRemainingMs} paused={paused} />
      )}

      <input
        style={ui.input}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="Type your team's answer"
        disabled={busy || paused}
        autoCapitalize="off"
        autoCorrect="off"
        onKeyDown={(e) => {
          if (e.key === 'Enter') void send();
        }}
      />
      <button
        type="button"
        style={{ ...ui.button, marginTop: ui.SPACING.sm }}
        onClick={() => void send()}
        disabled={busy || paused || answer.trim().length === 0}
      >
        {busy ? 'Sending…' : 'Submit — this is final'}
      </button>
      {error !== null && <p style={ui.errorText}>{error}</p>}
    </div>
  );
}

/** Your team's own outcome. Visible to your team before anyone else. */
function YourResult({
  answer,
  phase,
}: {
  answer: { answer: string | null; verdict: string | null; awardedBb: number; awardedPoints: number; doubled: boolean };
  phase: string;
}) {
  if (answer.answer === null) return null;

  return (
    <div style={{ marginTop: ui.SPACING.md, textAlign: 'center' }}>
      <p style={{ ...ui.muted, margin: 0 }}>You answered</p>
      <p style={{ margin: `${ui.SPACING.xs}px 0`, fontWeight: ui.FONT_WEIGHT.medium }}>
        {answer.answer}
      </p>
      {phase === 'revealed' && (
        <p
          style={{
            margin: 0,
            color: answer.verdict === 'CORRECT' ? ui.COLOR.success : ui.COLOR.textSecondary,
            fontWeight: ui.FONT_WEIGHT.bold,
          }}
        >
          {answer.verdict === 'CORRECT'
            ? `+${answer.awardedBb} BB · +${answer.awardedPoints} points${answer.doubled ? ' (Double It!)' : ''}`
            : 'No points this time.'}
        </p>
      )}
      {phase !== 'revealed' && answer.verdict === null && (
        <p style={{ ...ui.muted, margin: 0 }}>Waiting on the ruling…</p>
      )}
    </div>
  );
}

/** Who has answered. The FACT only — never the words. */
function SubmissionStatus({
  round1,
  yourTeamId,
}: {
  round1: Round1StateView;
  yourTeamId: TeamId | null;
}) {
  const question = round1.current;
  if (question === null) return null;

  return (
    <div style={{ marginTop: ui.SPACING.md, display: 'grid', gap: ui.SPACING.xs }}>
      {question.answers.map((answer) => (
        <div
          key={answer.teamId}
          style={{ display: 'flex', justifyContent: 'space-between', ...ui.muted }}
        >
          <span>
            {teamLabel(answer.teamId)}
            {answer.teamId === yourTeamId ? ' (you)' : ''}
          </span>
          <span style={{ color: answer.submitted ? ui.COLOR.success : ui.COLOR.textSecondary }}>
            {answer.submitted ? 'answered' : 'thinking…'}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Maco!
// ---------------------------------------------------------------------------

/**
 * One opponent's submitted answer, for ten seconds. §11, spec §8.
 *
 * This panel exists ONLY in the snapshot of the player entitled to it — the
 * server scopes `macoView` per viewer, so a teammate's phone renders nothing
 * here and there is no client-side check to get wrong.
 *
 * Seeing the answer neither copies nor submits it: the nominee reads it and
 * decides for themselves what to type.
 */
/**
 * Choosing WHO to Maco. §11, spec §8.
 *
 * ================== WHY A PICKER EXISTS AT ALL ==================
 * Maco! is the only Round 1 card that needs a target chosen by the player at
 * the moment it resolves, and Phase 7C shipped without this — the card could be
 * played but never aimed, so it always failed with "needs a target team". The
 * effect is its own intent (VIEW_ROUND1_MACO) precisely so a Clash can cancel
 * the card before any answer is revealed.
 * ===============================================================
 *
 * Only offers teams that have ACTUALLY SUBMITTED, because §11 requires it —
 * a half-typed answer is never exposed, and the server refuses anything else.
 * Only the nominated answerer sees this, which `youMaySubmit`-adjacent state
 * cannot express, so it keys off the nominee role directly.
 */
function MacoTargets({
  round1,
  yourTeamId,
  submit,
}: {
  round1: Round1StateView;
  yourTeamId: TeamId | null;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const question = round1.current;
  if (question === null || submit === undefined) return null;
  if (round1.yourNomineeRole === null) return null;

  // The nominee for THIS question's difficulty, and only while answers are
  // still being taken or graded — the server enforces the same window.
  if (round1.yourNomineeRole !== question.difficulty) return null;
  if (question.phase !== 'open' && question.phase !== 'grading') return null;

  const targets = question.answers.filter((a) => a.teamId !== yourTeamId && a.submitted);
  if (targets.length === 0) return null;

  const look = async (targetTeamId: TeamId) => {
    setBusy(true);
    setError(null);
    const result = await submit('VIEW_ROUND1_MACO', { targetTeamId });
    setBusy(false);
    if (!result.ok) setError(result.message ?? 'That did not go through.');
  };

  return (
    <div
      style={{
        marginTop: ui.SPACING.md,
        padding: ui.SPACING.md,
        borderRadius: ui.RADIUS.md,
        border: `1px dashed ${ui.COLOR.border}`,
      }}
    >
      <p style={{ ...ui.muted, margin: 0 }}>
        MACO! — look at a team that has already answered
      </p>
      <div style={{ display: 'grid', gap: ui.SPACING.sm, marginTop: ui.SPACING.sm }}>
        {targets.map((target) => (
          <button
            key={target.teamId}
            type="button"
            style={ui.secondaryButton}
            onClick={() => void look(target.teamId)}
            disabled={busy}
          >
            {busy ? 'Looking…' : `Look at ${teamLabel(target.teamId)}`}
          </button>
        ))}
      </div>
      <p style={{ ...ui.muted, margin: `${ui.SPACING.xs}px 0 0` }}>
        You still type your own answer — seeing theirs does not submit anything.
      </p>
      {error !== null && <p style={ui.errorText}>{error}</p>}
    </div>
  );
}

function MacoPanel({ round1 }: { round1: Round1StateView }) {
  const maco = round1.macoView;
  if (maco === null) return null;

  return (
    <div
      style={{
        marginTop: ui.SPACING.md,
        padding: ui.SPACING.md,
        borderRadius: ui.RADIUS.md,
        border: `1px solid ${ui.COLOR.warning}`,
        background: ui.COLOR.surface,
      }}
    >
      <p style={{ ...ui.muted, margin: 0, color: ui.COLOR.warning }}>
        MACO! — {teamLabel(maco.targetTeamId)} answered
      </p>
      <p
        style={{
          fontSize: ui.FONT_SIZE.lg,
          fontWeight: ui.FONT_WEIGHT.bold,
          margin: `${ui.SPACING.xs}px 0`,
        }}
      >
        {maco.answer}
      </p>
      <p style={{ ...ui.muted, margin: 0 }}>
        {Math.ceil(maco.remainingMs / 1000)}s left. Trust it or don&rsquo;t — you still type your own.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiebreak
// ---------------------------------------------------------------------------

/**
 * The Round 1 sudden-death trivia tiebreak. D-032.
 *
 * ⚠ NOT the end-of-game Sudden Death (§21). This only decides who won Round 1,
 * moves no BB and adds no points.
 */
function Tiebreak({
  round1,
  yourTeamId,
  paused,
  submit,
}: {
  round1: Round1StateView;
  yourTeamId: TeamId | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const tiebreak = round1.tiebreak;
  if (tiebreak === null) return null;

  const youAreIn = yourTeamId !== null && tiebreak.activeTeamIds.includes(yourTeamId);
  const attempt = tiebreak.current;

  return (
    <div style={{ marginTop: ui.SPACING.md }}>
      <p
        style={{
          textAlign: 'center',
          color: ui.COLOR.warning,
          fontWeight: ui.FONT_WEIGHT.bold,
          margin: 0,
        }}
      >
        SUDDEN DEATH — tied on Round 1 points
      </p>
      <p style={{ ...ui.muted, textAlign: 'center' }}>
        No BB and no points here. This only decides Round 1.
      </p>

      {tiebreak.complete && tiebreak.winningTeamId !== null ? (
        <p style={{ textAlign: 'center', fontWeight: ui.FONT_WEIGHT.bold }}>
          {teamLabel(tiebreak.winningTeamId)} wins Round 1.
        </p>
      ) : !youAreIn ? (
        <p style={{ ...ui.muted, textAlign: 'center' }}>
          Your team is out of the tiebreak. Watch it play out.
        </p>
      ) : attempt === null ? (
        <p style={{ ...ui.muted, textAlign: 'center' }}>Waiting for the next question.</p>
      ) : (
        <>
          <p
            style={{
              fontSize: ui.FONT_SIZE.lg,
              margin: `${ui.SPACING.md}px 0`,
              textAlign: 'center',
            }}
          >
            {attempt.prompt}
          </p>
          {attempt.remainingMs !== null && attempt.phase === 'open' && (
            <Countdown remainingMs={attempt.remainingMs} paused={paused} />
          )}
          <AnswerBox
            round1={round1}
            yourTeamId={yourTeamId}
            paused={paused}
            {...(submit === undefined ? {} : { submit })}
          />
          {attempt.phase === 'revealed' && attempt.explanation !== null && (
            <p style={{ ...ui.muted, textAlign: 'center' }}>{attempt.explanation}</p>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/**
 * A local countdown from the server's remaining time.
 *
 * COSMETIC ONLY. The server owns the deadline and refuses a late answer on its
 * own clock; this just stops the number looking frozen between snapshots.
 */
function Countdown({ remainingMs, paused }: { remainingMs: number; paused: boolean }) {
  const [shown, setShown] = useState(remainingMs);

  useEffect(() => {
    setShown(remainingMs);
  }, [remainingMs]);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => {
      setShown((value) => Math.max(0, value - 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [paused]);

  const seconds = Math.ceil(shown / 1000);
  return (
    <p
      style={{
        textAlign: 'center',
        fontSize: ui.FONT_SIZE.xl,
        fontWeight: ui.FONT_WEIGHT.bold,
        color: seconds <= 10 ? ui.COLOR.warning : ui.COLOR.textPrimary,
        margin: 0,
      }}
    >
      {paused ? 'paused' : `${seconds}s`}
    </p>
  );
}

/** Round 1 points. Not BB — the two are different totals (§11). */
function Standings({
  round1,
  yourTeamId,
}: {
  round1: Round1StateView;
  yourTeamId: TeamId | null;
}) {
  if (round1.standings.length === 0) return null;

  return (
    <div style={{ marginTop: ui.SPACING.lg }}>
      <p style={{ ...ui.muted, margin: 0 }}>Round 1 points</p>
      {round1.standings.map((standing) => (
        <div
          key={standing.teamId}
          style={{ display: 'flex', justifyContent: 'space-between', marginTop: ui.SPACING.xs }}
        >
          <span>
            {teamLabel(standing.teamId)}
            {standing.teamId === yourTeamId ? ' (you)' : ''}
          </span>
          <span style={{ fontWeight: ui.FONT_WEIGHT.medium }}>{standing.points}</span>
        </div>
      ))}
    </div>
  );
}

function teamLabel(teamId: TeamId | string): string {
  return DEFAULT_TEAM_LABELS[teamId as keyof typeof DEFAULT_TEAM_LABELS] ?? teamId;
}

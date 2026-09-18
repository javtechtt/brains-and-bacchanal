'use client';

import {
  DEFAULT_TEAM_LABELS,
  ROUND4_INTENTS,
  type GameTeamView,
  type Round4FaceoffView,
  type Round4StateView,
  type TeamId,
} from '@bb/protocol';
import { useEffect, useState } from 'react';
import * as ui from './ui';

/**
 * The player's Round 4 (Family Feud) screen. Phase 7D-B.
 *
 * ================== FAMILY FEUD IS THE FIRST BUZZER SECTION ==================
 * CLAUDE.md's Buzzer Rule — this is the first phone screen in the whole game
 * with a digital buzzer. Every button here sends exactly one of the Round 4
 * PLAYER intents the room already accepts (SUBMIT_BUZZ,
 * SUBMIT_FACEOFF_ANSWER, CHOOSE_PLAY_OR_PASS, SUBMIT_BOARD_ANSWER,
 * SUBMIT_STEAL_WAGER, SUBMIT_STEAL_ANSWER) and DECIDES NOTHING — the server
 * grades every answer, rules every face-off and steal, and refuses any of
 * these from a player the room does not authorize.
 * ==============================================================================
 *
 * CONTENT SAFETY: `Round4BoardAnswerView` never carries an unrevealed
 * answer's text or value, so this component has no code path that could show
 * one — the same structural protection Round1/Round3 already rely on.
 *
 * TIMERS (Phase 7D-B1): the face-off's 3s window, the board turn's 5s window
 * and the steal confer's 30s window are all shown as exact countdowns, via
 * `Round4TimerView` — `remainingMs`/`paused`/`expired` computed authoritatively
 * by the server on every snapshot (`Round4.#timerView`, mirroring the generic
 * `TimerView` shape `PlayerGame.tsx`'s own `TimerDisplay` already consumes).
 * This component only interpolates smoothly between snapshots; it never
 * decides expiry itself, matching "never trust client clocks."
 */
export function PlayerRound4({
  round4,
  teams,
  yourTeamId,
  yourPlayerId,
  paused,
  submit,
}: {
  round4: Round4StateView;
  /** The room's team rosters — needed only to seat PLAY's player order. */
  teams: readonly GameTeamView[];
  yourTeamId: TeamId | null;
  yourPlayerId: string | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const current = round4.current;

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
        Round 4 — Family Feud
      </p>

      <MatchupBanner round4={round4} yourTeamId={yourTeamId} />

      {round4.complete ? (
        <RoundComplete round4={round4} yourTeamId={yourTeamId} />
      ) : current === null ? (
        <p style={{ ...ui.muted, textAlign: 'center', marginTop: ui.SPACING.md }}>
          Waiting for the Host to start the next face-off…
        </p>
      ) : (
        <>
          <Board board={current.board} />

          {current.steal !== null ? (
            <Steal
              round4={round4}
              yourTeamId={yourTeamId}
              paused={paused}
              {...(submit === undefined ? {} : { submit })}
            />
          ) : current.boardPlay !== null ? (
            <BoardPlay
              round4={round4}
              yourTeamId={yourTeamId}
              yourPlayerId={yourPlayerId}
              paused={paused}
              {...(submit === undefined ? {} : { submit })}
            />
          ) : current.faceoff !== null ? (
            <Faceoff
              round4={round4}
              teams={teams}
              yourTeamId={yourTeamId}
              paused={paused}
              {...(submit === undefined ? {} : { submit })}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** The 3-team matchup structure, made legible. §20. */
function MatchupBanner({
  round4,
  yourTeamId,
}: {
  round4: Round4StateView;
  yourTeamId: TeamId | null;
}) {
  const youAreInactive = round4.inactiveTeamId !== null && round4.inactiveTeamId === yourTeamId;
  const gated =
    yourTeamId !== null &&
    round4.scoringGates.find((g) => g.teamId === yourTeamId)?.gated === true;

  return (
    <div style={{ textAlign: 'center', marginTop: ui.SPACING.sm }}>
      <p style={{ ...ui.muted, margin: 0, fontSize: ui.FONT_SIZE.xs }}>
        {round4.matchupTeamIds.map((t) => teamLabel(t)).join(' vs ')}
      </p>
      {youAreInactive && (
        <p style={{ ...ui.muted, margin: `${ui.SPACING.xs}px 0 0`, color: ui.COLOR.warning }}>
          Your team is sitting out this matchup — waiting.
        </p>
      )}
      {!youAreInactive && gated && (
        <p style={{ ...ui.muted, margin: `${ui.SPACING.xs}px 0 0`, color: ui.COLOR.warning }}>
          Your team cannot earn further Family Feud BB this round, but stays in the game.
        </p>
      )}
    </div>
  );
}

/** The survey board: prompt, revealed answers, blanks, pot, strikes. §19. */
function Board({ board }: { board: Round4StateView['current'] extends null ? never : NonNullable<Round4StateView['current']>['board'] }) {
  return (
    <div style={{ textAlign: 'center', marginTop: ui.SPACING.md }}>
      <p
        style={{
          fontSize: ui.FONT_SIZE.md,
          fontWeight: ui.FONT_WEIGHT.bold,
          margin: 0,
        }}
      >
        {board.prompt}
      </p>
      {board.doubled && (
        <p style={{ ...ui.muted, color: ui.COLOR.warning, margin: `${ui.SPACING.xs}px 0 0` }}>
          DOUBLED
        </p>
      )}

      <div style={{ marginTop: ui.SPACING.sm }}>
        {board.answers.map((answer) => (
          <div
            key={answer.answerId}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: `${ui.SPACING.xs}px ${ui.SPACING.sm}px`,
              marginBottom: 4,
              border: `1px solid ${ui.COLOR.border}`,
              borderRadius: ui.RADIUS.sm,
              background: answer.revealed ? ui.COLOR.surface : 'transparent',
            }}
          >
            <span>
              {answer.revealed ? answer.text : '—'}
              {answer.steupsRemoved && (
                <span style={{ ...ui.muted, fontSize: ui.FONT_SIZE.xs }}> · removed by Steups!</span>
              )}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {answer.revealed ? answer.value : ''}
            </span>
          </div>
        ))}
      </div>

      <p style={{ ...ui.muted, marginTop: ui.SPACING.xs, fontSize: ui.FONT_SIZE.xs }}>
        Pot: {board.accumulatedPoints} · Strikes: {board.strikes}/{board.maxStrikes}
      </p>
    </div>
  );
}

/**
 * Face-off: buzzer, then the 3s answer window for whoever currently has it.
 *
 * The buzzer is enabled ONLY for the two face-off participants, and only
 * while the buzzer is genuinely open (`status === 'reading'`) — anyone else
 * sees a waiting/inactive state and sends nothing.
 */
function Faceoff({
  round4,
  teams,
  yourTeamId,
  paused,
  submit,
}: {
  round4: Round4StateView;
  teams: readonly GameTeamView[];
  yourTeamId: TeamId | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const [buzzSent, setBuzzSent] = useState(false);
  const faceoff = round4.current?.faceoff ?? null;
  if (faceoff === null) return null;

  const isParticipant = yourTeamId !== null && faceoff.participantTeamIds.includes(yourTeamId);
  const buzzerOpen = faceoff.status === 'reading';
  const youHaveTheFloor =
    (faceoff.status === 'buzzed' && faceoff.buzzedTeamId === yourTeamId) ||
    (faceoff.status === 'opponent_chance' && faceoff.opponentTeamId === yourTeamId);

  const buzz = async () => {
    if (submit === undefined || busy || buzzSent) return;
    setBusy(true);
    setBuzzSent(true);
    try {
      await submit(ROUND4_INTENTS.SUBMIT_BUZZ);
    } finally {
      setBusy(false);
    }
  };

  const submitAnswer = async () => {
    if (submit === undefined || busy || answer.trim() === '') return;
    setBusy(true);
    try {
      await submit(ROUND4_INTENTS.SUBMIT_FACEOFF_ANSWER, { answer: answer.trim() });
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
        <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>
          {round4.inactiveTeamId === yourTeamId
            ? 'Your team is waiting this matchup out.'
            : 'Watching the face-off — not your turn.'}
        </p>
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
      ) : faceoff.buzzedTeamId === yourTeamId || faceoff.opponentTeamId === yourTeamId ? (
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

          {youHaveTheFloor && (
            <>
              {faceoff.answerTimer !== null && (
                <TimerDisplay
                  remainingMs={faceoff.answerTimer.remainingMs}
                  paused={faceoff.answerTimer.paused}
                  key={faceoff.answerTimer.startedAt}
                />
              )}
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
          )}
          {!youHaveTheFloor && faceoff.status === 'buzzed' && (
            <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>Waiting on the Host's ruling…</p>
          )}
        </>
      ) : (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>
          {faceoff.status === 'decided'
            ? faceoff.winningTeamId === yourTeamId
              ? 'Your team won the face-off!'
              : 'The other team won the face-off.'
            : 'Waiting…'}
        </p>
      )}

      {faceoff.status === 'decided' && faceoff.winningTeamId === yourTeamId && (
        <PlayOrPass
          faceoff={faceoff}
          teams={teams}
          paused={paused}
          {...(submit === undefined ? {} : { submit })}
        />
      )}
      {faceoff.status === 'decided' && faceoff.winningTeamId !== null && faceoff.winningTeamId !== yourTeamId && (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>
          Waiting for {teamLabel(faceoff.winningTeamId)} to choose PLAY or PASS…
        </p>
      )}
    </div>
  );
}

/**
 * PLAY or PASS — shown and enabled only for the face-off winner's team.
 *
 * Sends the CONTROLLING team's roster as `playerOrder` on the same intent
 * (room.ts's `#chooseRound4PlayOrPass` accepts it as an optional one-step
 * convenience — a no-op if omitted). Without it, `boardPlay.playerOrder`
 * stays empty and no player's client would ever satisfy `isActivePlayer` in
 * `BoardPlay` below, silently stranding board play with no enabled input for
 * anyone even though the server itself only checks the controlling TEAM.
 * PLAY seats the winner's own roster; PASS hands the board to the OPPONENT,
 * so their roster is used instead.
 */
function PlayOrPass({
  faceoff,
  teams,
  paused,
  submit,
}: {
  faceoff: Round4FaceoffView;
  teams: readonly GameTeamView[];
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [busy, setBusy] = useState(false);

  const choose = async (decision: 'PLAY' | 'PASS') => {
    if (submit === undefined || busy) return;
    setBusy(true);
    try {
      const controllingTeamId =
        decision === 'PLAY'
          ? faceoff.winningTeamId
          : faceoff.participantTeamIds.find((t) => t !== faceoff.winningTeamId) ?? null;
      const playerOrder = teams.find((t) => t.teamId === controllingTeamId)?.memberIds ?? [];
      await submit(ROUND4_INTENTS.CHOOSE_PLAY_OR_PASS, { decision, playerOrder });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: ui.SPACING.md }}>
      <p style={{ margin: 0, fontWeight: ui.FONT_WEIGHT.bold }}>Choose:</p>
      <div style={{ display: 'flex', gap: ui.SPACING.sm, marginTop: ui.SPACING.sm }}>
        <button
          type="button"
          disabled={busy || paused || submit === undefined}
          onClick={() => void choose('PLAY')}
          style={{ ...ui.button, flex: 1 }}
        >
          PLAY
        </button>
        <button
          type="button"
          disabled={busy || paused || submit === undefined}
          onClick={() => void choose('PASS')}
          style={{ ...ui.secondaryButton, flex: 1 }}
        >
          PASS
        </button>
      </div>
    </div>
  );
}

/**
 * Normal board play. Only the active player of the controlling team sees an
 * enabled input; everyone else sees public state only. The 5s turn timer is
 * shown to every viewer — it is public state, same as strikes and the pot.
 */
function BoardPlay({
  round4,
  yourTeamId,
  yourPlayerId,
  paused,
  submit,
}: {
  round4: Round4StateView;
  yourTeamId: TeamId | null;
  yourPlayerId: string | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const [awaitingRuling, setAwaitingRuling] = useState(false);
  const boardPlay = round4.current?.boardPlay ?? null;
  if (boardPlay === null) return null;

  const onControllingTeam = yourTeamId === boardPlay.controllingTeamId;
  const currentPlayerId = boardPlay.playerOrder[boardPlay.currentPlayerIndex] ?? null;
  const isActivePlayer =
    onControllingTeam && yourPlayerId !== null && yourPlayerId === currentPlayerId;

  const submitAnswer = async () => {
    if (submit === undefined || busy || answer.trim() === '') return;
    setBusy(true);
    try {
      const result = await submit(ROUND4_INTENTS.SUBMIT_BOARD_ANSWER, { answer: answer.trim() });
      if (result.ok) {
        setAnswer('');
        setAwaitingRuling(false);
      } else {
        // "No confident board match. Awaiting a Host ruling." — never guess
        // client-side; wait for the Host rather than resubmitting blindly.
        setAwaitingRuling(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ textAlign: 'center', marginTop: ui.SPACING.md }}>
      <p style={{ fontSize: ui.FONT_SIZE.lg, fontWeight: ui.FONT_WEIGHT.bold, margin: 0 }}>
        BOARD PLAY
      </p>
      <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>
        On the board: {teamLabel(boardPlay.controllingTeamId)}
      </p>

      {boardPlay.turnTimer !== null && (
        <TimerDisplay
          remainingMs={boardPlay.turnTimer.remainingMs}
          paused={boardPlay.turnTimer.paused}
          key={boardPlay.turnTimer.startedAt}
        />
      )}

      {isActivePlayer ? (
        awaitingRuling ? (
          <p style={{ ...ui.muted, marginTop: ui.SPACING.sm, color: ui.COLOR.warning }}>
            Waiting for the Host to rule on that answer…
          </p>
        ) : (
          <>
            <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>Your turn</p>
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
        )
      ) : (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>
          {onControllingTeam ? 'Waiting for your turn…' : 'Watching — not your team\'s turn.'}
        </p>
      )}
    </div>
  );
}

/**
 * Steal. 30s confer window (shown to everyone — public state), wager, then
 * the final answer — authorized to the stealing team only.
 */
function Steal({
  round4,
  yourTeamId,
  paused,
  submit,
}: {
  round4: Round4StateView;
  yourTeamId: TeamId | null;
  paused: boolean;
  submit?: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [wagerInput, setWagerInput] = useState('');
  const [answer, setAnswer] = useState('');
  const steal = round4.current?.steal ?? null;
  if (steal === null) return null;

  const isStealingTeam = yourTeamId === steal.stealingTeamId;
  const hasWager = steal.wagerAmount !== null;

  const lockWager = async () => {
    if (submit === undefined || busy || wagerInput === '') return;
    setBusy(true);
    try {
      await submit(ROUND4_INTENTS.SUBMIT_STEAL_WAGER, { amount: Number(wagerInput) });
      setWagerInput('');
    } finally {
      setBusy(false);
    }
  };

  const submitAnswer = async () => {
    if (submit === undefined || busy || answer.trim() === '') return;
    setBusy(true);
    try {
      await submit(ROUND4_INTENTS.SUBMIT_STEAL_ANSWER, { answer: answer.trim() });
      setAnswer('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ textAlign: 'center', marginTop: ui.SPACING.md }}>
      <p style={{ fontSize: ui.FONT_SIZE.lg, fontWeight: ui.FONT_WEIGHT.bold, margin: 0 }}>
        STEAL
      </p>
      <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>
        {teamLabel(steal.stealingTeamId)} stealing from {teamLabel(steal.defendingTeamId)}
      </p>

      {steal.conferTimer !== null && (
        <TimerDisplay
          remainingMs={steal.conferTimer.remainingMs}
          paused={steal.conferTimer.paused}
          key={steal.conferTimer.startedAt}
        />
      )}

      {steal.resolved ? (
        <p
          style={{
            marginTop: ui.SPACING.sm,
            fontWeight: ui.FONT_WEIGHT.bold,
            color: steal.won === true ? ui.COLOR.success : ui.COLOR.danger,
          }}
        >
          {steal.won === true ? 'STEAL SUCCEEDED' : 'STEAL FAILED'}
        </p>
      ) : !isStealingTeam ? (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>
          Waiting for {teamLabel(steal.stealingTeamId)} to confer and answer…
        </p>
      ) : !hasWager ? (
        <>
          <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>
            Lock your wager (0 or more — up to 50% of your current BB;
            the server enforces the real cap).
          </p>
          <input
            type="number"
            inputMode="numeric"
            value={wagerInput}
            onChange={(e) => setWagerInput(e.target.value)}
            placeholder="Wager amount"
            style={{ ...ui.input, marginTop: ui.SPACING.sm }}
            disabled={busy || paused}
          />
          <button
            type="button"
            disabled={busy || paused || wagerInput === '' || submit === undefined}
            onClick={() => void lockWager()}
            style={{ ...ui.button, marginTop: ui.SPACING.sm }}
          >
            LOCK WAGER
          </button>
        </>
      ) : (
        <>
          <p style={{ ...ui.muted, marginTop: ui.SPACING.sm }}>
            Wager locked: {steal.wagerAmount} BB · 30 seconds to confer
          </p>
          <input
            type="text"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Your team's one final answer"
            style={{ ...ui.input, marginTop: ui.SPACING.sm }}
            disabled={busy || paused}
          />
          <button
            type="button"
            disabled={busy || paused || answer.trim() === '' || submit === undefined}
            onClick={() => void submitAnswer()}
            style={{ ...ui.button, marginTop: ui.SPACING.sm }}
          >
            SUBMIT FINAL ANSWER
          </button>
        </>
      )}
    </div>
  );
}

function RoundComplete({
  round4,
  yourTeamId,
}: {
  round4: Round4StateView;
  yourTeamId: TeamId | null;
}) {
  return (
    <div style={{ textAlign: 'center', marginTop: ui.SPACING.md }}>
      <p style={{ fontSize: ui.FONT_SIZE.lg, fontWeight: ui.FONT_WEIGHT.bold, color: ui.COLOR.success, margin: 0 }}>
        ROUND 4 COMPLETE
      </p>
      {round4.round4WinnerTeamId !== null ? (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>
          {round4.round4WinnerTeamId === yourTeamId
            ? 'Your team wins!'
            : `${teamLabel(round4.round4WinnerTeamId)} wins.`}
        </p>
      ) : (
        <p style={{ ...ui.muted, marginTop: ui.SPACING.xs }}>Tied leaders — Sudden Death next.</p>
      )}
    </div>
  );
}

/**
 * A local countdown built from a `Round4TimerView`.
 *
 * Same discipline, and the same shape, as `PlayerGame.tsx`'s own
 * `TimerDisplay`: the server decides expiry (D-022, and Round4's own timer
 * poll) and computes `remainingMs` fresh on every snapshot — this only
 * interpolates smoothly between snapshots. The caller re-anchors a genuinely
 * NEW window (a new turn, a new steal) with a React `key` on the deadline's
 * `startedAt`, exactly like `PlayerGame.tsx` keys on `timerId`.
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

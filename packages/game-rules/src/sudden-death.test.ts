import { describe, expect, it } from 'vitest';
import { asTeamId, type Round4Survey } from '@bb/protocol';
import { FakeClock } from './clock.js';
import { SuddenDeath } from './sudden-death.js';

/**
 * Sudden Death. Phase 7D-B2. GAME_RULES_LOCKED.md §21, replaced by D-034.
 *
 * Exercises the `SuddenDeath` class directly, the same way `round4.test.ts`
 * exercises `Round4` — independent of the room/network wiring layer.
 */

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');

function question(overrides: Partial<Round4Survey> = {}): Round4Survey {
  return {
    surveyId: 'sd-test-q1',
    prompt: 'TEST SUDDEN DEATH: name a test placeholder color',
    questionNumber: 1,
    status: 'TEST',
    source: 'TEST_FIXTURE',
    answers: [
      { answerId: 'sd-a1', rank: 1, text: 'TEST RED', value: 40 },
      { answerId: 'sd-a2', rank: 2, text: 'TEST BLUE', value: 25 },
      { answerId: 'sd-a3', rank: 3, text: 'TEST GREEN', value: 15 },
    ],
    ...overrides,
  };
}

function newSuddenDeath(): { sd: SuddenDeath; clock: FakeClock } {
  const clock = new FakeClock(0);
  const sd = new SuddenDeath({ clock });
  return { sd, clock };
}

function begun(): { sd: SuddenDeath; clock: FakeClock } {
  const { sd, clock } = newSuddenDeath();
  expect(sd.begin([TEAM_A, TEAM_B]).ok).toBe(true);
  return { sd, clock };
}

describe('SuddenDeath — entry', () => {
  it('begins with exactly two named teams', () => {
    const { sd } = newSuddenDeath();
    const began = sd.begin([TEAM_A, TEAM_B]);
    expect(began.ok).toBe(true);
    expect(sd.active).toBe(true);
    expect(sd.participantTeamIds).toEqual([TEAM_A, TEAM_B]);
  });

  it('refuses to begin with anything other than exactly two teams', () => {
    const { sd } = newSuddenDeath();
    expect(sd.begin([TEAM_A]).ok).toBe(false);
  });

  it('refuses to begin twice', () => {
    const { sd } = begun();
    expect(sd.begin([TEAM_A, TEAM_B]).ok).toBe(false);
  });
});

describe('SuddenDeath — face-off buzz and streaks', () => {
  it('the first buzz locks the race; the other team cannot then buzz', () => {
    const { sd } = begun();
    sd.startFaceoff(question());
    const first = sd.buzz(TEAM_A);
    expect(first.ok).toBe(true);
    const second = sd.buzz(TEAM_B);
    expect(second.ok).toBe(false);
  });

  it('rejects a buzz from a team not in this Sudden Death', () => {
    const { sd } = begun();
    sd.startFaceoff(question());
    const outsider = sd.buzz(asTeamId('TEAM_C'));
    expect(outsider.ok).toBe(false);
  });

  it('the #1 answer wins the face-off and starts a streak of 1', () => {
    const { sd } = begun();
    sd.startFaceoff(question());
    sd.buzz(TEAM_A);
    const ruled = sd.ruleFaceoffAnswer({ teamId: TEAM_A, correct: true });
    expect(ruled.ok).toBe(true);
    if (ruled.ok) {
      expect(ruled.value.faceoff.winningTeamId).toBe(TEAM_A);
      expect(ruled.value.streakWinnerTeamId).toBeNull(); // only 1 win, needs 2
    }
    const view = sd.view();
    expect(view.streaks.find((s) => s.teamId === TEAM_A)?.consecutiveWins).toBe(1);
  });

  it('two consecutive wins for the same team ends Sudden Death', () => {
    const { sd } = begun();
    sd.startFaceoff(question());
    sd.buzz(TEAM_A);
    sd.ruleFaceoffAnswer({ teamId: TEAM_A, correct: true });

    sd.startFaceoff(question());
    sd.buzz(TEAM_A);
    const ruled = sd.ruleFaceoffAnswer({ teamId: TEAM_A, correct: true });
    expect(ruled.ok).toBe(true);
    if (ruled.ok) expect(ruled.value.streakWinnerTeamId).toBe(TEAM_A);
    expect(sd.complete).toBe(true);
    expect(sd.winnerTeamId).toBe(TEAM_A);
  });

  it('a WRONG answer loses that face-off immediately for the team that answered — no opponent chance', () => {
    const { sd } = begun();
    sd.startFaceoff(question());
    sd.buzz(TEAM_A);
    const ruled = sd.ruleFaceoffAnswer({ teamId: TEAM_A, correct: false });
    expect(ruled.ok).toBe(true);
    if (ruled.ok) expect(ruled.value.faceoff.winningTeamId).toBe(TEAM_B);
  });

  it('a wrong answer resets the ANSWERING team streak and gives the opponent a streak of 1', () => {
    const { sd } = begun();
    // TEAM_A wins face-off 1.
    sd.startFaceoff(question());
    sd.buzz(TEAM_A);
    sd.ruleFaceoffAnswer({ teamId: TEAM_A, correct: true });
    expect(sd.view().streaks.find((s) => s.teamId === TEAM_A)?.consecutiveWins).toBe(1);

    // TEAM_A buzzes face-off 2 but answers wrong — TEAM_B wins it, resetting A to 0.
    sd.startFaceoff(question());
    sd.buzz(TEAM_A);
    sd.ruleFaceoffAnswer({ teamId: TEAM_A, correct: false });

    const view = sd.view();
    expect(view.streaks.find((s) => s.teamId === TEAM_A)?.consecutiveWins).toBe(0);
    expect(view.streaks.find((s) => s.teamId === TEAM_B)?.consecutiveWins).toBe(1);
  });

  it('a streak is CONSECUTIVE — a loss in between resets it, so alternating wins never reaches 2', () => {
    const { sd } = begun();
    sd.startFaceoff(question());
    sd.buzz(TEAM_A);
    sd.ruleFaceoffAnswer({ teamId: TEAM_A, correct: true }); // A: 1

    sd.startFaceoff(question());
    sd.buzz(TEAM_B);
    sd.ruleFaceoffAnswer({ teamId: TEAM_B, correct: true }); // B wins outright: B: 1, A: 0

    sd.startFaceoff(question());
    sd.buzz(TEAM_A);
    const ruled = sd.ruleFaceoffAnswer({ teamId: TEAM_A, correct: true }); // A: 1 again
    expect(sd.complete).toBe(false);
    if (ruled.ok) expect(ruled.value.streakWinnerTeamId).toBeNull();
  });

  it('a buzz-then-timeout is ruled through the same correct:false path and loses outright', () => {
    const { sd, clock } = begun();
    sd.startFaceoff(question());
    sd.buzz(TEAM_A);
    clock.advance(3_001);
    expect(sd.faceoffAnswerWindowExpired()).toBe(true);
    // The room rules a timeout as correct:false — same method, same effect as
    // a wrong answer, per §21 / D-034 ("buzz then fail to answer... loses").
    const ruled = sd.ruleFaceoffAnswer({ teamId: TEAM_A, correct: false });
    expect(ruled.ok).toBe(true);
    if (ruled.ok) expect(ruled.value.faceoff.winningTeamId).toBe(TEAM_B);
  });
});

describe('SuddenDeath — no decision (neither side answers)', () => {
  it('recordNoDecision decides nothing and preserves both streaks', () => {
    const { sd } = begun();
    sd.startFaceoff(question());
    sd.buzz(TEAM_A);
    sd.ruleFaceoffAnswer({ teamId: TEAM_A, correct: true }); // A: 1

    sd.startFaceoff(question());
    const recorded = sd.recordNoDecision();
    expect(recorded.ok).toBe(true);
    if (recorded.ok) {
      expect(recorded.value.winningTeamId).toBeNull();
      expect(recorded.value.noDecision).toBe(true);
    }
    // A's streak survives a no-decision face-off untouched.
    expect(sd.view().streaks.find((s) => s.teamId === TEAM_A)?.consecutiveWins).toBe(1);
    expect(sd.complete).toBe(false);
  });

  it('a fresh face-off can start after a no-decision', () => {
    const { sd } = begun();
    sd.startFaceoff(question());
    sd.recordNoDecision();
    const started = sd.startFaceoff(question());
    expect(started.ok).toBe(true);
  });
});

describe('SuddenDeath — the answer timer', () => {
  it('is null before anyone buzzes, and starts at the locked 3s duration on buzz', () => {
    const { sd } = begun();
    sd.startFaceoff(question());
    expect(sd.view().current?.answerTimer).toBeNull();
    sd.buzz(TEAM_A);
    const timer = sd.view().current?.answerTimer;
    expect(timer?.durationMs).toBe(3_000);
    expect(timer?.remainingMs).toBe(3_000);
  });

  it('pausing and resuming preserves the exact remaining time (D-011)', () => {
    const { sd, clock } = begun();
    sd.startFaceoff(question());
    sd.buzz(TEAM_A);
    clock.advance(1_000);
    sd.pauseTimers();
    const paused = sd.view().current?.answerTimer;
    expect(paused?.paused).toBe(true);
    expect(paused?.remainingMs).toBe(2_000);

    clock.advance(30_000); // a long "disconnect"
    sd.resumeTimers();
    const resumed = sd.view().current?.answerTimer;
    expect(resumed?.paused).toBe(false);
    expect(resumed?.remainingMs).toBe(2_000);
  });
});

describe('SuddenDeath — hidden board / no cards, wagers or multipliers (§21, unchanged by D-034)', () => {
  it('the face-off view never carries the board answers, only the prompt', () => {
    const { sd } = begun();
    sd.startFaceoff(question());
    const view = sd.view();
    expect(view.current?.prompt).toBe('TEST SUDDEN DEATH: name a test placeholder color');
    expect(JSON.stringify(view)).not.toContain('TEST RED');
    expect(JSON.stringify(view)).not.toContain('TEST BLUE');
  });

  it('currentQuestionAnswers exists only for the room to grade against — never in the client view', () => {
    const { sd } = begun();
    sd.startFaceoff(question());
    expect(sd.currentQuestionAnswers.length).toBe(3);
    expect(JSON.stringify(sd.view())).not.toContain('TEST GREEN');
  });
});

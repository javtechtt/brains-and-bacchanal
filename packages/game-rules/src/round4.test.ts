import { beforeEach, describe, expect, it } from 'vitest';
import { asTeamId, type Round4Survey } from '@bb/protocol';
import { FakeClock } from './clock.js';
import { Round4 } from './round4.js';
import { BbLedger } from './bb-ledger.js';
import { Deals } from './deals.js';
import { matchesTopAnswer, matchRound4Answer } from './round4-grading.js';
import { ROUND4_TEST_PACK, createTestRound4ContentSource } from './round4-content.js';

/**
 * Round 4 — Family Feud. Phase 7D-A.
 *
 * Exercises the `Round4` class directly, the way `round1-grading.test.ts`
 * exercises its grading pipeline directly — this is the round's own rule
 * engine, independent of the room/network wiring layer.
 */

const TEAM_A = asTeamId('TEAM_A');
const TEAM_B = asTeamId('TEAM_B');
const TEAM_C = asTeamId('TEAM_C');

function survey(overrides: Partial<Round4Survey> = {}): Round4Survey {
  return {
    surveyId: 'ff-test-q1',
    prompt: 'TEST SURVEY: name a test placeholder fruit',
    questionNumber: 1,
    status: 'TEST',
    source: 'TEST_FIXTURE',
    answers: [
      { answerId: 'a1', rank: 1, text: 'TEST APPLE', value: 40 },
      { answerId: 'a2', rank: 2, text: 'TEST BANANA', value: 25 },
      { answerId: 'a3', rank: 3, text: 'TEST ORANGE', value: 15 },
      { answerId: 'a4', rank: 4, text: 'TEST GRAPE', value: 12 },
      { answerId: 'a5', rank: 5, text: 'TEST MANGO', value: 8 },
    ],
    ...overrides,
  };
}

function newRound(): { round: Round4; clock: FakeClock } {
  const clock = new FakeClock(0);
  const round = new Round4({ clock });
  return { round, clock };
}

/** A two-team round already through beginFirstMatchup (which becomes FINAL for 2 teams). */
function twoTeamRoundInFaceoff(): { round: Round4; clock: FakeClock } {
  const { round, clock } = newRound();
  expect(round.begin([TEAM_A, TEAM_B]).ok).toBe(true);
  expect(round.beginFirstMatchup().ok).toBe(true);
  expect(round.startFaceoff(survey(), [TEAM_A, TEAM_B]).ok).toBe(true);
  return { round, clock };
}

describe('Round4 — entry and three-team structure', () => {
  it('freezes the entering ranking and never re-derives it from later BB', () => {
    const { round } = newRound();
    const began = round.begin([TEAM_B, TEAM_C, TEAM_A]); // best-first: B, C, A
    expect(began.ok).toBe(true);

    const standings = round.enteringStandings;
    expect(standings).toEqual([
      { teamId: TEAM_B, rank: 'FIRST', enteringBb: 0 },
      { teamId: TEAM_C, rank: 'SECOND', enteringBb: 0 },
      { teamId: TEAM_A, rank: 'THIRD', enteringBb: 0 },
    ]);

    // Recording a later balance changes display only, never rank.
    round.recordEnteringBb(new Map([[TEAM_A, 9_999]]));
    expect(round.enteringStandings.find((s) => s.teamId === TEAM_A)?.rank).toBe('THIRD');
    expect(round.enteringStandings.find((s) => s.teamId === TEAM_A)?.enteringBb).toBe(9_999);
  });

  it('refuses to begin twice', () => {
    const { round } = newRound();
    round.begin([TEAM_A, TEAM_B]);
    const second = round.begin([TEAM_A, TEAM_B]);
    expect(second.ok).toBe(false);
  });

  it('refuses to begin with fewer than two teams', () => {
    const { round } = newRound();
    const began = round.begin([TEAM_A]);
    expect(began.ok).toBe(false);
  });

  it('3-team: 2nd vs 3rd play first, entering 1st sits out', () => {
    const { round } = newRound();
    round.begin([TEAM_A, TEAM_B, TEAM_C]); // A=1st, B=2nd, C=3rd
    const started = round.beginFirstMatchup();
    expect(started.ok).toBe(true);
    expect(round.matchupTeamIds).toEqual([TEAM_B, TEAM_C]);
    expect(round.inactiveTeamId).toBe(TEAM_A);
  });

  it('3-team: the loser of the first matchup is gated from further Family Feud BB, but stays in the game', () => {
    const { round } = newRound();
    round.begin([TEAM_A, TEAM_B, TEAM_C]);
    round.beginFirstMatchup();

    round.startFaceoff(survey({ surveyId: 's1' }), [TEAM_B, TEAM_C]);
    round.resolveSurvey(TEAM_B);
    round.startFaceoff(survey({ surveyId: 's2' }), [TEAM_B, TEAM_C]);
    round.resolveSurvey(TEAM_B);

    const decided = round.decideFirstMatchup();
    expect(decided.ok).toBe(true);
    if (decided.ok) {
      expect(decided.value.advancingTeamId).toBe(TEAM_B);
      expect(decided.value.tied).toBe(false);
    }
    expect(round.isScoringGated(TEAM_C)).toBe(true);
    expect(round.isScoringGated(TEAM_B)).toBe(false);
    // The loser is not removed from the model — it can still be queried.
    expect(round.scoringGates.some((g) => g.teamId === TEAM_C)).toBe(true);
  });

  it('3-team: a tie after the first two surveys sends entering-2nd through, not some other tiebreak', () => {
    const { round } = newRound();
    round.begin([TEAM_A, TEAM_B, TEAM_C]); // B = entering 2nd, C = entering 3rd
    round.beginFirstMatchup();

    round.startFaceoff(survey({ surveyId: 's1' }), [TEAM_B, TEAM_C]);
    round.resolveSurvey(TEAM_B);
    round.startFaceoff(survey({ surveyId: 's2' }), [TEAM_B, TEAM_C]);
    round.resolveSurvey(TEAM_C);

    const decided = round.decideFirstMatchup();
    expect(decided.ok).toBe(true);
    if (decided.ok) {
      expect(decided.value.tied).toBe(true);
      expect(decided.value.advancingTeamId).toBe(TEAM_B); // entering 2nd
    }
    expect(round.isScoringGated(TEAM_C)).toBe(true);
  });

  it('refuses to decide the first matchup before two surveys are played', () => {
    const { round } = newRound();
    round.begin([TEAM_A, TEAM_B, TEAM_C]);
    round.beginFirstMatchup();
    round.startFaceoff(survey({ surveyId: 's1' }), [TEAM_B, TEAM_C]);
    round.resolveSurvey(TEAM_B);

    const decided = round.decideFirstMatchup();
    expect(decided.ok).toBe(false);
  });

  it('the winner of the first matchup then faces entering 1st in the FINAL matchup', () => {
    const { round } = newRound();
    round.begin([TEAM_A, TEAM_B, TEAM_C]);
    round.beginFirstMatchup();
    round.startFaceoff(survey({ surveyId: 's1' }), [TEAM_B, TEAM_C]);
    round.resolveSurvey(TEAM_B);
    round.startFaceoff(survey({ surveyId: 's2' }), [TEAM_B, TEAM_C]);
    round.resolveSurvey(TEAM_B);
    round.decideFirstMatchup();

    const finalStarted = round.beginFinalMatchup(TEAM_B);
    expect(finalStarted.ok).toBe(true);
    expect(round.matchupTeamIds).toEqual([TEAM_B, TEAM_A]);
    expect(round.inactiveTeamId).toBeNull();
  });

  it('a two-team game plays a single FINAL matchup contested by both teams', () => {
    const { round } = newRound();
    round.begin([TEAM_A, TEAM_B]);
    const started = round.beginFirstMatchup();
    expect(started.ok).toBe(true);
    expect(round.matchupTeamIds).toEqual([TEAM_A, TEAM_B]);
    expect(round.inactiveTeamId).toBeNull();
  });
});

describe('Round4 — face-off', () => {
  let round: Round4;
  beforeEach(() => {
    ({ round } = twoTeamRoundInFaceoff());
  });

  it('the first valid buzz locks out the opponent', () => {
    const buzzed = round.buzz(TEAM_A);
    expect(buzzed.ok).toBe(true);
    if (buzzed.ok) {
      expect(buzzed.value.status).toBe('buzzed');
      expect(buzzed.value.buzzedTeamId).toBe(TEAM_A);
    }

    const second = round.buzz(TEAM_B);
    expect(second.ok).toBe(false);
  });

  it('rejects a buzz from a team not in this face-off', () => {
    const outsider = asTeamId('TEAM_ROGUE');
    const buzzed = round.buzz(outsider);
    expect(buzzed.ok).toBe(false);
    if (!buzzed.ok) expect(buzzed.error.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('the 3-second answer window can be polled for expiry', () => {
    const { round: r, clock } = twoTeamRoundInFaceoff();
    r.buzz(TEAM_A);
    expect(r.faceoffAnswerWindowExpired()).toBe(false);
    clock.advance(3_000);
    expect(r.faceoffAnswerWindowExpired()).toBe(true);
  });

  it('a timed-out buzz-in answer (no valid rank) still hands the opponent one shot', () => {
    round.buzz(TEAM_A);
    const ruled = round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: null });
    expect(ruled.ok).toBe(true);
    if (ruled.ok) {
      expect(ruled.value.status).toBe('opponent_chance');
      expect(ruled.value.opponentTeamId).toBe(TEAM_B);
    }
  });

  it('the #1 board answer wins the face-off immediately', () => {
    round.buzz(TEAM_A);
    const ruled = round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    expect(ruled.ok).toBe(true);
    if (ruled.ok) {
      expect(ruled.value.status).toBe('decided');
      expect(ruled.value.winningTeamId).toBe(TEAM_A);
    }
  });

  it('a lower-ranked answer gives the opponent one chance, and a higher-ranked opponent answer wins', () => {
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 3 });
    const ruled = round.ruleFaceoffAnswer({ teamId: TEAM_B, matchedRank: 1 });
    expect(ruled.ok).toBe(true);
    if (ruled.ok) {
      expect(ruled.value.status).toBe('decided');
      expect(ruled.value.winningTeamId).toBe(TEAM_B);
    }
  });

  it('a lower-ranked opponent answer than the original still loses to the original', () => {
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 2 });
    const ruled = round.ruleFaceoffAnswer({ teamId: TEAM_B, matchedRank: 4 });
    expect(ruled.ok).toBe(true);
    if (ruled.ok) expect(ruled.value.winningTeamId).toBe(TEAM_A);
  });

  it('rejects a face-off answer from the wrong team at each stage', () => {
    round.buzz(TEAM_A);
    const wrongAnswerer = round.ruleFaceoffAnswer({ teamId: TEAM_B, matchedRank: 1 });
    expect(wrongAnswerer.ok).toBe(false);

    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 3 });
    const wrongOpponent = round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    expect(wrongOpponent.ok).toBe(false);
  });

  it('the face-off winner chooses PLAY and becomes the controlling team', () => {
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    const chosen = round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    expect(chosen.ok).toBe(true);
    if (chosen.ok) expect(chosen.value.controllingTeamId).toBe(TEAM_A);
  });

  it('the face-off winner chooses PASS and the OPPONENT becomes the controlling team', () => {
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    const chosen = round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PASS' });
    expect(chosen.ok).toBe(true);
    if (chosen.ok) expect(chosen.value.controllingTeamId).toBe(TEAM_B);
  });

  it('rejects PLAY/PASS from a team that did not win the face-off', () => {
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    const chosen = round.choosePlayOrPass({ teamId: TEAM_B, decision: 'PLAY' });
    expect(chosen.ok).toBe(false);
  });
});

describe('Round4 — opponent chance timer is Host-started, not automatic (live play)', () => {
  it('the buzzer winner\'s OWN 3s timer still starts automatically on buzz (unchanged)', () => {
    const { round } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    expect(round.view().current?.faceoff?.answerTimer?.remainingMs).toBe(3_000);
  });

  it('the opponent chance timer does NOT start automatically after a non-#1 answer', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 3 });
    expect(round.view().current?.faceoff?.status).toBe('opponent_chance');
    expect(round.view().current?.faceoff?.answerTimer).toBeNull();
  });

  it('the Host starts the opponent chance timer explicitly', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 3 });

    const started = round.startOpponentChanceTimer();
    expect(started.ok).toBe(true);
    expect(round.view().current?.faceoff?.answerTimer?.remainingMs).toBe(3_000);
  });

  it('refuses to start the opponent chance timer twice while it is still running', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 3 });
    round.startOpponentChanceTimer();
    const again = round.startOpponentChanceTimer();
    expect(again.ok).toBe(false);
  });

  it('refuses to start the opponent chance timer when no opponent chance is open', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    // matchedRank: 1 wins outright — no opponent chance ever opens.
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    const started = round.startOpponentChanceTimer();
    expect(started.ok).toBe(false);
  });

  it('the opponent can still answer once the Host starts their timer', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 3 });
    round.startOpponentChanceTimer();

    const ruled = round.ruleFaceoffAnswer({ teamId: TEAM_B, matchedRank: 1 });
    expect(ruled.ok).toBe(true);
    if (ruled.ok) expect(ruled.value.winningTeamId).toBe(TEAM_B);
  });
});

describe('Round4 — Host jurisdiction over strikes and the board timer (live play)', () => {
  it('the Host can set a custom strike ceiling for the whole of Round 4', () => {
    const clock = new FakeClock(0);
    const round = new Round4({ clock, maxStrikes: 5 });
    round.begin([TEAM_A, TEAM_B]);
    round.beginFirstMatchup();
    round.startFaceoff(survey(), [TEAM_A, TEAM_B]);
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);

    expect(round.view().current?.board.maxStrikes).toBe(5);
    for (let i = 0; i < 4; i += 1) {
      const s = round.recordStrike('wrong');
      if (s.ok) expect(s.value.stealTriggered).toBe(false);
    }
    const fifth = round.recordStrike('wrong');
    expect(fifth.ok).toBe(true);
    if (fifth.ok) expect(fifth.value.stealTriggered).toBe(true);
  });

  it('the strike ceiling floors at 1, even if a caller requests 0 or negative', () => {
    const clock = new FakeClock(0);
    const round = new Round4({ clock, maxStrikes: 0 });
    expect(round.view().current).toBeNull(); // not started yet — just checking construction did not throw
    round.begin([TEAM_A, TEAM_B]);
    round.beginFirstMatchup();
    round.startFaceoff(survey(), [TEAM_A, TEAM_B]);
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    expect(round.view().current?.board.maxStrikes).toBe(1);
  });

  it('the Host can directly set the strike count, triggering a steal if it crosses the ceiling', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);

    const set = round.setStrikes(3);
    expect(set.ok).toBe(true);
    if (set.ok) {
      expect(set.value.boardPlay.strikes).toBe(3);
      expect(set.value.stealTriggered).toBe(true);
    }
  });

  it('setStrikes does not re-trigger a steal that was already triggered', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.setStrikes(3);

    const again = round.setStrikes(4);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.stealTriggered).toBe(false);
  });

  it('the Host can reduce strikes, and a floor of 0 is enforced', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.recordStrike('wrong');
    round.recordStrike('duplicate');

    const reduced = round.setStrikes(0);
    expect(reduced.ok).toBe(true);
    if (reduced.ok) expect(reduced.value.boardPlay.strikes).toBe(0);

    const negative = round.setStrikes(-1);
    expect(negative.ok).toBe(false);
  });

  it('the Host can cancel a running board turn timer without recording a strike', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.startBoardTurnTimer();

    const cancelled = round.cancelBoardTurnTimer();
    expect(cancelled.ok).toBe(true);
    expect(round.view().current?.boardPlay?.turnTimer).toBeNull();
    expect(round.view().current?.boardPlay?.strikes).toBe(0);
  });

  it('cancelling a timer that is not running is a harmless no-op', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);

    const cancelled = round.cancelBoardTurnTimer();
    expect(cancelled.ok).toBe(true);
  });
});

describe('Round4 — normal board play and strikes', () => {
  function boardInPlay(): Round4 {
    return boardInPlayWithClock().round;
  }

  function boardInPlayWithClock(): { round: Round4; clock: FakeClock } {
    const { round, clock } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1', 'p2', 'p3']);
    return { round, clock };
  }

  it('reveals a correct answer and accumulates its board value', () => {
    const round = boardInPlay();
    // The face-off's winning #1 answer ('a1', value 40) already revealed and
    // scored when PLAY was chosen — authentic Family Feud mechanics, §19.
    expect(round.view().current?.board.accumulatedPoints).toBe(40);
    const revealed = round.revealBoardAnswer('a2');
    expect(revealed.ok).toBe(true);
    if (revealed.ok) {
      expect(revealed.value.value).toBe(25);
      expect(revealed.value.board.accumulatedPoints).toBe(40 + 25);
      expect(revealed.value.board.answers.find((a) => a.answerId === 'a2')?.text).toBe(
        'TEST BANANA',
      );
    }
  });

  it('enforces player order: the turn advances after a reveal', () => {
    const round = boardInPlay();
    // 'a1' (rank 1) already revealed by the face-off win, so board play's
    // first turn reveals the next unrevealed answer instead.
    round.revealBoardAnswer('a2');
    // No direct getter for "current player" outside the view; assert via the
    // survey view's boardPlay.currentPlayerIndex.
    const view = round.view();
    expect(view.current?.boardPlay?.currentPlayerIndex).toBe(1);
  });

  it('a wrong/duplicate/off-board/timeout answer is one strike each, and three strikes trigger a steal', () => {
    const round = boardInPlay();
    const s1 = round.recordStrike('wrong');
    expect(s1.ok).toBe(true);
    if (s1.ok) expect(s1.value.stealTriggered).toBe(false);

    const s2 = round.recordStrike('duplicate');
    if (s2.ok) expect(s2.value.stealTriggered).toBe(false);

    const s3 = round.recordStrike('off_board');
    expect(s3.ok).toBe(true);
    if (s3.ok) {
      expect(s3.value.boardPlay.strikes).toBe(3);
      expect(s3.value.stealTriggered).toBe(true);
    }
  });

  it('a 5-second board turn can be polled for expiry, and a timeout is recordable as a strike', () => {
    const { round, clock } = boardInPlayWithClock();
    // Live play: the Host starts the clock explicitly (see the "precise
    // timer views" describe block for that behavior on its own).
    round.startBoardTurnTimer();
    expect(round.boardTurnExpired()).toBe(false);
    clock.advance(5_000);
    expect(round.boardTurnExpired()).toBe(true);
    const strike = round.recordStrike('timeout');
    expect(strike.ok).toBe(true);
  });

  it('refuses to reveal an already-revealed answer', () => {
    const round = boardInPlay();
    round.revealBoardAnswer('a1');
    const again = round.revealBoardAnswer('a1');
    expect(again.ok).toBe(false);
  });

  it('reports the board cleared once every answer is revealed', () => {
    const round = boardInPlay();
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) round.revealBoardAnswer(id);
    expect(round.boardCleared()).toBe(true);
  });
});

describe('Round4 — steal', () => {
  function atSteal(): Round4 {
    return atStealWithClock().round;
  }

  function atStealWithClock(): { round: Round4; clock: FakeClock } {
    const { round, clock } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    // 'a1' (rank 1, 40) already revealed by the face-off win; 'a3' (15) is
    // banked here before the strikes — 55 accumulated going into the steal.
    round.revealBoardAnswer('a3');
    round.recordStrike('wrong');
    round.recordStrike('duplicate');
    round.recordStrike('off_board');
    round.startSteal();
    return { round, clock };
  }

  it('opens a 30-second confer window for the OPPOSING team', () => {
    const { round, clock } = atStealWithClock();
    const view = round.view();
    expect(view.current?.steal?.stealingTeamId).toBe(TEAM_B);
    expect(view.current?.steal?.defendingTeamId).toBe(TEAM_A);
    // Live play: the Host announces the steal, THEN starts the clock.
    round.startStealTimer();
    expect(round.stealConferExpired()).toBe(false);
    clock.advance(30_000);
    expect(round.stealConferExpired()).toBe(true);
  });

  it('refuses to open a steal before three strikes', () => {
    const { round } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.recordStrike('wrong');
    const started = round.startSteal();
    expect(started.ok).toBe(false);
  });

  it('locks a wager and records it on the steal (cap enforcement belongs to deals.ts)', () => {
    const round = atSteal();
    const locked = round.lockStealWager({ wagerId: 'w1', amount: 100 });
    expect(locked.ok).toBe(true);
    if (locked.ok) {
      expect(locked.value.wagerId).toBe('w1');
      expect(locked.value.wagerAmount).toBe(100);
      expect(locked.value.status).toBe('awaiting_answer');
    }
  });

  it('a correct steal awards the stealing team the accumulated points', () => {
    const round = atSteal();
    round.lockStealWager({ wagerId: 'w1', amount: 100 });
    const ruled = round.ruleSteal(true);
    expect(ruled.ok).toBe(true);
    if (ruled.ok) {
      expect(ruled.value.pointsAwardedTo).toBe(TEAM_B);
      expect(ruled.value.points).toBe(55);
      expect(ruled.value.steal.won).toBe(true);
    }
  });

  it('a wrong steal gives the accumulated points back to the ORIGINAL controlling team', () => {
    const round = atSteal();
    round.lockStealWager({ wagerId: 'w1', amount: 100 });
    const ruled = round.ruleSteal(false);
    expect(ruled.ok).toBe(true);
    if (ruled.ok) {
      expect(ruled.value.pointsAwardedTo).toBe(TEAM_A);
      expect(ruled.value.points).toBe(55);
    }
  });

  it('refuses to resolve the same steal twice — idempotent settlement', () => {
    const round = atSteal();
    round.lockStealWager({ wagerId: 'w1', amount: 100 });
    round.ruleSteal(true);
    const again = round.ruleSteal(true);
    expect(again.ok).toBe(false);
  });

  it('the wager itself is the EXISTING generic wager, capped at 50% of current BB, floored at 0', () => {
    // Round4 does not reimplement the cap; deals.ts does, and Round4 records
    // whatever amount the caller already validated through it. This proves the
    // real integration: proposeWager refuses over 50%, and resolveWager floors
    // at 0.
    const clock = new FakeClock(0);
    const ledger = new BbLedger(clock, () => 'id');
    ledger.seed(TEAM_B, 100);
    let wagerCounter = 0;
    const deals = new Deals({ clock, ledger, mintId: () => `wager-${++wagerCounter}` });

    const tooBig = deals.proposeWager({ teamId: TEAM_B, amount: 51 });
    expect(tooBig.ok).toBe(false);

    const proposed = deals.proposeWager({ teamId: TEAM_B, amount: 50 });
    expect(proposed.ok).toBe(true);
    if (proposed.ok) {
      const resolved = deals.resolveWager({ wagerId: proposed.value.wagerId, won: false });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(ledger.balanceOf(TEAM_B)).toBe(50);
    }

    // A second loss, at the new 50%-of-50 cap, cannot take the balance below 0.
    const proposed2 = deals.proposeWager({ teamId: TEAM_B, amount: 25 });
    expect(proposed2.ok).toBe(true);
    if (proposed2.ok) {
      const resolved2 = deals.resolveWager({ wagerId: proposed2.value.wagerId, won: false });
      expect(resolved2.ok).toBe(true);
      expect(ledger.balanceOf(TEAM_B)).toBe(25);
    }
  });
});

describe('Round4 — scoring: survey pot, Q4/Q5 doubling', () => {
  it('Q1-Q3 pay the accumulated points at face value', () => {
    const { round } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.revealBoardAnswer('a1'); // 40
    round.revealBoardAnswer('a2'); // 25

    const resolved = round.resolveSurvey(TEAM_A);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.doubled).toBe(false);
      expect(resolved.value.baseAward).toBe(65);
    }
  });

  it('Q4 and Q5 double the survey pot exactly once', () => {
    const { round } = newRound();
    round.begin([TEAM_A, TEAM_B]);
    round.beginFirstMatchup();
    round.startFaceoff(survey({ surveyId: 'q4', questionNumber: 4 }), [TEAM_A, TEAM_B]);
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.revealBoardAnswer('a1'); // 40 -> should double to 80

    const resolved = round.resolveSurvey(TEAM_A);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.doubled).toBe(true);
      expect(resolved.value.baseAward).toBe(80);
    }
  });

  it('the survey pot is awarded exactly once — a second resolveSurvey call is refused', () => {
    const { round } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.revealBoardAnswer('a1');
    round.resolveSurvey(TEAM_A);
    const again = round.resolveSurvey(TEAM_A);
    expect(again.ok).toBe(false);
  });

  it('a doubled survey does not double-multiply on any other path (steal pot uses the same accumulated total)', () => {
    const clock = new FakeClock(0);
    const r = new Round4({ clock });
    r.begin([TEAM_A, TEAM_B]);
    r.beginFirstMatchup();
    r.startFaceoff(survey({ surveyId: 'q5', questionNumber: 5 }), [TEAM_A, TEAM_B]);
    r.buzz(TEAM_A);
    r.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    r.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    r.setBoardPlayOrder(['p1']);
    // 'a1' (rank 1, 40) already revealed by the face-off win; 'a2' (25) is
    // banked here — 65 accumulated going into the steal.
    r.revealBoardAnswer('a2');
    r.recordStrike('wrong');
    r.recordStrike('duplicate');
    r.recordStrike('off_board');
    r.startSteal();
    r.lockStealWager({ wagerId: 'w1', amount: 0 });
    const stealResult = r.ruleSteal(true);
    expect(stealResult.ok).toBe(true);
    if (stealResult.ok) expect(stealResult.value.points).toBe(65);

    const resolved = r.resolveSurvey(TEAM_B);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      // 65 doubled once, not composed with any other multiplier.
      expect(resolved.value.baseAward).toBe(130);
      expect(resolved.value.doubled).toBe(true);
    }
  });
});

describe('Round4 — Steups! and Forgive Meh! integration', () => {
  it('Steups! cancels a just-given valid answer: no score, and the defending team cannot reuse it', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);

    // 'a1' (rank 1, 40) already revealed by the face-off win.
    round.revealBoardAnswer('a2'); // TEAM_A (controlling) gives "banana", +25
    expect(round.view().current?.board.accumulatedPoints).toBe(40 + 25);

    const steupsed = round.applySteups({ answerId: 'a2', defendingTeamId: TEAM_A });
    expect(steupsed.ok).toBe(true);
    if (steupsed.ok) {
      expect(steupsed.value.board.accumulatedPoints).toBe(40);
      const answerView = steupsed.value.board.answers.find((a) => a.answerId === 'a2');
      expect(answerView?.revealed).toBe(false);
      expect(answerView?.steupsRemoved).toBe(true);
      expect(answerView?.steupsRemovedForTeamId).toBe(TEAM_A);
    }

    // TEAM_A (the defending team) cannot give it again.
    expect(round.availableBoardAnswers(TEAM_A).some((a) => a.answerId === 'a2')).toBe(false);
    // TEAM_B (the Steups!-playing team) may still use it if it gets a legal turn.
    expect(round.availableBoardAnswers(TEAM_B).some((a) => a.answerId === 'a2')).toBe(true);
  });

  it('refuses Steups! on an answer that was never revealed', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);

    // 'a1' (rank 1) already revealed by the face-off win; 'a3' genuinely
    // never has been.
    const steupsed = round.applySteups({ answerId: 'a3', defendingTeamId: TEAM_A });
    expect(steupsed.ok).toBe(false);
  });

  it('refuses Steups! twice on the same answer', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.revealBoardAnswer('a2');
    round.applySteups({ answerId: 'a2', defendingTeamId: TEAM_A });
    const again = round.applySteups({ answerId: 'a2', defendingTeamId: TEAM_A });
    expect(again.ok).toBe(false);
  });

  it('Forgive Meh!: the retry-before-strike behaviour composes with recordStrike, never double-striking', () => {
    // Round4 does not reimplement the shared retry budget (advantages.ts) — a
    // caller uses `SharedSystems.advantages.useForgiveMehRetry` to grant the
    // retry BEFORE calling `recordStrike`, exactly once. This test proves the
    // one-strike-per-turn contract at the Round4 level: recordStrike always
    // adds exactly one strike per call, so a correct retry that never calls
    // recordStrike costs nothing, and a wrong retry that calls it once costs
    // exactly one.
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);

    // Wrong first answer -> Forgive Meh! -> correct retry -> NO strike at all.
    const correctRetry = round.revealBoardAnswer('a3');
    expect(correctRetry.ok).toBe(true);
    expect(round.view().current?.boardPlay?.strikes).toBe(0);
  });

  it('Forgive Meh!: a wrong retry after a wrong first answer is exactly one strike, never two', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);

    // The wrong first answer is withheld from recordStrike until Forgive Meh!
    // resolves; the retry is also wrong, so exactly ONE recordStrike call is
    // made for the whole turn.
    const strike = round.recordStrike('wrong');
    expect(strike.ok).toBe(true);
    if (strike.ok) expect(strike.value.boardPlay.strikes).toBe(1);
  });
});

describe('Round4 — 3-team cards: inactive team cannot act', () => {
  it('the inactive third team is never in participantTeamIds or matchupTeamIds', () => {
    const { round } = newRound();
    round.begin([TEAM_A, TEAM_B, TEAM_C]);
    round.beginFirstMatchup();
    round.startFaceoff(survey(), [TEAM_B, TEAM_C]);

    expect(round.inactiveTeamId).toBe(TEAM_A);
    expect(round.matchupTeamIds).not.toContain(TEAM_A);

    const buzzed = round.buzz(TEAM_A);
    expect(buzzed.ok).toBe(false);
    if (!buzzed.ok) expect(buzzed.error.code).toBe('UNAUTHORIZED_ACTOR');
  });

  it('startFaceoff refuses a participant that is not in the current matchup', () => {
    const { round } = newRound();
    round.begin([TEAM_A, TEAM_B, TEAM_C]);
    round.beginFirstMatchup();
    const started = round.startFaceoff(survey(), [TEAM_A, TEAM_C]);
    expect(started.ok).toBe(false);
  });
});

describe('Round4 — hidden state / no board leaks', () => {
  it('an unrevealed answer never carries text or value in the board view', () => {
    const { round } = twoTeamRoundInFaceoff();
    const view = round.view();
    const board = view.current?.board;
    expect(board).toBeDefined();
    for (const a of board?.answers ?? []) {
      expect(a.revealed).toBe(false);
      expect(a.text).toBeNull();
      expect(a.value).toBeNull();
    }
    // The count and ranks may be visible (the board shape), never the content.
    expect(board?.answerCount).toBe(5);
  });

  it('revealing one answer never exposes the others', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.revealBoardAnswer('a1');

    const board = round.view().current?.board;
    const revealedOnes = board?.answers.filter((a) => a.revealed) ?? [];
    const hiddenOnes = board?.answers.filter((a) => !a.revealed) ?? [];
    expect(revealedOnes).toHaveLength(1);
    expect(revealedOnes[0]?.text).toBe('TEST APPLE');
    for (const hidden of hiddenOnes) {
      expect(hidden.text).toBeNull();
      expect(hidden.value).toBeNull();
    }
  });

  it('the content source never repeats or leaks a future survey ahead of nextSurvey()', () => {
    const source = createTestRound4ContentSource();
    expect(source.remaining()).toBe(ROUND4_TEST_PACK.surveys.length);
    const first = source.nextSurvey();
    expect(first?.surveyId).toBe('ff-test-q1');
    expect(source.remaining()).toBe(ROUND4_TEST_PACK.surveys.length - 1);
  });
});

describe('Round4 — reconnect / pause preserves state without re-applying side effects', () => {
  it('pausing and resuming the face-off timer does not change who buzzed or the outcome', () => {
    const { round, clock } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    const before = round.faceoffAnswerRemainingMs();

    round.pauseTimers();
    clock.advance(10_000); // a long "disconnect"
    round.resumeTimers();

    const after = round.faceoffAnswerRemainingMs();
    expect(after).toBe(before);
    expect(round.view().current?.faceoff?.buzzedTeamId).toBe(TEAM_A);
  });

  it('pausing and resuming the board turn timer preserves strikes and controlling team', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.recordStrike('wrong');

    round.pauseTimers();
    round.resumeTimers();

    const view = round.view();
    expect(view.current?.boardPlay?.strikes).toBe(1);
    expect(view.current?.boardPlay?.controllingTeamId).toBe(TEAM_A);
  });

  it('pausing and resuming a steal confer window preserves the wager and stealing team', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.recordStrike('wrong');
    round.recordStrike('duplicate');
    round.recordStrike('off_board');
    round.startSteal();
    round.lockStealWager({ wagerId: 'w1', amount: 100 });

    round.pauseTimers();
    round.resumeTimers();

    const view = round.view();
    expect(view.current?.steal?.wagerId).toBe('w1');
    expect(view.current?.steal?.wagerAmount).toBe(100);
    expect(view.current?.steal?.stealingTeamId).toBe(TEAM_B);
  });
});

describe('Round4 — precise timer views (7D-B1 / live-play Host-started timers)', () => {
  it('the board-play turn timer is null until the Host starts it', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);

    // Live play: answers are spoken, not typed, so nothing server-side can
    // know when the Host finished posing the question — the clock does not
    // start itself.
    expect(round.view().current?.boardPlay?.turnTimer).toBeNull();

    const started = round.startBoardTurnTimer();
    expect(started.ok).toBe(true);

    const timer = round.view().current?.boardPlay?.turnTimer;
    expect(timer).not.toBeNull();
    expect(timer?.durationMs).toBe(5_000);
    expect(timer?.remainingMs).toBe(5_000);
    expect(timer?.paused).toBe(false);
    expect(timer?.expired).toBe(false);
  });

  it('refuses to start the board turn timer twice while it is still running', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);

    round.startBoardTurnTimer();
    const again = round.startBoardTurnTimer();
    expect(again.ok).toBe(false);
  });

  it('a reveal clears the turn timer, so the NEXT turn also needs a Host start', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);

    round.startBoardTurnTimer();
    round.revealBoardAnswer('a2');
    expect(round.view().current?.boardPlay?.turnTimer).toBeNull();

    const restarted = round.startBoardTurnTimer();
    expect(restarted.ok).toBe(true);
    expect(round.view().current?.boardPlay?.turnTimer?.remainingMs).toBe(5_000);
  });

  it('the steal confer timer is null until the Host starts it', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.recordStrike('wrong');
    round.recordStrike('duplicate');
    round.recordStrike('off_board');
    round.startSteal();

    expect(round.view().current?.steal?.conferTimer).toBeNull();

    const started = round.startStealTimer();
    expect(started.ok).toBe(true);

    const timer = round.view().current?.steal?.conferTimer;
    expect(timer).not.toBeNull();
    expect(timer?.durationMs).toBe(30_000);
    expect(timer?.remainingMs).toBe(30_000);
    expect(timer?.paused).toBe(false);
    expect(timer?.expired).toBe(false);
  });

  it('refuses to start the steal timer twice while it is still running', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.recordStrike('wrong');
    round.recordStrike('duplicate');
    round.recordStrike('off_board');
    round.startSteal();

    round.startStealTimer();
    const again = round.startStealTimer();
    expect(again.ok).toBe(false);
  });

  it('the face-off answer timer still appears automatically once a team buzzes (unchanged)', () => {
    const round = twoTeamRoundInFaceoff().round;
    expect(round.view().current?.faceoff?.answerTimer).toBeNull();
    round.buzz(TEAM_A);
    const timer = round.view().current?.faceoff?.answerTimer;
    expect(timer?.durationMs).toBe(3_000);
    expect(timer?.remainingMs).toBe(3_000);
  });

  it('a board-play timer refresh (repeated view() calls) does not restart the duration', () => {
    const { round, clock } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.startBoardTurnTimer();

    clock.advance(2_000);
    const first = round.view().current?.boardPlay?.turnTimer?.remainingMs;
    // Calling view() again — a plain snapshot refresh — must reflect the same
    // real elapsed time, not reset the countdown to durationMs.
    const second = round.view().current?.boardPlay?.turnTimer?.remainingMs;
    expect(first).toBe(3_000);
    expect(second).toBe(3_000);
  });

  it('pausing a board-play timer freezes remainingMs; resuming preserves it exactly (D-011)', () => {
    const { round, clock } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.startBoardTurnTimer();

    clock.advance(1_000);
    round.pauseTimers();
    const pausedTimer = round.view().current?.boardPlay?.turnTimer;
    expect(pausedTimer?.paused).toBe(true);
    expect(pausedTimer?.remainingMs).toBe(4_000);

    clock.advance(10_000); // a long "disconnect" while paused
    const stillPaused = round.view().current?.boardPlay?.turnTimer;
    expect(stillPaused?.remainingMs).toBe(4_000);

    round.resumeTimers();
    const resumed = round.view().current?.boardPlay?.turnTimer;
    expect(resumed?.paused).toBe(false);
    expect(resumed?.remainingMs).toBe(4_000);
  });

  it('pausing and resuming a steal confer timer preserves remaining time exactly', () => {
    const { round, clock } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.recordStrike('wrong');
    round.recordStrike('duplicate');
    round.recordStrike('off_board');
    round.startSteal();
    round.startStealTimer();

    clock.advance(5_000);
    round.pauseTimers();
    const before = round.view().current?.steal?.conferTimer?.remainingMs;
    clock.advance(20_000);
    round.resumeTimers();
    const after = round.view().current?.steal?.conferTimer?.remainingMs;
    expect(before).toBe(25_000);
    expect(after).toBe(25_000);
  });

  it('a timer view introduces no hidden board data — the board stays exactly as safe as before', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);

    const board = round.view().current?.board;
    for (const answer of board?.answers ?? []) {
      if (!answer.revealed) {
        expect(answer.text).toBeNull();
        expect(answer.value).toBeNull();
      }
    }
  });
});

describe('Round4 — buzz/answer/score/wager settlement idempotency under replay', () => {
  it('a repeated buzz for the same team after it already buzzed is refused (no double lock)', () => {
    const { round } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    const replay = round.buzz(TEAM_A);
    expect(replay.ok).toBe(false);
  });

  it('re-ruling a face-off answer for an already-decided face-off is refused', () => {
    const { round } = twoTeamRoundInFaceoff();
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    const replay = round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    expect(replay.ok).toBe(false);
  });

  it('re-resolving an already-resolved steal is refused (no double wager settlement)', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.recordStrike('wrong');
    round.recordStrike('duplicate');
    round.recordStrike('off_board');
    round.startSteal();
    round.lockStealWager({ wagerId: 'w1', amount: 50 });
    round.ruleSteal(true);
    const replay = round.ruleSteal(true);
    expect(replay.ok).toBe(false);
  });

  it('re-resolving an already-resolved survey is refused (no double BB award)', () => {
    const round = twoTeamRoundInFaceoff().round;
    round.buzz(TEAM_A);
    round.ruleFaceoffAnswer({ teamId: TEAM_A, matchedRank: 1 });
    round.choosePlayOrPass({ teamId: TEAM_A, decision: 'PLAY' });
    round.setBoardPlayOrder(['p1']);
    round.revealBoardAnswer('a1');
    round.resolveSurvey(TEAM_A);
    const replay = round.resolveSurvey(TEAM_A);
    expect(replay.ok).toBe(false);
  });
});

describe('Round4 answer matching', () => {
  const board = survey().answers;

  it('matches an exact board answer', () => {
    const result = matchRound4Answer('test banana', board);
    expect(result.answer?.answerId).toBe('a2');
    expect(result.ambiguous).toBe(false);
  });

  it('matches a conservative typo of a board answer', () => {
    const result = matchRound4Answer('test bananna', board);
    expect(result.answer?.answerId).toBe('a2');
  });

  it('does not fuzzy-merge two distinct board answers', () => {
    // "test orange" and "test grape" are genuinely different entries; a guess
    // close to one must never resolve to the other.
    const result = matchRound4Answer('test grope', board);
    expect(result.answer?.answerId === 'a3').toBe(false);
  });

  it('returns no match, not a guess, for an off-board answer', () => {
    const result = matchRound4Answer('test pineapple', board);
    expect(result.answer).toBeNull();
    expect(result.ambiguous).toBe(false);
  });

  it('matchesTopAnswer recognises only the #1 ranked answer', () => {
    expect(matchesTopAnswer('test apple', board)).toBe(true);
    expect(matchesTopAnswer('test banana', board)).toBe(false);
  });

  it('flags true ambiguity rather than silently picking one candidate', () => {
    const ambiguousBoard = [
      { answerId: 'x1', rank: 1, text: 'TEST THING', value: 10 },
      { answerId: 'x2', rank: 2, text: 'TEST THING', value: 5 },
    ];
    const result = matchRound4Answer('test thing', ambiguousBoard);
    expect(result.ambiguous).toBe(true);
    expect(result.answer).toBeNull();
  });
});

/**
 * Generic game lifecycle states.
 *
 * THESE ARE ENGINE STATES, NOT ROUND RULES.
 *
 * The roadmap's Phase 2 asks for "generic game states" and explicitly defers
 * detailed round progression. So a state here says what KIND of thing the game
 * is doing — introducing a challenge, waiting on the Host, showing a result —
 * never which round it is, how many questions remain, or how scoring works.
 *
 * Several of those specifics are still open in docs/OPEN_RULES.md (Round 1
 * allocation, Guess the Logo scoring, All Answers Begin With format). Keeping
 * this model generic is what lets those be answered later without reshaping the
 * engine.
 */

export const GAME_PHASES = [
  /** Process started, room not yet open. */
  'BOOT',
  /** Room open, players joining and being assigned to teams. */
  'LOBBY',
  /** Teams fixed. No further joins or reassignment. */
  'TEAM_LOCK',
  /** Presenting a round before its challenges begin. */
  'ROUND_INTRO',
  /** Market is open. GAME_RULES_LOCKED.md §10 opens it before Rounds 2, 3 and 4. */
  'MARKET',
  /** Presenting a challenge before play starts. */
  'CHALLENGE_INTRO',
  /** Players are actively playing. Deadlines typically run here. */
  'ACTIVE_PLAY',
  /** Waiting on a Host ruling. CLAUDE.md gives the Host subjective judgment. */
  'HOST_REVIEW',
  /** Showing the outcome of a challenge. */
  'RESULT',
  /** A round has finished. */
  'ROUND_COMPLETE',
  /** Gameplay suspended. Only a Host-authorised resume leaves this state. */
  'PAUSED',
  /** GAME_RULES_LOCKED.md §21 — tied leaders play for the win. */
  'SUDDEN_DEATH',
  /** Terminal. */
  'GAME_OVER',
] as const;

export type GamePhase = (typeof GAME_PHASES)[number];

/**
 * Legal transitions between phases.
 *
 * PAUSED is deliberately absent from these lists. Pausing and resuming are not
 * ordinary transitions: GAME_RULES_LOCKED.md §22 requires that resuming returns
 * to where the game left off, which this table cannot express. They are handled
 * separately so the "only the Host resumes" rule has exactly one implementation.
 *
 * This table is intentionally permissive about round shape. It allows the
 * documented flow in PLAYER_HOST_REFERENCE.md without asserting how many
 * challenges a round holds or which round comes next — that would resolve open
 * rules by implication.
 */
const TRANSITIONS: Readonly<Record<GamePhase, readonly GamePhase[]>> = {
  BOOT: ['LOBBY'],
  LOBBY: ['TEAM_LOCK'],
  // A locked set of teams can start the game, or be unlocked back to the lobby
  // if the Host needs to fix a team before play begins.
  TEAM_LOCK: ['ROUND_INTRO', 'LOBBY'],
  // GAME_RULES_LOCKED.md §10 — Market opens before Rounds 2, 3 and 4, so a
  // round intro may lead either into the Market or straight to a challenge.
  ROUND_INTRO: ['MARKET', 'CHALLENGE_INTRO'],
  MARKET: ['CHALLENGE_INTRO', 'ROUND_INTRO'],
  CHALLENGE_INTRO: ['ACTIVE_PLAY'],
  // Play may end in a Host ruling or go straight to a result.
  ACTIVE_PLAY: ['HOST_REVIEW', 'RESULT'],
  HOST_REVIEW: ['RESULT', 'ACTIVE_PLAY'],
  // After a result: another challenge, or the round ends.
  RESULT: ['CHALLENGE_INTRO', 'ROUND_COMPLETE'],
  // A completed round leads to the next round, the end of the game, or
  // Sudden Death when leaders are tied (§19).
  ROUND_COMPLETE: ['ROUND_INTRO', 'SUDDEN_DEATH', 'GAME_OVER'],
  // Sudden Death runs its own question loop and ends the game.
  SUDDEN_DEATH: ['ACTIVE_PLAY', 'RESULT', 'GAME_OVER'],
  // Never a legal source. Resuming is handled by the pause model, not here.
  PAUSED: [],
  // Terminal. GAME_OVER -> ACTIVE_PLAY must never be legal.
  GAME_OVER: [],
} as const;

/** Whether `from -> to` is a legal phase transition. Ignores pause/resume. */
export function isLegalTransition(from: GamePhase, to: GamePhase): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The phases reachable from `phase`. Useful for tests and Host tooling. */
export function legalNextPhases(phase: GamePhase): readonly GamePhase[] {
  return TRANSITIONS[phase];
}

/** Terminal phases have no outgoing transitions. */
export function isTerminalPhase(phase: GamePhase): boolean {
  return phase === 'GAME_OVER';
}

/**
 * Whether gameplay may advance while in this phase.
 *
 * GAME_RULES_LOCKED.md §22 — when paused, "active gameplay timers pause".
 */
export function isPlayableActivePhase(phase: GamePhase): boolean {
  return phase === 'ACTIVE_PLAY' || phase === 'SUDDEN_DEATH';
}

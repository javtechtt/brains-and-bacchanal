import {
  isHostActor,
  isLegalTransition,
  isTerminalPhase,
  rejection,
  type Actor,
  type GamePhase,
  type PauseReason,
  type Rejection,
} from '@bb/protocol';

/**
 * Centralised phase transitions.
 *
 * The roadmap asks for an explicit transition system rather than assignments
 * such as `state.phase = 'ACTIVE_PLAY'` scattered through application code.
 * Every phase change in the engine goes through `applyTransition`, so the rules
 * live in one testable place.
 *
 * Pure: takes the current phase and an action, returns the next phase or a
 * rejection. No mutation, no I/O, no clock.
 */

/** The phase plus its pause bookkeeping. */
export interface PhaseState {
  readonly phase: GamePhase;
  /** The phase to restore on resume. Non-null exactly when phase is PAUSED. */
  readonly resumePhase: GamePhase | null;
  readonly pauseReason: PauseReason | null;
}

export type TransitionAction =
  | { readonly kind: 'advance'; readonly to: GamePhase }
  | { readonly kind: 'pause'; readonly reason: PauseReason }
  | { readonly kind: 'resume' };

export type TransitionOutcome =
  | { readonly ok: true; readonly state: PhaseState }
  | { readonly ok: false; readonly error: Rejection };

export function initialPhaseState(): PhaseState {
  return { phase: 'BOOT', resumePhase: null, pauseReason: null };
}

/**
 * Apply an action to the current phase state.
 *
 * `actor` matters only for resume, which is Host-only. Everything else is
 * authorised by the caller before reaching here.
 */
export function applyTransition(
  state: PhaseState,
  action: TransitionAction,
  actor: Actor,
): TransitionOutcome {
  switch (action.kind) {
    case 'advance':
      return advance(state, action.to);
    case 'pause':
      return pause(state, action.reason);
    case 'resume':
      return resume(state, actor);
  }
}

function advance(state: PhaseState, to: GamePhase): TransitionOutcome {
  // GAME_RULES_LOCKED.md §20 — while paused, gameplay does not continue. An
  // ordinary advance must not slip past a pause; only a Host resume leaves it.
  if (state.phase === 'PAUSED') {
    return fail(
      rejection('WRONG_STATE', 'The game is paused. Only the Host can resume it.', {
        phase: state.phase,
        attempted: to,
      }),
    );
  }

  if (isTerminalPhase(state.phase)) {
    return fail(
      rejection('WRONG_STATE', 'The game is over.', { phase: state.phase, attempted: to }),
    );
  }

  if (!isLegalTransition(state.phase, to)) {
    return fail(
      rejection('ILLEGAL_ACTION', `Cannot move from ${state.phase} to ${to}.`, {
        from: state.phase,
        to,
      }),
    );
  }

  return succeed({ phase: to, resumePhase: null, pauseReason: null });
}

function pause(state: PhaseState, reason: PauseReason): TransitionOutcome {
  if (state.phase === 'PAUSED') {
    return fail(rejection('WRONG_STATE', 'The game is already paused.', { phase: state.phase }));
  }

  // Pausing a finished game is meaningless and would create a state that
  // resume could not sensibly restore.
  if (isTerminalPhase(state.phase)) {
    return fail(rejection('WRONG_STATE', 'The game is over.', { phase: state.phase }));
  }

  // Capture the phase now rather than recomputing it on resume, so resume
  // cannot drift to a different phase than the one play was suspended from.
  return succeed({ phase: 'PAUSED', resumePhase: state.phase, pauseReason: reason });
}

/**
 * Resume from PAUSED.
 *
 * GAME_RULES_LOCKED.md §20 and DECISION_LOG.md D-011:
 *   - reconnecting does not automatically resume gameplay,
 *   - only the Host can resume,
 *   - the Host may resume with or without the player reconnecting.
 *
 * Authority is checked HERE rather than at a call site, so there is no path by
 * which a reconnect — or any non-Host actor — can leave PAUSED.
 */
function resume(state: PhaseState, actor: Actor): TransitionOutcome {
  if (state.phase !== 'PAUSED') {
    return fail(rejection('WRONG_STATE', 'The game is not paused.', { phase: state.phase }));
  }

  if (!isHostActor(actor)) {
    return fail(
      rejection('UNAUTHORIZED_ACTOR', 'Only the Host can resume the game.', { actor: actor.kind }),
    );
  }

  // Non-null whenever phase is PAUSED, by construction in pause(). Treated
  // defensively: a corrupt state should not strand the game.
  const target = state.resumePhase;
  if (target === null) {
    return fail(rejection('INTERNAL_ERROR', 'Paused state has no phase to resume to.'));
  }

  return succeed({ phase: target, resumePhase: null, pauseReason: null });
}

const succeed = (state: PhaseState): TransitionOutcome => ({ ok: true, state });
const fail = (error: Rejection): TransitionOutcome => ({ ok: false, error });

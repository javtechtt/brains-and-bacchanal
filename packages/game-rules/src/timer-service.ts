import {
  asServerTimestamp,
  type ChallengeId,
  type TimerView,
} from '@bb/protocol';
import type { Clock } from './clock.js';
import {
  hasExpired,
  pauseDeadline,
  remainingMs,
  resumeDeadline,
  startDeadline,
  type Deadline,
} from './deadline.js';

/**
 * The server's authoritative timer.
 *
 * ARCHITECTURE.md §6 — the server owns "open times, deadlines, paused time,
 * resume deadlines, buzzer acceptance", and never trusts a client's claimed
 * time. A phone may count down locally so its display moves smoothly; it can
 * never decide that time ran out.
 *
 * Built on the Phase 2 `Deadline` primitives rather than beside them, so paused
 * time is excluded from elapsed time by the same code the deadline tests
 * already cover. GAME_RULES_LOCKED.md §20: a player who disconnects with four
 * seconds left still has four seconds when the Host resumes.
 *
 * NO DURATION IS DECIDED HERE. Think Fast's timer (OPEN_RULES.md §2), Sing a
 * Song's timings (§6) and the Round 4 / Sudden Death timers (§11) are all open.
 * Callers supply a duration; this service only runs it.
 *
 * ONE TIMER AT A TIME. The engine runs one challenge at a time, so a second
 * start replaces the first. Concurrent timers would need a rule for what
 * happens when two expire at once, and no such rule exists.
 */

export interface StartTimerOptions {
  readonly durationMs: number;
  readonly challengeId?: ChallengeId | null;
}

export class TimerService {
  readonly #clock: Clock;
  readonly #mintId: () => string;

  #deadline: Deadline | null = null;
  #timerId: string | null = null;
  #challengeId: ChallengeId | null = null;
  /**
   * Whether the expiry of the CURRENT timer has already been reported.
   *
   * Expiry is detected by polling (see `expireIfDue`) rather than by a
   * scheduled callback, because @bb/game-rules must stay free of timers and
   * wall-clock reads — its tests run on a FakeClock where no real interval
   * would ever fire. This flag is what makes the poll idempotent: a deadline
   * stays expired forever once it passes, so without it every subsequent poll
   * would report the same expiry again.
   */
  #expiryReported = false;

  constructor(clock: Clock, mintId: () => string) {
    this.#clock = clock;
    this.#mintId = mintId;
  }

  get running(): boolean {
    return this.#deadline !== null;
  }

  get timerId(): string | null {
    return this.#timerId;
  }

  /** Start a timer, replacing any current one. */
  start(options: StartTimerOptions): TimerView {
    if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) {
      throw new RangeError('Timer duration must be a finite, positive number');
    }

    this.#deadline = startDeadline(this.#clock, options.durationMs);
    this.#timerId = this.#mintId();
    this.#challengeId = options.challengeId ?? null;
    this.#expiryReported = false;

    return this.view() as TimerView;
  }

  /** Stop and forget the current timer. Returns what was cancelled, if any. */
  cancel(): TimerView | null {
    const view = this.view();
    this.#deadline = null;
    this.#timerId = null;
    this.#challengeId = null;
    this.#expiryReported = false;
    return view;
  }

  /**
   * Freeze the timer.
   *
   * Idempotent, because the disconnect path may pause a game that is already
   * paused and must not bank the same stretch of time twice.
   */
  pause(): void {
    if (this.#deadline === null) return;
    this.#deadline = pauseDeadline(this.#clock, this.#deadline);
  }

  /** Resume a frozen timer, banking the time spent paused. */
  resume(): void {
    if (this.#deadline === null) return;
    this.#deadline = resumeDeadline(this.#clock, this.#deadline);
  }

  get paused(): boolean {
    return this.#deadline?.pausedAt !== null && this.#deadline !== null;
  }

  /** Milliseconds left, floored at 0. Zero when nothing is running. */
  remainingMs(): number {
    if (this.#deadline === null) return 0;
    return remainingMs(this.#clock, this.#deadline);
  }

  /**
   * Report expiry exactly once, if it is due.
   *
   * Returns the expired timer the first time the deadline has run out, and null
   * on every later call. The engine polls this whenever it touches the session,
   * so expiry is observed without this package scheduling anything.
   *
   * A PAUSED TIMER NEVER EXPIRES. `remainingMs` measures to the moment of
   * pausing, so a game paused with time left keeps that time however long the
   * pause lasts — which is the whole point of D-011. A timer that had already
   * run out before the pause is still expired, and is reported on the next poll.
   */
  expireIfDue(): TimerView | null {
    if (this.#deadline === null || this.#expiryReported) return null;
    if (!hasExpired(this.#clock, this.#deadline)) return null;

    this.#expiryReported = true;
    return this.view() as TimerView;
  }

  /** Current timer as clients see it, or null when nothing is running. */
  view(): TimerView | null {
    const deadline = this.#deadline;
    const timerId = this.#timerId;
    if (deadline === null || timerId === null) return null;

    return {
      timerId,
      durationMs: deadline.durationMs,
      remainingMs: remainingMs(this.#clock, deadline),
      paused: deadline.pausedAt !== null,
      expired: hasExpired(this.#clock, deadline),
      startedAt: asServerTimestamp(deadline.startedAt),
      challengeId: this.#challengeId,
    };
  }
}

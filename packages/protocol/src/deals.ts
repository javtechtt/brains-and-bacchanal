import type { ServerTimestamp, TeamId } from './ids.js';

/**
 * Host Deals and the generic wager — the wire vocabulary. Phase 6.
 *
 * GAME_RULES_LOCKED.md §9 (Host Deals) and §17 (the Family Feud steal wager).
 * DECISION_LOG.md D-009 — maximum one Host Deal per round.
 */

// ---------------------------------------------------------------------------
// Host Deals
// ---------------------------------------------------------------------------

/**
 * The four Host Deal templates. Phase 6 spec §37.
 *
 * GAME_RULES_LOCKED.md §9 — "Deal mathematics come from predefined templates
 * and are not improvised." That is the whole reason this is an enum and not a
 * set of numbers on an intent: the Host names a template, the server supplies
 * the maths. A Host client cannot send "give this team 9,000 BB", because there
 * is no field on the wire for an amount.
 *
 * Phase 6 spec §38 — "Do not invent additional Host Deal templates." These four
 * are the ones the spec lists, and no fifth exists.
 */
export const HOST_DEAL_TEMPLATES = [
  /** Keep 500 BB, OR give up 500 BB and open a Maco Mail. */
  'KEEP_OR_RISK',
  /** Keep 500 BB, OR risk it: next answer correct = 1,000, wrong = 0. */
  'DOUBLE_OR_NOTHING_ISH',
  /** Pay 300 BB for a Maco Mail draw. */
  'MYSTERY_DEAL',
  /** Take 500 BB now, OR give an opposing team 250 BB and receive a Maco Mail. */
  'OPPONENTS_DEAL',
] as const;

export type HostDealTemplate = (typeof HOST_DEAL_TEMPLATES)[number];

/**
 * Which side of a deal a team took.
 *
 * `accept` and `decline` are deliberately neutral names. For KEEP_OR_RISK the
 * safe side is "keep"; for MYSTERY_DEAL it is "don't buy". Naming the options
 * after their gameplay meaning would need a different pair per template.
 */
export const HOST_DEAL_CHOICES = ['accept', 'decline'] as const;

export type HostDealChoice = (typeof HOST_DEAL_CHOICES)[number];

/**
 * What each template actually does, as data rather than as code branches.
 *
 * Every amount a Host Deal can move is in this table. Phase 6 spec §37 — "Do
 * not allow arbitrary Host-authored math from the client. The Host selects from
 * server-known templates."
 */
export interface HostDealTerms {
  readonly template: HostDealTemplate;
  readonly label: string;
  /** What the team gets for declining (the safe side). 0 when nothing. */
  readonly declineBb: number;
  /** What the team pays to accept. 0 when the deal costs nothing. */
  readonly acceptCostBb: number;
  /** Whether accepting yields a Maco Mail draw. */
  readonly acceptGrantsMacoDraw: boolean;
  /** BB paid to an opposing team on accept. Requires a target. */
  readonly acceptPaysOpponentBb: number;
  /**
   * Whether accepting creates a pending wager on the team's next answer.
   *
   * Only DOUBLE_OR_NOTHING_ISH does. The outcome is not settled when the deal is
   * taken — it settles when the next answer is judged, which is a round's
   * business, so the deal records a pending stake and stops.
   */
  readonly acceptCreatesPendingBet: boolean;
  /** Payout if that pending bet is later won. */
  readonly pendingBetWinBb: number;
  /** Payout if it is lost. Zero — "wrong = 0". */
  readonly pendingBetLoseBb: number;
  /** Whether the Host must name an opposing team when offering this deal. */
  readonly requiresOpponent: boolean;
}

/**
 * THE LOCKED DEAL TERMS. Phase 6 spec §37, transcribed exactly.
 *
 * KEEP OR RISK            keep 500 | give up 500 and open Maco
 * DOUBLE OR NOTHING-ISH   keep 500 | risk: correct next = 1000, wrong = 0
 * MYSTERY DEAL            pay 300 for Maco
 * OPPONENT'S DEAL         take 500 now | give opponent 250 and receive Maco
 *
 * Read KEEP_OR_RISK carefully: declining pays 500, and accepting means giving
 * that 500 up — so `acceptCostBb` is 0, not 500. The team never receives the
 * 500 in the first place; it is the price of the draw, not a deduction from
 * their balance. Modelling it as a deduction would wrongly take 500 from a team
 * that happens to hold fewer than 500 BB.
 */
export const HOST_DEAL_TERMS: Readonly<Record<HostDealTemplate, HostDealTerms>> = {
  KEEP_OR_RISK: {
    template: 'KEEP_OR_RISK',
    label: 'Keep or Risk',
    declineBb: 500,
    acceptCostBb: 0,
    acceptGrantsMacoDraw: true,
    acceptPaysOpponentBb: 0,
    acceptCreatesPendingBet: false,
    pendingBetWinBb: 0,
    pendingBetLoseBb: 0,
    requiresOpponent: false,
  },
  DOUBLE_OR_NOTHING_ISH: {
    template: 'DOUBLE_OR_NOTHING_ISH',
    label: 'Double or Nothing-ish',
    declineBb: 500,
    acceptCostBb: 0,
    acceptGrantsMacoDraw: false,
    acceptPaysOpponentBb: 0,
    acceptCreatesPendingBet: true,
    pendingBetWinBb: 1000,
    pendingBetLoseBb: 0,
    requiresOpponent: false,
  },
  MYSTERY_DEAL: {
    template: 'MYSTERY_DEAL',
    label: 'Mystery Deal',
    declineBb: 0,
    // The one template where the team actually pays from its balance, so it is
    // the one where affordability has to be checked. Phase 6 spec §38.
    acceptCostBb: 300,
    acceptGrantsMacoDraw: true,
    acceptPaysOpponentBb: 0,
    acceptCreatesPendingBet: false,
    pendingBetWinBb: 0,
    pendingBetLoseBb: 0,
    requiresOpponent: false,
  },
  OPPONENTS_DEAL: {
    template: 'OPPONENTS_DEAL',
    label: "Opponent's Deal",
    declineBb: 500,
    acceptCostBb: 0,
    acceptGrantsMacoDraw: true,
    acceptPaysOpponentBb: 250,
    acceptCreatesPendingBet: false,
    pendingBetWinBb: 0,
    pendingBetLoseBb: 0,
    requiresOpponent: true,
  },
} as const;

/** An offered Host Deal, awaiting the team's choice. */
export interface HostDealView {
  readonly dealId: string;
  readonly template: HostDealTemplate;
  readonly teamId: TeamId;
  /** The opposing team, for OPPONENT'S DEAL. */
  readonly opponentTeamId: TeamId | null;
  /** The round it was offered in. D-009 allows one per round. */
  readonly roundIndex: number;
  readonly offeredAt: ServerTimestamp;
  readonly choice: HostDealChoice | null;
  readonly resolvedAt: ServerTimestamp | null;
  /** BB actually applied per team, after the floor. */
  readonly bbApplied: Readonly<Record<string, number>>;
  /** The terms, sent with the offer so a client never computes them. */
  readonly terms: HostDealTerms;
}

// ---------------------------------------------------------------------------
// Generic wagers
// ---------------------------------------------------------------------------

/**
 * The maximum fraction of current BB a team may wager.
 *
 * GAME_RULES_LOCKED.md §17 — the stealing team "may wager up to 50% of current
 * BB before answering". Phase 6 builds the reusable primitive; Family Feud is
 * Phase 7 and this is not connected to a board.
 */
export const MAX_WAGER_FRACTION = 0.5;

/**
 * The largest legal wager for a balance.
 *
 * Floored to a whole number, because BB is counted in whole units everywhere
 * else and "wager 512.5" is not a thing a Host can announce. Flooring rather
 * than rounding keeps it at or under the locked 50% ceiling.
 */
export function maxWagerFor(currentBb: number): number {
  if (!Number.isFinite(currentBb) || currentBb <= 0) return 0;
  return Math.floor(currentBb * MAX_WAGER_FRACTION);
}

export const WAGER_STATUSES = [
  /** Proposed and locked. Cannot be changed. */
  'locked',
  /** Won — the wager is paid. */
  'won',
  /** Lost — the wager is deducted. */
  'lost',
  /** Cancelled without resolving. No BB moved. */
  'cancelled',
] as const;

export type WagerStatus = (typeof WAGER_STATUSES)[number];

/**
 * A locked wager.
 *
 * WHY THE BALANCE IS RECORDED: a wager is validated against the balance at lock
 * time. If the team's BB changes before resolution — a Maco Mail penalty, say —
 * the wager stands at the amount that was legal when it was made. Re-checking
 * at resolution would let an unrelated event silently void a locked bet.
 *
 * GAME_RULES_LOCKED.md §17 says the wager happens "before answering", so the
 * lock is the commitment point.
 */
export interface WagerView {
  readonly wagerId: string;
  readonly teamId: TeamId;
  readonly amount: number;
  /** The team's balance when the wager was locked. */
  readonly balanceAtLock: number;
  /** The maximum that was legal at lock time. For the audit trail. */
  readonly maxAllowed: number;
  readonly status: WagerStatus;
  readonly lockedAt: ServerTimestamp;
  readonly resolvedAt: ServerTimestamp | null;
  /** BB actually applied on resolution, after the floor. */
  readonly bbApplied: number;
  /** Opaque tag naming what the wager is attached to. Never content. */
  readonly contextRef: string | null;
}

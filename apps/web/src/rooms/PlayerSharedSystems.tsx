'use client';

import {
  CARD_DISPLAY_LABELS,
  MARKET_ITEM_LABELS,
  ADVANTAGE_LABELS,
  MACO_OUTCOME_LABELS,
  SHARED_INTENTS,
  type PlayerSharedSystemsView,
  type MarketItem,
} from '@bb/protocol';
import { useEffect, useState } from 'react';
import * as ui from './ui';

/**
 * PHASE 6 TEST UI — the shared systems on a phone.
 *
 * ================== TEST SCAFFOLDING, NOT PRESENTATION ==================
 * Phase 6 spec §45 — "Create minimal functional player UI for testing... Do not
 * visually polish." Phase 8 builds the real thing. This exists so the systems
 * can be exercised with two real phones, which is the only way some of these
 * bugs show up.
 * ========================================================================
 *
 * WHAT IT CAN AND CANNOT SHOW. Everything here comes from
 * `PlayerSharedSystemsView`, which carries the team's OWN hand, its own
 * purchases, its own advantages and its own draws. Opponents appear as counts.
 * There is no code path here that could render an opponent's card, because the
 * data never arrives — spec §42's protection is structural, not a rule this
 * component has to remember.
 *
 * AND IT DECIDES NOTHING. `playable` is computed by the server; this renders a
 * disabled button when the server says a card is not playable, and the server
 * refuses the intent anyway if the button is bypassed (§7).
 */
export function PlayerSharedSystems({
  shared,
  paused,
  submit,
}: {
  shared: PlayerSharedSystemsView;
  paused: boolean;
  submit: (type: string, payload?: unknown) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const act = async (type: string, payload: unknown) => {
    setBusy(true);
    setNote(null);
    try {
      const result = await submit(type, payload);
      if (!result.ok) setNote(result.message ?? 'Refused by the server.');
    } finally {
      setBusy(false);
    }
  };

  const clashOpen = shared.clash !== null && !shared.clash.resolved;

  return (
    <div style={{ marginTop: ui.SPACING.lg }}>
      <DevBanner />

      {note !== null && (
        <p style={{ ...ui.errorText, textAlign: 'center' }} role="status">
          {note}
        </p>
      )}

      {/* --- Clash counter window --------------------------------------------
          Reported as too easy to miss with a plain, same-as-everything-else
          panel: a team could lose the whole window without noticing a Clash
          had opened. This uses the loudest treatment on the page — a warning-
          coloured banner, its own border, and a live countdown built the same
          way the challenge timer is (server-authoritative remainingMs, client
          interpolates for a smooth display, never decides expiry) — so a
          Clash is unmistakable next to the plain "YOUR BACCHANAL CARDS" list
          it temporarily replaces. */}
      {clashOpen && shared.clash !== null && (
        <ClashBanner
          clash={shared.clash}
          yourResponse={shared.yourClashResponse}
          hand={shared.yourHand}
          opponentTeamIds={shared.opponentHands.map((o) => o.teamId)}
          busy={busy}
          onPlay={(cardInstanceId, targetTeamId) =>
            act(SHARED_INTENTS.RESPOND_TO_CLASH, { cardInstanceId, targetTeamId })
          }
        />
      )}

      {/* --- Your Bacchanal hand -------------------------------------------- */}
      {shared.yourHand.length > 0 && !clashOpen && (
        <Section title="YOUR BACCHANAL CARDS">
          <CardList
            cards={shared.yourHand}
            busy={busy || paused}
            onPlay={(cardInstanceId, targetTeamId) =>
              act(SHARED_INTENTS.PLAY_BACCHANAL_CARD, { cardInstanceId, targetTeamId })
            }
            opponentTeamIds={shared.opponentHands.map((o) => o.teamId)}
          />
          {/* Opponents: a COUNT. Never a card. */}
          {shared.opponentHands.map((opponent) => (
            <p key={opponent.teamId} style={{ ...ui.muted, fontSize: ui.FONT_SIZE.xs }}>
              {opponent.teamId}: {opponent.cardCount} card
              {opponent.cardCount === 1 ? '' : 's'}
              {opponent.playedThisChallenge ? ' · played this challenge' : ''}
            </p>
          ))}
        </Section>
      )}

      {/* --- Market --------------------------------------------------------- */}
      {shared.market.market?.open === true && (
        <Section title={`MARKET · ROUND ${shared.market.market.round}`}>
          {shared.market.pendingSurcharge > 0 && (
            <p style={{ ...ui.errorText, marginTop: 0 }}>
              Price Gone Up! +{shared.market.pendingSurcharge} BB on your next purchase.
            </p>
          )}
          {shared.market.availableItems.map((item) => (
            <button
              key={item}
              type="button"
              disabled={busy || paused}
              style={{ ...ui.secondaryButton, width: '100%', marginBottom: ui.SPACING.xs }}
              onClick={() => act(SHARED_INTENTS.PURCHASE_MARKET_ITEM, { item })}
            >
              {MARKET_ITEM_LABELS[item]} —{' '}
              {priceOf(shared, item) + shared.market.pendingSurcharge} BB
            </button>
          ))}
          {shared.market.availableItems.length === 0 && (
            <p style={ui.muted}>Nothing left to buy this Market.</p>
          )}
        </Section>
      )}

      {/* Own purchases, always visible to their buyer.
          A purchase can be taken back out of the cart while the Market is
          still open — GAME_RULES_LOCKED.md §10's "purchases are final"
          describes checkout (the Market closing), not every tap before it. */}
      {shared.market.yourPurchases.length > 0 && (
        <Section title="YOUR PURCHASES">
          {shared.market.yourPurchases.map((purchase) => {
            const canWithdraw =
              shared.market.market?.open === true && !purchase.cancelled && !purchase.used;
            return (
              <div key={purchase.purchaseId} style={{ marginBottom: ui.SPACING.xs }}>
                <Row
                  left={MARKET_ITEM_LABELS[purchase.item]}
                  right={`${purchase.pricePaid} BB${purchase.cancelled ? ' · cancelled' : ''}${
                    purchase.expired ? ' · expired' : ''
                  }`}
                />
                {canWithdraw && (
                  <button
                    type="button"
                    disabled={busy || paused}
                    style={{ ...ui.secondaryButton, width: '100%', marginTop: 2 }}
                    onClick={() =>
                      act(SHARED_INTENTS.WITHDRAW_MARKET_PURCHASE, {
                        purchaseId: purchase.purchaseId,
                      })
                    }
                  >
                    REMOVE FROM CART
                  </button>
                )}
              </div>
            );
          })}
        </Section>
      )}

      {/* Other teams' purchases — present ONLY after the reveal. */}
      {shared.market.otherTeamPurchases.length > 0 && (
        <Section title="REVEALED PURCHASES">
          {shared.market.otherTeamPurchases.map((purchase) => (
            <Row
              key={purchase.purchaseId}
              left={`${purchase.teamId} · ${MARKET_ITEM_LABELS[purchase.item]}`}
              right={`${purchase.pricePaid} BB`}
            />
          ))}
        </Section>
      )}

      {/* --- Held advantages ------------------------------------------------ */}
      {shared.yourAdvantages.length > 0 && (
        <Section title="YOUR ADVANTAGES">
          {shared.yourAdvantages.map((advantage) => {
            const spent = advantage.used || advantage.expired;
            return (
              <button
                key={advantage.advantageId}
                type="button"
                disabled={busy || paused || spent}
                style={{
                  ...ui.secondaryButton,
                  width: '100%',
                  marginBottom: ui.SPACING.xs,
                  opacity: spent ? 0.4 : 1,
                }}
                onClick={() =>
                  act(SHARED_INTENTS.USE_ADVANTAGE, { advantageId: advantage.advantageId })
                }
              >
                {ADVANTAGE_LABELS[advantage.type]}
                {advantage.used ? ' · used' : advantage.expired ? ' · expired' : ''}
              </button>
            );
          })}
        </Section>
      )}

      {/* --- Your Maco Mail draws ------------------------------------------- */}
      {shared.yourMacoDraws.length > 0 && (
        <Section title="YOUR MACO MAIL">
          {shared.yourMacoDraws.map((draw) => (
            <div key={draw.drawId} style={{ marginBottom: ui.SPACING.sm }}>
              <p style={{ margin: 0, fontWeight: ui.FONT_WEIGHT.bold }}>
                {MACO_OUTCOME_LABELS[draw.outcome]}
              </p>
              <p style={{ ...ui.muted, margin: 0, fontSize: ui.FONT_SIZE.xs }}>
                {draw.explanation}
              </p>
            </div>
          ))}
        </Section>
      )}

      {/* --- Host Deal ------------------------------------------------------ */}
      {shared.yourDeal !== null && shared.yourDeal.choice === null && (
        <Section title="HOST DEAL">
          <p style={{ margin: 0, fontWeight: ui.FONT_WEIGHT.bold }}>
            {shared.yourDeal.terms.label}
          </p>
          <p style={{ ...ui.muted, fontSize: ui.FONT_SIZE.xs }}>
            {describeDeal(shared.yourDeal.terms)}
          </p>
          <div style={{ display: 'flex', gap: ui.SPACING.sm }}>
            <button
              type="button"
              disabled={busy || paused}
              style={{ ...ui.button, flex: 1 }}
              onClick={() =>
                act(SHARED_INTENTS.RESPOND_TO_HOST_DEAL, {
                  dealId: shared.yourDeal?.dealId,
                  choice: 'accept',
                })
              }
            >
              TAKE THE RISK
            </button>
            <button
              type="button"
              disabled={busy || paused}
              style={{ ...ui.secondaryButton, flex: 1 }}
              onClick={() =>
                act(SHARED_INTENTS.RESPOND_TO_HOST_DEAL, {
                  dealId: shared.yourDeal?.dealId,
                  choice: 'decline',
                })
              }
            >
              KEEP IT SAFE
            </button>
          </div>
        </Section>
      )}

      {/* --- Wager (test harness) ------------------------------------------- */}
      <WagerBox shared={shared} busy={busy || paused} onSubmit={act} />
    </div>
  );
}

/** Price for an item this Market, from the server's published table. */
function priceOf(shared: PlayerSharedSystemsView, item: MarketItem): number {
  return shared.market.market?.prices[item] ?? 0;
}

/**
 * Plain-language deal terms.
 *
 * Built from the SERVER's terms object, never from numbers written here — the
 * maths belongs to the locked templates (GAME_RULES_LOCKED.md §9).
 */
function describeDeal(terms: PlayerSharedSystemsView['yourDeal'] extends null
  ? never
  : NonNullable<PlayerSharedSystemsView['yourDeal']>['terms']): string {
  const parts: string[] = [];
  if (terms.declineBb > 0) parts.push(`Keep ${terms.declineBb} BB`);
  if (terms.acceptCostBb > 0) parts.push(`or pay ${terms.acceptCostBb} BB`);
  if (terms.acceptPaysOpponentBb > 0) {
    parts.push(`or give an opponent ${terms.acceptPaysOpponentBb} BB`);
  }
  if (terms.acceptGrantsMacoDraw) parts.push('for a Maco Mail');
  if (terms.acceptCreatesPendingBet) {
    parts.push(`or risk it: correct = ${terms.pendingBetWinBb} BB, wrong = 0`);
  }
  return parts.join(' ');
}

/** DEV/TEST wager input. Phase 6 spec §45 — a harness, not Family Feud. */
function WagerBox({
  shared,
  busy,
  onSubmit,
}: {
  shared: PlayerSharedSystemsView;
  busy: boolean;
  onSubmit: (type: string, payload: unknown) => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const live = shared.yourWagers.find((w) => w.status === 'locked');

  if (live !== undefined) {
    return (
      <Section title="YOUR WAGER">
        <Row left="Locked" right={`${live.amount} BB`} />
        <p style={{ ...ui.muted, fontSize: ui.FONT_SIZE.xs }}>
          Waiting for the Host to resolve it.
        </p>
      </Section>
    );
  }

  return (
    <Section title="WAGER (TEST)">
      <input
        type="number"
        inputMode="numeric"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        placeholder="Amount"
        style={ui.input}
        aria-label="Wager amount"
      />
      <button
        type="button"
        disabled={busy || amount === ''}
        style={{ ...ui.secondaryButton, width: '100%', marginTop: ui.SPACING.xs }}
        onClick={() => {
          void onSubmit(SHARED_INTENTS.PROPOSE_WAGER, { amount: Number(amount) });
          setAmount('');
        }}
      >
        LOCK WAGER
      </button>
      <p style={{ ...ui.muted, fontSize: ui.FONT_SIZE.xs }}>
        The server caps this at 50% of your BB and refuses anything above it.
      </p>
    </Section>
  );
}

/**
 * The Clash window, made deliberately impossible to miss.
 *
 * GAME_RULES_LOCKED.md §5 gives a team a genuinely short window to react — 6
 * seconds (D-029, raised from 3 after physical testing showed 3 too easy to
 * lose without noticing). A player who has the phone in their pocket, or is
 * looking at the Host display instead of their own screen, needs this to be
 * the loudest thing on the page the moment it opens — not a panel styled
 * identically to "your held advantages".
 */
function ClashBanner({
  clash,
  yourResponse,
  hand,
  opponentTeamIds,
  busy,
  onPlay,
}: {
  clash: NonNullable<PlayerSharedSystemsView['clash']>;
  yourResponse: string | null;
  hand: PlayerSharedSystemsView['yourHand'];
  opponentTeamIds: readonly string[];
  busy: boolean;
  onPlay: (cardInstanceId: string, targetTeamId: string | null) => void;
}) {
  const remainingMs = useCountdown(clash.remainingMs);
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const urgent = remainingMs <= 2_000;

  return (
    <div
      role="alert"
      style={{
        marginTop: ui.SPACING.md,
        padding: ui.SPACING.md,
        borderRadius: ui.RADIUS.md,
        background: urgent ? ui.COLOR.danger : ui.COLOR.warning,
        color: '#1a1300',
        // A CSS animation rather than a JS-driven style flip: it keeps
        // pulsing smoothly across re-renders without fighting the countdown
        // interval below for control of this element's style.
        animation: 'bb-clash-pulse 0.9s ease-in-out infinite',
      }}
    >
      <style>{`
        @keyframes bb-clash-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(0,0,0,0.15); }
          50% { box-shadow: 0 0 0 8px rgba(0,0,0,0); }
        }
      `}</style>

      <p
        style={{
          margin: 0,
          fontSize: ui.FONT_SIZE.lg,
          fontWeight: ui.FONT_WEIGHT.bold,
          letterSpacing: 1,
          textTransform: 'uppercase',
        }}
      >
        ⚡ Bacchanal Clash!
      </p>

      <p
        style={{
          margin: `${ui.SPACING.xs}px 0 0`,
          fontSize: ui.FONT_SIZE.xxl,
          fontWeight: ui.FONT_WEIGHT.bold,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {remainingSeconds}s
      </p>

      {yourResponse !== null ? (
        <p style={{ margin: `${ui.SPACING.xs}px 0 0` }}>
          Your counter is locked in. Waiting for the reveal…
        </p>
      ) : clash.eligibleTeamIds.length > 0 ? (
        <>
          <p style={{ margin: `${ui.SPACING.xs}px 0 ${ui.SPACING.sm}px` }}>
            {CARD_DISPLAY_LABELS[clash.initiatingCardType]} was played. Counter now, or it
            resolves:
          </p>
          <div style={{ background: ui.COLOR.surface, borderRadius: ui.RADIUS.md, padding: ui.SPACING.sm }}>
            <CardList
              cards={hand}
              busy={busy}
              onPlay={onPlay}
              opponentTeamIds={opponentTeamIds}
            />
          </div>
        </>
      ) : (
        <p style={{ margin: `${ui.SPACING.xs}px 0 0` }}>
          A Clash is running. You have nothing eligible to counter with.
        </p>
      )}
    </div>
  );
}

/**
 * Interpolate a server-reported countdown between updates.
 *
 * The same discipline as PlayerGame.tsx's TimerDisplay: the server's
 * `remainingMs` is the only authority on when the window closes, this only
 * makes the number move smoothly between snapshots. Resets whenever a fresh
 * `remainingMs` arrives, so a snapshot refresh never lets this drift.
 */
function useCountdown(remainingMs: number): number {
  const [displayMs, setDisplayMs] = useState(remainingMs);

  useEffect(() => {
    setDisplayMs(remainingMs);
    const startedAt = Date.now();
    const id = setInterval(() => {
      setDisplayMs(Math.max(0, remainingMs - (Date.now() - startedAt)));
    }, 100);
    return () => clearInterval(id);
  }, [remainingMs]);

  return displayMs;
}

/**
 * The hand, with the server's playability decision rendered.
 *
 * A disabled button here is a COURTESY. The server refuses the same play
 * (spec §7), so this cannot be the protection — it just stops a player tapping
 * something that was always going to fail.
 */
function CardList({
  cards,
  busy,
  onPlay,
  opponentTeamIds,
}: {
  cards: PlayerSharedSystemsView['yourHand'];
  busy: boolean;
  onPlay: (cardInstanceId: string, targetTeamId: string | null) => void;
  opponentTeamIds: readonly string[];
}) {
  const [targeting, setTargeting] = useState<string | null>(null);

  return (
    <>
      {cards.map((card) => {
        const needsTarget = ['GIMME_DAT', 'DOH_KNOW', 'ALLYUH_HELP_ME', 'STEUPS'].includes(
          card.cardType,
        );

        if (targeting === card.cardInstanceId) {
          return (
            <div key={card.cardInstanceId} style={{ marginBottom: ui.SPACING.sm }}>
              <p style={{ ...ui.muted, margin: 0, fontSize: ui.FONT_SIZE.xs }}>
                {CARD_DISPLAY_LABELS[card.cardType]} — choose a target:
              </p>
              {opponentTeamIds.map((teamId) => (
                <button
                  key={teamId}
                  type="button"
                  disabled={busy}
                  style={{ ...ui.button, width: '100%', marginTop: ui.SPACING.xs }}
                  onClick={() => {
                    onPlay(card.cardInstanceId, teamId);
                    setTargeting(null);
                  }}
                >
                  {teamId}
                </button>
              ))}
              <button
                type="button"
                style={{ ...ui.secondaryButton, width: '100%', marginTop: ui.SPACING.xs }}
                onClick={() => setTargeting(null)}
              >
                CANCEL
              </button>
            </div>
          );
        }

        return (
          <button
            key={card.cardInstanceId}
            type="button"
            disabled={busy || !card.playable}
            style={{
              ...ui.secondaryButton,
              width: '100%',
              marginBottom: ui.SPACING.xs,
              opacity: card.playable ? 1 : 0.4,
              textAlign: 'left',
            }}
            onClick={() => {
              if (needsTarget) setTargeting(card.cardInstanceId);
              else onPlay(card.cardInstanceId, null);
            }}
          >
            <span style={{ fontWeight: ui.FONT_WEIGHT.bold }}>
              {CARD_DISPLAY_LABELS[card.cardType]}
            </span>
            <span style={{ ...ui.muted, display: 'block', fontSize: ui.FONT_SIZE.xs }}>
              {card.category}
              {card.playable ? '' : ` · ${explainUnplayable(card.unplayableReason)}`}
            </span>
          </button>
        );
      })}
    </>
  );
}

/**
 * Why a card is disabled, in words a player can act on.
 *
 * `compatibility_unresolved` is Maco! — OPEN_RULES.md §7. It says the rule is
 * still being decided rather than "wrong challenge", which would imply a right
 * one exists.
 */
function explainUnplayable(reason: string | null): string {
  switch (reason) {
    case 'compatibility_unresolved':
      return 'rule still being decided';
    case 'not_eligible':
      return 'not for this challenge';
    case 'already_played_this_challenge':
      return 'already played a card';
    case 'lost_clash_this_challenge':
      return 'lost a Clash here';
    case 'no_challenge':
      return 'no challenge open';
    case 'paused':
      return 'game paused';
    default:
      return 'unavailable';
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: ui.SPACING.md,
        paddingTop: ui.SPACING.md,
        borderTop: `1px solid ${ui.COLOR.border}`,
      }}
    >
      <p
        style={{
          ...ui.label,
          fontSize: ui.FONT_SIZE.xs,
          letterSpacing: 1,
          marginBottom: ui.SPACING.sm,
        }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

function Row({ left, right }: { left: string; right: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
      <span style={ui.muted}>{left}</span>
      <span style={{ ...ui.muted, fontVariantNumeric: 'tabular-nums' }}>{right}</span>
    </div>
  );
}

/** Says plainly that this is test scaffolding. Phase 6 spec §44/§45. */
function DevBanner() {
  return (
    <p
      style={{
        ...ui.muted,
        fontSize: ui.FONT_SIZE.xs,
        textAlign: 'center',
        letterSpacing: 1,
        opacity: 0.5,
        margin: 0,
      }}
    >
      PHASE 6 TEST UI
    </p>
  );
}

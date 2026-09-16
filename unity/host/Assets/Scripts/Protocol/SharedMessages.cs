using System;

namespace BrainsAndBacchanal.Protocol
{
    /// <summary>
    /// Phase 6 shared systems — the Unity side of the wire.
    ///
    /// Mirrors packages/protocol/src/{cards,market,maco-mail,deals,shared-systems}.ts.
    ///
    /// ============ JsonUtility FAILS QUIETLY ============
    /// A C# field that does not match the server's JSON deserialises to zero or
    /// null rather than throwing. A DTO drift here would appear as "0 BB" or an
    /// empty hand on a TV in front of a room of people, not as an error. That is
    /// why HeadlessEngineCheck reads REAL server JSON through these types and
    /// asserts the values — inspection is not enough.
    /// ===================================================
    ///
    /// All types are [Serializable] with plain public fields, because Unity's
    /// JsonUtility ignores properties and constructors.
    /// </summary>
    public static class SharedIntents
    {
        // Host-gated.
        public const string DealBacchanalCards = "HOST_DEAL_BACCHANAL_CARDS";
        public const string OpenCardWindow = "HOST_OPEN_CARD_WINDOW";
        public const string CloseCardWindow = "HOST_CLOSE_CARD_WINDOW";
        public const string OpenMarket = "HOST_OPEN_MARKET";
        public const string CloseMarket = "HOST_CLOSE_MARKET";
        public const string DrawMacoMail = "HOST_DRAW_MACO_MAIL";
        public const string OfferDeal = "HOST_OFFER_DEAL";
        public const string ResolveWager = "HOST_RESOLVE_WAGER";

        // Player-gated. Listed for completeness; the Host never sends these.
        public const string PlayBacchanalCard = "PLAY_BACCHANAL_CARD";
        public const string RespondToClash = "RESPOND_TO_CLASH";
        public const string PurchaseMarketItem = "PURCHASE_MARKET_ITEM";
        public const string UseAdvantage = "USE_ADVANTAGE";
        public const string RespondToHostDeal = "RESPOND_TO_HOST_DEAL";
        public const string ProposeWager = "PROPOSE_WAGER";
    }

    public static class SharedEvents
    {
        public const string BacchanalCardsDealt = "BACCHANAL_CARDS_DEALT";
        public const string CardWindowOpened = "CARD_WINDOW_OPENED";
        public const string CardWindowClosed = "CARD_WINDOW_CLOSED";
        public const string BacchanalCardPlayed = "BACCHANAL_CARD_PLAYED";
        public const string ClashOpened = "CLASH_OPENED";
        public const string ClashResponseReceived = "CLASH_RESPONSE_RECEIVED";
        public const string ClashResolved = "CLASH_RESOLVED";
        public const string PartDatFight = "PART_DAT_FIGHT";
        public const string CardEffectApplied = "CARD_EFFECT_APPLIED";
        public const string BacchanalImmunityTriggered = "BACCHANAL_IMMUNITY_TRIGGERED";
        public const string MarketOpened = "MARKET_OPENED";
        public const string MarketPurchaseRecorded = "MARKET_PURCHASE_RECORDED";
        public const string MarketClosed = "MARKET_CLOSED";
        public const string MacoMailDrawn = "MACO_MAIL_DRAWN";
        public const string AdvantageUsed = "ADVANTAGE_USED";
        public const string HostDealOffered = "HOST_DEAL_OFFERED";
        public const string HostDealResolved = "HOST_DEAL_RESOLVED";
        public const string WagerLocked = "WAGER_LOCKED";
        public const string WagerResolved = "WAGER_RESOLVED";
    }

    /// <summary>
    /// The challenge kinds the locked compatibility table names.
    ///
    /// GAME_RULES_LOCKED.md §6. Used by the dev panel to open a card window;
    /// the SERVER decides eligibility from these, never this file.
    /// </summary>
    public static class CardChallengeKinds
    {
        public const string Round1Trivia = "ROUND1_TRIVIA";
        public const string Round2Physical = "ROUND2_PHYSICAL";
        public const string ThinkFast = "THINK_FAST";
        public const string GuessTheLogo = "GUESS_THE_LOGO";
        public const string AllAnswersBeginWith = "ALL_ANSWERS_BEGIN_WITH";
        public const string SingASong = "SING_A_SONG";
        public const string FamilyFeudQ1Q3 = "FAMILY_FEUD_Q1_Q3";
        public const string FamilyFeudQ4Q5 = "FAMILY_FEUD_Q4_Q5";
        public const string SuddenDeath = "SUDDEN_DEATH";
    }

    /// <summary>The four locked Host Deal templates. GAME_RULES_LOCKED.md §9.</summary>
    public static class HostDealTemplates
    {
        public const string KeepOrRisk = "KEEP_OR_RISK";
        public const string DoubleOrNothingIsh = "DOUBLE_OR_NOTHING_ISH";
        public const string MysteryDeal = "MYSTERY_DEAL";
        public const string OpponentsDeal = "OPPONENTS_DEAL";
    }

    /// <summary>One Bacchanal card instance.</summary>
    [Serializable]
    public class BacchanalCardInstance
    {
        public string cardInstanceId;
        public string cardType;
        public string category;
        public string owningTeamId;

        /// <summary>HELD, PENDING, RESOLVING or CONSUMED.</summary>
        public string status;

        public long dealtAt;
        public long usedAt;
        public string challengeId;
    }

    /// <summary>
    /// One team's hand, as the Host sees it.
    ///
    /// JsonUtility cannot deserialise a Dictionary, and the server sends `hands`
    /// as an object keyed by teamId. The Host panel therefore reads hands from
    /// the per-team arrays below rather than from a map — see HostSharedView.
    /// </summary>
    [Serializable]
    public class TeamHandView
    {
        public string teamId;
        public BacchanalCardInstance[] cards;
    }

    /// <summary>The card-play window for the current challenge.</summary>
    [Serializable]
    public class CardWindowView
    {
        public bool open;
        public string challengeKind;
        public string[] teamsWhoPlayed;
        public string[] barredCardInstanceIds;
    }

    /// <summary>
    /// A Clash in progress or resolved.
    ///
    /// NOTE WHAT IS ABSENT while the window is open: the card types of the
    /// responses. `respondedTeamIds` says who acted; `result` is null until the
    /// reveal. Phase 6 spec §42.
    /// </summary>
    [Serializable]
    public class ClashView
    {
        public string clashId;
        public string challengeId;
        public string initiatingTeamId;
        public string initiatingCardType;
        public long openedAt;
        public int remainingMs;
        public string[] respondedTeamIds;
        public string[] eligibleTeamIds;
        public bool resolved;
        public ClashResult result;
    }

    [Serializable]
    public class ClashResult
    {
        /// <summary>uncontested, winner or part_dat_fight.</summary>
        public string outcome;

        public string winningTeamId;
        public string winningCardType;
        public ClashEntryView[] entries;
        public string[] returnedTeamIds;
        public long resolvedAt;

        /// <summary>Plain-language explanation for the display. Descriptive only.</summary>
        public string explanation;
    }

    [Serializable]
    public class ClashEntryView
    {
        public string teamId;
        public string cardInstanceId;
        public string cardType;
        public string category;
        public bool initiator;
        public bool survived;
    }

    /// <summary>A Market activation.</summary>
    [Serializable]
    public class MarketView
    {
        public string marketId;
        public int round;
        public bool open;
        public long openedAt;
        public long closedAt;

        /// <summary>False while open. Purchases reveal when the Market closes.</summary>
        public bool revealed;
    }

    /// <summary>One purchase. `pricePaid` is what actually left the ledger.</summary>
    [Serializable]
    public class MarketPurchaseView
    {
        public string purchaseId;
        public string teamId;
        public string item;
        public int round;
        public int listedPrice;
        public int surcharge;

        /// <summary>listedPrice + surcharge. Refunds use THIS, never a recomputed price.</summary>
        public int pricePaid;

        public long purchasedAt;
        public bool used;
        public bool cancelled;
        public int expiresAfterRound;
        public bool expired;
    }

    /// <summary>A held advantage, from the Market or from Maco Mail.</summary>
    [Serializable]
    public class HeldAdvantageView
    {
        public string advantageId;
        public string type;
        public string teamId;

        /// <summary>market or maco_mail. Decides the expiry rule.</summary>
        public string source;

        public string purchaseId;
        public long acquiredAt;

        /// <summary>
        /// Zero means "no round expiry" — the Maco Mail rule (§7: held until
        /// used or the game ends). JsonUtility maps a JSON null to 0 here.
        /// </summary>
        public int expiresAfterRound;

        public bool used;
        public long usedAt;
        public bool expired;
    }

    /// <summary>
    /// The Maco Mail deck. COUNTS ONLY.
    ///
    /// There is deliberately no field for the order, for the Host either: a Host
    /// display is usually pointed at a TV the players can see, and the next card
    /// is the most valuable secret in the game. Phase 6 spec §42.
    /// </summary>
    [Serializable]
    public class MacoDeckView
    {
        public int drawPileCount;
        public int discardCount;
        public int heldOutOfDeckCount;
        public int removedImpossibleCount;
    }

    /// <summary>One drawn Maco Mail card and what it did.</summary>
    [Serializable]
    public class MacoDrawView
    {
        public string drawId;
        public string teamId;
        public string outcome;

        /// <summary>resolved, held, applied, dud or blocked_open_rule.</summary>
        public string result;

        public long drawnAt;
        public int bbApplied;
        public string targetTeamId;
        public string advantageId;
        public string explanation;
    }

    /// <summary>What a Host Deal template actually pays. Server-supplied.</summary>
    [Serializable]
    public class HostDealTerms
    {
        public string template;
        public string label;
        public int declineBb;
        public int acceptCostBb;
        public bool acceptGrantsMacoDraw;
        public int acceptPaysOpponentBb;
        public bool acceptCreatesPendingBet;
        public int pendingBetWinBb;
        public int pendingBetLoseBb;
        public bool requiresOpponent;
    }

    /// <summary>An offered Host Deal.</summary>
    [Serializable]
    public class HostDealView
    {
        public string dealId;
        public string template;
        public string teamId;
        public string opponentTeamId;
        public int roundIndex;
        public long offeredAt;
        public string choice;
        public long resolvedAt;
        public HostDealTerms terms;
    }

    /// <summary>A locked or resolved wager.</summary>
    [Serializable]
    public class WagerView
    {
        public string wagerId;
        public string teamId;
        public int amount;
        public int balanceAtLock;
        public int maxAllowed;

        /// <summary>locked, won, lost or cancelled.</summary>
        public string status;

        public long lockedAt;
        public long resolvedAt;
        public int bbApplied;
        public string contextRef;
    }

    /// <summary>
    /// The Host's view of the Phase 6 shared systems.
    ///
    /// `hands` is deliberately NOT here as a map: JsonUtility cannot deserialise
    /// a Dictionary, and silently producing an empty one would be exactly the
    /// quiet failure described at the top of this file. The dev panel reads
    /// per-team card counts from the events and the per-team views instead.
    /// </summary>
    [Serializable]
    public class HostSharedView
    {
        public CardWindowView cardWindow;
        public ClashView clash;
        public MarketView market;
        public MarketPurchaseView[] purchases;
        public HeldAdvantageView[] advantages;
        public MacoDeckView macoDeck;
        public MacoDrawView[] macoDraws;
        public HostDealView[] deals;
        public WagerView[] wagers;
    }
}

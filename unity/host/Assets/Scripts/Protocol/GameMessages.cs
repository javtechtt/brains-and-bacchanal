using System;

namespace BrainsAndBacchanal.Protocol
{
    /// <summary>
    /// C# mirror of the Phase 5 game protocol (packages/protocol/src/game.ts).
    ///
    /// The TypeScript side is the source of truth. NOTHING HERE DECIDES ANYTHING:
    /// Unity renders the game the server describes and asks for changes by
    /// sending intents. There is no BB arithmetic, no floor rule, no timer
    /// expiry and no turn logic in this file — duplicating any of that in the
    /// Host would create a second interpretation of the rules, which is exactly
    /// what CLAUDE.md forbids.
    ///
    /// All types are [Serializable] with plain public fields, because Unity's
    /// JsonUtility handles nothing else.
    /// </summary>
    public static class GameIntents
    {
        public const string StartGame = "START_GAME";
        public const string AdvancePhase = "HOST_ADVANCE_PHASE";

        public const string PrepareChallenge = "HOST_PREPARE_CHALLENGE";
        public const string StartChallenge = "HOST_START_CHALLENGE";
        public const string SetTurn = "HOST_SET_TURN";
        public const string SetActivePlayers = "HOST_SET_ACTIVE_PLAYERS";

        public const string StartTimer = "HOST_START_TIMER";
        public const string CancelTimer = "HOST_CANCEL_TIMER";

        public const string RequestReview = "HOST_REQUEST_REVIEW";
        public const string Ruling = "HOST_RULING";
        public const string ResolveChallenge = "HOST_RESOLVE_CHALLENGE";

        public const string PauseGame = "HOST_PAUSE_GAME";
        public const string ResumeGame = "HOST_RESUME_GAME";

        public const string RequestGameSnapshot = "REQUEST_GAME_SNAPSHOT";

        /// <summary>
        /// DEVELOPMENT ONLY. Refused unless the server runs with development
        /// tools enabled, and every entry it writes is marked as a development
        /// adjustment in the ledger. It will not exist in the finished game.
        /// </summary>
        public const string DevAdjustBb = "DEV_ADJUST_BB";
    }

    public static class GameEvents
    {
        public const string GameStarted = "GAME_STARTED";
        public const string PhaseChanged = "PHASE_CHANGED";
        public const string BbChanged = "BB_CHANGED";
        public const string ChallengePrepared = "CHALLENGE_PREPARED";
        public const string ChallengeStarted = "CHALLENGE_STARTED";
        public const string ChallengeResolved = "CHALLENGE_RESOLVED";
        public const string TurnChanged = "TURN_CHANGED";
        public const string ActivePlayersChanged = "ACTIVE_PLAYERS_CHANGED";
        public const string TimerStarted = "TIMER_STARTED";
        public const string TimerCancelled = "TIMER_CANCELLED";
        public const string TimerExpired = "TIMER_EXPIRED";
        public const string HostRulingRecorded = "HOST_RULING_RECORDED";
        public const string ReviewRequested = "REVIEW_REQUESTED";
        public const string GamePaused = "GAME_PAUSED";
        public const string GameResumed = "GAME_RESUMED";
    }

    /// <summary>The subjective calls the Host is authoritative for.</summary>
    public static class HostRulingKinds
    {
        public const string Valid = "valid";
        public const string Invalid = "invalid";
        public const string SelectWinner = "select_winner";
        public const string Note = "note";
    }

    /// <summary>One team during an active game.</summary>
    [Serializable]
    public class GameTeamView
    {
        public string teamId;
        public string displayName;
        public string[] memberIds;

        /// <summary>
        /// Authoritative balance. DISPLAYED, NEVER CALCULATED HERE — the server
        /// owns the ledger and the floor at zero.
        /// </summary>
        public int bb;
    }

    /// <summary>Whose turn it is. Empty strings mean "nobody".</summary>
    [Serializable]
    public class TurnOwnership
    {
        public string teamId;
        public string playerId;

        public bool HasTeam => !string.IsNullOrEmpty(teamId);
        public bool HasPlayer => !string.IsNullOrEmpty(playerId);
    }

    /// <summary>
    /// A running server-owned timer.
    ///
    /// `remainingMs` is what the server said at snapshot time. The Host may
    /// count down locally for a smooth display, but expiry is the server's
    /// decision, announced as TIMER_EXPIRED.
    /// </summary>
    [Serializable]
    public class TimerView
    {
        public string timerId;
        public int durationMs;
        public int remainingMs;
        public bool paused;
        public bool expired;
        public long startedAt;
        public string challengeId;
    }

    /// <summary>A recorded Host ruling.</summary>
    [Serializable]
    public class HostRuling
    {
        public string rulingId;
        public string kind;
        public string challengeId;
        public string teamId;
        public string playerId;
        public long at;
        public long seq;
        public string note;
    }

    /// <summary>A generic challenge outcome.</summary>
    [Serializable]
    public class GameChallengeResult
    {
        public string[] winningTeamIds;
        public string[] winningPlayerIds;
        public bool decidedByHost;
        public long resolvedAt;
        public string completion;
        public string note;
    }

    /// <summary>
    /// The challenge in progress.
    ///
    /// CONTENT SAFETY: `configRef` is an opaque reference. There is no field
    /// here for question text, an accepted answer or a board label, and there
    /// must never be one — the Host display receives no unrevealed content it
    /// does not need.
    /// </summary>
    [Serializable]
    public class GameChallengeView
    {
        public string challengeId;
        public string challengeType;
        public string status;
        public string configRef;
        public TurnOwnership turn;
        public string[] activePlayerIds;
        public long startedAt;
        public TimerView timer;
        public HostRuling[] rulings;
        public GameChallengeResult result;
    }

    /// <summary>Why the game is paused and where it returns to.</summary>
    [Serializable]
    public class GamePauseView
    {
        public string reason;
        public long pausedAt;
        public string resumePhase;
        public string pausedByPlayerId;
    }

    /// <summary>The active game session.</summary>
    [Serializable]
    public class GameSessionView
    {
        public string gameId;
        public string roomId;
        public string phase;
        public long startedAt;
        public int roundIndex;
        public bool paused;
        public GamePauseView pause;
        public GameChallengeView challenge;
        public TurnOwnership turn;
    }

    /// <summary>One entry in the BB history. Host-only.</summary>
    [Serializable]
    public class BbLedgerEntry
    {
        public string entryId;
        public string teamId;

        /// <summary>Requested change. Negative deducts.</summary>
        public int delta;

        /// <summary>
        /// What actually moved after the floor at zero. Differs from `delta`
        /// exactly when a deduction hit the floor.
        /// </summary>
        public int applied;

        public int balanceBefore;
        public int balanceAfter;
        public string reason;
        public long at;
        public string challengeId;
        public string note;
    }

    /// <summary>
    /// The Host's game snapshot.
    ///
    /// Carries the ledger, which the player snapshot deliberately does not.
    /// Neither carries a reconnect credential or the Host token.
    /// </summary>
    [Serializable]
    public class HostGameSnapshot
    {
        public int protocolVersion;
        public long seq;
        public long takenAt;
        public LobbyRoom room;
        public LobbyPlayer[] players;
        public GameTeamView[] teams;
        public int teamMode;

        /// <summary>Null until the Host starts the game.</summary>
        public GameSessionView game;

        public bool isHost;
        public BbLedgerEntry[] ledger;

        /// <summary>Whether this server accepts development engine controls.</summary>
        public bool devToolsEnabled;

        public bool GameRunning => game != null && !string.IsNullOrEmpty(game.gameId);
    }
}

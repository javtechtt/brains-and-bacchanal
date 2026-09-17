using System;

namespace BrainsAndBacchanal.Protocol
{
    /// <summary>
    /// C# mirror of the Round 2 protocol (packages/protocol/src/round2.ts).
    /// Phase 7A.
    ///
    /// The TypeScript side is the source of truth. NOTHING HERE DECIDES
    /// ANYTHING — and in Round 2 that matters twice over:
    ///
    ///   1. The 500 BB reward, the multiplier and the winner all come from the
    ///      server. This file carries the numbers to a screen; it never
    ///      computes one. A doubled award arrives as 1,000 because the server
    ///      doubled it, not because Unity multiplied anything.
    ///
    ///   2. THE PHYSICAL GAME IS NOT MODELLED. D-003 puts Bottle Battle, Match
    ///      Makers, Grabbers and Bombers outside the software entirely. There is
    ///      no rule, duration, score or player input for any of them here,
    ///      because there is none anywhere.
    ///
    /// The four challenge names are NOT hard-coded in the Host scene: they
    /// arrive in the snapshot as `displayName`, so renaming a game is a server
    /// change. Phase 7A spec §3 and §11.
    ///
    /// All types are [Serializable] with plain public fields, because Unity's
    /// JsonUtility handles nothing else.
    ///
    /// ⚠ JsonUtility FAILS QUIETLY. A field name that does not match the
    /// server's JSON deserialises to zero, null or "" rather than throwing — so
    /// a typo here shows up as "0 BB" on a TV in front of a room of people, not
    /// as an error. HeadlessRound2Check.cs reads real server JSON through these
    /// DTOs and asserts the values for exactly that reason.
    /// </summary>
    public static class Round2Intents
    {
        /// <summary>Prepare the next physical challenge, in the locked order.</summary>
        public const string PrepareChallenge = "HOST_PREPARE_ROUND2_CHALLENGE";

        /// <summary>
        /// Select a winning team. STEP ONE OF TWO — moves no BB.
        ///
        /// Split from confirmation so a misclick is visible on screen before it
        /// pays anything (Phase 7A spec §19).
        /// </summary>
        public const string SelectWinner = "HOST_SELECT_PHYSICAL_WINNER";

        /// <summary>
        /// Confirm the selected winner. STEP TWO — this is what pays.
        ///
        /// CARRIES NO AMOUNT. The server takes the reward from configuration and
        /// the multiplier from the shared systems; a payload field naming a
        /// number would be ignored, because no handler reads one.
        /// </summary>
        public const string ConfirmResult = "HOST_CONFIRM_PHYSICAL_RESULT";

        /// <summary>
        /// DEVELOPMENT ONLY — enter Round 2 without playing Round 1.
        ///
        /// Round 1 is not implemented, so there is no production path here yet.
        /// Refused unless the server runs with development tools enabled, the
        /// same gate as DevAdjustBb. It will not exist in the finished game.
        /// </summary>
        public const string DevStartRound2 = "DEV_START_ROUND2";
    }

    public static class Round2Events
    {
        public const string RoundStarted = "ROUND2_STARTED";
        public const string ChallengePrepared = "ROUND2_CHALLENGE_PREPARED";
        public const string WinnerSelected = "ROUND2_WINNER_SELECTED";
        public const string ChallengeResolved = "ROUND2_CHALLENGE_RESOLVED";
        public const string RoundCompleted = "ROUND2_COMPLETED";
    }

    /// <summary>How far one Round 2 challenge has got.</summary>
    public static class Round2Progress
    {
        public const string NotStarted = "not_started";
        public const string InProgress = "in_progress";
        public const string Resolved = "resolved";
    }

    /// <summary>
    /// One Round 2 physical challenge, as the server describes it.
    ///
    /// `displayName` is what goes on the TV, and it comes from the server —
    /// the Host scene holds no list of Round 2 game names.
    /// </summary>
    [Serializable]
    public class Round2ChallengeView
    {
        public string challengeType;
        public string displayName;
        public int order;

        /// <summary>Base BB before any multiplier. 500 (GAME_RULES_LOCKED.md §12).</summary>
        public int baseRewardBb;

        public string progress;
        public string challengeId;

        /// <summary>Confirmed winner. Empty until the Host confirms.</summary>
        public string winningTeamId;

        /// <summary>
        /// What was actually paid, after any multiplier and the floor.
        ///
        /// Nullable on the wire (null until resolved), so it is an int? here —
        /// JsonUtility cannot express that, which is why the resolved state is
        /// read from `progress` rather than from this being non-zero.
        /// </summary>
        public int awardedBb;

        /// <summary>Whether a legally played Double It doubled this award.</summary>
        public bool doubled;

        public long resolvedAt;

        public bool IsResolved => progress == Round2Progress.Resolved;
        public bool IsInProgress => progress == Round2Progress.InProgress;
        public bool HasWinner => !string.IsNullOrEmpty(winningTeamId);

        /// <summary>
        /// Whether this object actually came from the server.
        ///
        /// ⚠ JsonUtility CANNOT REPRESENT A NULL CLASS FIELD. A JSON `null`
        /// deserialises to a fully-constructed object with every field at its
        /// default, NOT to null. So `current == null` is never true in C#, even
        /// when the server correctly sent `"current": null` — which it does
        /// between challenges and once the round is complete.
        ///
        /// Every nullable object on the wire therefore needs a field that is
        /// never empty when the object is real. `challengeType` is that field
        /// here: the server always sets it, so an empty one means "there was no
        /// object".
        ///
        /// This was caught by HeadlessRound2Check reading real server JSON —
        /// exactly the quiet failure that check exists for.
        /// </summary>
        public bool Exists => !string.IsNullOrEmpty(challengeType);
    }

    /// <summary>
    /// Round 2 as the Host display sees it.
    ///
    /// Identical for the Host and for a phone — every field is public. Which
    /// game is running and who won are exactly what a party game puts on a TV,
    /// so there is nothing here to hide and no field capable of carrying a
    /// secret. The secrets (hands, hidden purchases, unrevealed Clash
    /// responses) live in HostSharedView.
    /// </summary>
    [Serializable]
    public class Round2StateView
    {
        public int roundIndex;

        /// <summary>All four, in the locked order.</summary>
        public Round2ChallengeView[] challenges;

        /// <summary>The challenge running now. Null between games and once complete.</summary>
        public Round2ChallengeView current;

        public int resolvedCount;

        /// <summary>True once all four have resolved (Phase 7A §18).</summary>
        public bool complete;

        /// <summary>The teams the Host may select between. All of them.</summary>
        public string[] participatingTeamIds;

        /// <summary>
        /// Selected but NOT yet confirmed. Empty when nothing is selected.
        ///
        /// The whole point of the two-step: this is what the confirmation
        /// button confirms, and it is on screen before any BB moves.
        /// </summary>
        public string pendingWinnerTeamId;

        /// <summary>Which row of the locked card table applies. ROUND2_PHYSICAL.</summary>
        public string cardChallengeKind;

        public bool HasPendingWinner => !string.IsNullOrEmpty(pendingWinnerTeamId);

        /// <summary>
        /// Whether Round 2 is actually the round being played.
        ///
        /// Same JsonUtility trap as <see cref="Round2ChallengeView.Exists"/>:
        /// `"round2": null` — which every round other than Round 2 sends —
        /// arrives as an object with `challenges == null` and `roundIndex == 0`,
        /// never as a C# null. So the Host panel must ask this rather than
        /// checking the field against null.
        /// </summary>
        public bool Exists => challenges != null && challenges.Length > 0;

        /// <summary>
        /// The challenge running now, or null when there genuinely is none.
        ///
        /// Normalises the JsonUtility empty-object case to a real null, so
        /// callers can use the idiom they expect. Null between challenges and
        /// once the round is complete.
        /// </summary>
        public Round2ChallengeView Current => current != null && current.Exists ? current : null;
    }
}

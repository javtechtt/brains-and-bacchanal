using System;

namespace BrainsAndBacchanal.Protocol
{
    /// <summary>
    /// C# mirror of the Round 3 protocol (packages/protocol/src/round3.ts).
    /// Phase 7B.
    ///
    /// The TypeScript side is the source of truth. NOTHING HERE DECIDES
    /// ANYTHING — the Host display renders what the server says and sends
    /// intents.
    ///
    /// ============ THREE COUNTERS, NEVER COLLAPSED (§13) ============
    ///   challenge points  -> decide ONE challenge; reset every challenge
    ///   challenge wins    -> +1 per challenge won; decide the ROUND
    ///   BB                -> the game's score; only Think Fast and Sing a Song
    ///
    /// Five logos is ONE Round 3 win, not five, and not BB. They are three
    /// separate fields here for exactly that reason.
    /// ===============================================================
    ///
    /// ⚠ JsonUtility CANNOT REPRESENT A NULL CLASS FIELD. A JSON null arrives
    /// as a default-filled object, never as C# null — Phase 7A learned this the
    /// hard way. Every nullable object below therefore carries an `Exists`
    /// predicate keyed on a field the server never leaves empty, and callers
    /// must use it rather than `!= null`.
    ///
    /// ⚠ JsonUtility ALSO CANNOT DESERIALISE A DICTIONARY. The TypeScript side
    /// sends `scores` and `challengeWins` as objects keyed by team id, which
    /// JsonUtility silently drops. They arrive here through the parallel-array
    /// fields the server emits alongside them — see Round3TeamCount.
    /// </summary>
    public static class Round3Intents
    {
        public const string PrepareChallenge = "HOST_PREPARE_ROUND3_CHALLENGE";
        public const string NextItem = "HOST_NEXT_ROUND3_ITEM";
        public const string AwardPoint = "HOST_AWARD_ROUND3_POINT";
        public const string ThinkFastValid = "HOST_THINK_FAST_VALID";
        public const string ThinkFastEliminate = "HOST_THINK_FAST_ELIMINATE";
        public const string ConfirmChallenge = "HOST_CONFIRM_ROUND3_CHALLENGE";

        /// <summary>A team's own rock-paper-scissors throw. PLAYER intent.</summary>
        public const string SubmitRpsChoice = "SUBMIT_RPS_CHOICE";

        /// <summary>DEVELOPMENT ONLY. Refused unless dev tools are enabled.</summary>
        public const string DevStartRound3 = "DEV_START_ROUND3";
    }

    public static class Round3Events
    {
        public const string RoundStarted = "ROUND3_STARTED";
        public const string ChallengePrepared = "ROUND3_CHALLENGE_PREPARED";
        public const string ItemRevealed = "ROUND3_ITEM_REVEALED";
        public const string PointAwarded = "ROUND3_POINT_AWARDED";
        public const string ThinkFastTurnChanged = "THINK_FAST_TURN_CHANGED";
        public const string ThinkFastTeamEliminated = "THINK_FAST_TEAM_ELIMINATED";
        public const string ChallengeResolved = "ROUND3_CHALLENGE_RESOLVED";
        public const string CounterChanged = "ROUND3_COUNTER_CHANGED";
        public const string RpsStarted = "RPS_STARTED";
        public const string RpsChoiceSubmitted = "RPS_CHOICE_SUBMITTED";
        public const string RpsRevealed = "RPS_REVEALED";
        public const string WinnerConfirmed = "ROUND3_WINNER_CONFIRMED";
        public const string RoundCompleted = "ROUND3_COMPLETED";
    }

    public static class Round3Progress
    {
        public const string NotStarted = "not_started";
        public const string InProgress = "in_progress";
        public const string Resolved = "resolved";
    }

    public static class Round3Formats
    {
        /// <summary>Think Fast: teams drop out until one remains. §14.</summary>
        public const string Elimination = "elimination";
        /// <summary>The other three: score points toward a target. §15-§17.</summary>
        public const string Points = "points";
    }

    public static class RpsChoices
    {
        public const string Rock = "ROCK";
        public const string Paper = "PAPER";
        public const string Scissors = "SCISSORS";
    }

    /// <summary>
    /// The current challenge item, as supplied BY THE GAME. §13.
    ///
    /// Only ever the current one — there is no queue, no total and no accepted
    /// answer, because the type has no field for any of them.
    /// </summary>
    [Serializable]
    public class Round3ItemView
    {
        public string itemId;
        public int index;
        public string body;

        /// <summary>The required letter, for All Answers Begin With. Empty otherwise.</summary>
        public string letter;

        /// <summary>An image to resolve. Empty when the item is textual.</summary>
        public string imageRef;

        public long revealedAt;
        public int remainingMs;

        public bool Exists => !string.IsNullOrEmpty(itemId);
        public bool HasLetter => !string.IsNullOrEmpty(letter);
        public bool HasImage => !string.IsNullOrEmpty(imageRef);
    }

    /// <summary>Think Fast state. §14. Null for the other three challenges.</summary>
    [Serializable]
    public class ThinkFastView
    {
        /// <summary>Play order, from the previous round's standings. Fixed at start.</summary>
        public string[] turnOrder;
        public string currentTeamId;
        public string[] eliminatedTeamIds;
        public string[] remainingTeamIds;
        public int validAnswerCount;

        public bool Exists => turnOrder != null && turnOrder.Length > 0;
        public bool HasCurrentTeam => !string.IsNullOrEmpty(currentTeamId);
    }

    /// <summary>One team's challenge points, as a serialisable pair.</summary>
    [Serializable]
    public class Round3TeamCount
    {
        public string teamId;
        public int value;
    }

    /// <summary>One rock-paper-scissors attempt. §18 — NOT a Bacchanal Clash.</summary>
    [Serializable]
    public class RpsAttemptView
    {
        public string attemptId;
        public int attemptNumber;
        public string[] participatingTeamIds;

        /// <summary>Who has locked a choice. NEVER what they chose. §18.</summary>
        public string[] submittedTeamIds;

        public bool resolved;

        /// <summary>Revealed choices, and only after the reveal. Empty while open.</summary>
        public Round3TeamChoice[] revealedChoices;

        public string outcome;
        public string winningTeamId;
        public string[] eliminatedTeamIds;
        public string explanation;
        public long resolvedAt;

        public bool Exists => !string.IsNullOrEmpty(attemptId);
    }

    /// <summary>One team's revealed choice.</summary>
    [Serializable]
    public class Round3TeamChoice
    {
        public string teamId;
        public string choice;
    }

    /// <summary>The whole tiebreaker: attempts until one team remains. §18.</summary>
    [Serializable]
    public class RpsTiebreakerView
    {
        public string[] tiedTeamIds;
        public string[] activeTeamIds;
        public RpsAttemptView current;
        public RpsAttemptView[] history;
        public bool complete;
        public string winningTeamId;

        /// <summary>
        /// The asking team's own choice. Always empty on the HOST's snapshot —
        /// the Host is not a team, and sees no choice before the reveal.
        /// </summary>
        public string yourChoice;

        public bool Exists => tiedTeamIds != null && tiedTeamIds.Length > 0;
    }

    /// <summary>One Round 3 challenge as the display sees it.</summary>
    [Serializable]
    public class Round3ChallengeView
    {
        public string challengeType;
        public string displayName;
        public int order;
        public string format;
        public string progress;
        public string challengeId;

        /// <summary>Challenge points, THIS challenge only. Reset when it ends.</summary>
        public Round3TeamCount[] scoreList;

        /// <summary>The NORMAL target. Reaching it does not resolve anything.</summary>
        public int targetScore;
        public bool targetReached;

        public Round3ItemView currentItem;
        public ThinkFastView thinkFast;
        public string winningTeamId;
        public int awardedBb;
        public bool doubled;
        public long resolvedAt;

        public bool Exists => !string.IsNullOrEmpty(challengeType);
        public bool IsResolved => progress == Round3Progress.Resolved;
        public bool IsInProgress => progress == Round3Progress.InProgress;
        public bool IsElimination => format == Round3Formats.Elimination;
        public bool IsPoints => format == Round3Formats.Points;

        /// <summary>This team's challenge points, or 0.</summary>
        public int ScoreOf(string teamId)
        {
            foreach (var entry in scoreList ?? Array.Empty<Round3TeamCount>())
            {
                if (entry.teamId == teamId) return entry.value;
            }
            return 0;
        }
    }

    /// <summary>Round 3 as the Host display sees it.</summary>
    [Serializable]
    public class Round3StateView
    {
        public int roundIndex;
        public Round3ChallengeView[] challenges;
        public Round3ChallengeView current;
        public int resolvedCount;
        public bool complete;
        public string[] participatingTeamIds;

        /// <summary>
        /// THE ROUND 3 CHALLENGE-WIN COUNTER. +1 per challenge won; decides the
        /// round. NOT BB, and never written to the ledger.
        /// </summary>
        public Round3TeamCount[] challengeWinList;

        /// <summary>Previous round standings, best first. Think Fast order. §14.</summary>
        public string[] previousRoundOrder;

        public RpsTiebreakerView tiebreaker;
        public string winningTeamId;

        public bool Exists => challenges != null && challenges.Length > 0;
        public bool HasWinner => !string.IsNullOrEmpty(winningTeamId);

        /// <summary>The challenge running now, or null when genuinely none.</summary>
        public Round3ChallengeView Current => current != null && current.Exists ? current : null;

        /// <summary>The tiebreaker, or null when the round did not tie.</summary>
        public RpsTiebreakerView Tiebreaker =>
            tiebreaker != null && tiebreaker.Exists ? tiebreaker : null;

        /// <summary>This team's Round 3 challenge wins.</summary>
        public int WinsOf(string teamId)
        {
            foreach (var entry in challengeWinList ?? Array.Empty<Round3TeamCount>())
            {
                if (entry.teamId == teamId) return entry.value;
            }
            return 0;
        }
    }
}

using System;

namespace BrainsAndBacchanal.Protocol
{
    /// <summary>
    /// C# mirror of the Sudden Death protocol (packages/protocol/src/sudden-death.ts).
    /// Phase 7D-B2.
    ///
    /// GAME_RULES_LOCKED.md §21, replaced by DECISION_LOG.md D-034: a
    /// face-off sequence (same mechanic as Round 4's own face-off, §19) —
    /// first team to win two face-offs IN A ROW wins the whole game. NOTHING
    /// HERE DECIDES ANYTHING — the Host display renders what the server says
    /// and sends intents, same discipline as Round4Messages.cs.
    ///
    /// ⚠ JsonUtility CANNOT REPRESENT A NULL CLASS FIELD — see
    /// Round4Messages.cs's own warning. Every nullable object below carries
    /// an `Exists` predicate keyed on a field the server never leaves empty.
    /// </summary>
    public static class SuddenDeathIntents
    {
        /// <summary>
        /// Host begins Sudden Death between exactly two named teams. Callable
        /// at ANY point the Host chooses — not only a genuine BB tie.
        /// Payload: {"teamIds": ["TEAM_A", "TEAM_B"]}.
        /// </summary>
        public const string HostBeginSuddenDeath = "HOST_BEGIN_SUDDEN_DEATH";

        /// <summary>
        /// Host reveals the next face-off's question and opens the buzzer.
        /// Deliberately NOT the same string as Round4Intents.HostStartFaceoff
        /// — see that constant's own note on why two intents must never
        /// share a wire string.
        /// </summary>
        public const string HostStartSuddenDeathFaceoff = "HOST_START_SUDDEN_DEATH_FACEOFF";

        /// <summary>PLAYER: a face-off participant buzzes in.</summary>
        public const string SubmitSuddenDeathBuzz = "SUBMIT_SUDDEN_DEATH_BUZZ";

        /// <summary>PLAYER: the buzzed-in team's answer.</summary>
        public const string SubmitSuddenDeathAnswer = "SUBMIT_SUDDEN_DEATH_ANSWER";

        /// <summary>Host rules the submitted (or timed-out) answer directly. Payload: {"teamId", "correct"}.</summary>
        public const string HostRuleSuddenDeathAnswer = "HOST_RULE_SUDDEN_DEATH_ANSWER";

        /// <summary>Host records that neither side answered validly — no penalty, a fresh face-off follows.</summary>
        public const string HostRecordSuddenDeathNoDecision = "HOST_RECORD_SUDDEN_DEATH_NO_DECISION";
    }

    public static class SuddenDeathEvents
    {
        public const string Started = "SUDDEN_DEATH_STARTED";
        public const string FaceoffRevealed = "SUDDEN_DEATH_FACEOFF_REVEALED";
        public const string Buzzed = "SUDDEN_DEATH_BUZZED";
        public const string FaceoffResolved = "SUDDEN_DEATH_FACEOFF_RESOLVED";
        public const string Completed = "SUDDEN_DEATH_COMPLETED";
    }

    public static class SuddenDeathFaceoffStatuses
    {
        public const string Reading = "reading";
        public const string Buzzed = "buzzed";
        public const string Decided = "decided";
    }

    /// <summary>One face-off, as a client sees it. Never carries the board's answers.</summary>
    [Serializable]
    public class SuddenDeathFaceoffView
    {
        public string status;
        public string prompt;
        public string[] participantTeamIds;
        public string buzzedTeamId;
        public long buzzedAt;
        public Round4TimerView answerTimer;
        public string winningTeamId;
        public bool noDecision;

        public bool Exists => !string.IsNullOrEmpty(status);
        public bool HasBuzzedTeam => !string.IsNullOrEmpty(buzzedTeamId);
        public bool HasWinner => !string.IsNullOrEmpty(winningTeamId);
    }

    /// <summary>One team's current consecutive-win streak.</summary>
    [Serializable]
    public class SuddenDeathStreak
    {
        public string teamId;
        public int consecutiveWins;
    }

    /// <summary>The whole Sudden Death state a client needs.</summary>
    [Serializable]
    public class SuddenDeathStateView
    {
        public int roundIndex;
        public string[] participantTeamIds;
        public SuddenDeathStreak[] streaks;
        public SuddenDeathFaceoffView current;
        public bool complete;
        public string winnerTeamId;

        public bool Exists => participantTeamIds != null && participantTeamIds.Length > 0;

        /// <summary>Null when no face-off is currently running.</summary>
        public SuddenDeathFaceoffView Current => current != null && current.Exists ? current : null;

        public bool HasWinner => !string.IsNullOrEmpty(winnerTeamId);
    }
}

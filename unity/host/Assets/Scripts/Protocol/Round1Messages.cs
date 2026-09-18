using System;

namespace BrainsAndBacchanal.Protocol
{
    /// <summary>
    /// C# mirror of the Round 1 protocol (packages/protocol/src/round1.ts).
    /// Phase 7C.
    ///
    /// The TypeScript side is the source of truth. NOTHING HERE DECIDES
    /// ANYTHING — the Host display renders what the server says and sends
    /// intents.
    ///
    /// ============ TWO TOTALS, ONE CORRECT ANSWER (§11) ============
    ///   BB              the game's score and currency, kept for the whole game
    ///   Round 1 points  a separate total that decides ONLY the Round 1 winner
    ///
    /// They mirror each other per question but are NOT the same number over a
    /// game, because BB also moves in the Market. Two fields here for exactly
    /// that reason.
    /// ==============================================================
    ///
    /// ============ THE REVEAL IS LAST ============
    /// `correctAnswer` is EMPTY until the server reveals the question. The Host
    /// display must never show it earlier — not because this code checks, but
    /// because the server does not send it.
    /// ============================================
    ///
    /// ⚠ JsonUtility CANNOT REPRESENT A NULL CLASS FIELD. A JSON null arrives
    /// as a default-filled object, never as C# null — Phase 7A learned this the
    /// hard way. Every nullable object below therefore carries an `Exists`
    /// predicate keyed on a field the server never leaves empty.
    ///
    /// ⚠ JsonUtility ALSO CANNOT DESERIALISE A DICTIONARY. `points` arrives as
    /// an object keyed by team id, which JsonUtility silently drops, so the
    /// server sends `pointList` alongside it — see Round1TeamCount.
    /// </summary>
    public static class Round1Intents
    {
        /// <summary>Nominate an answerer for one difficulty. PLAYER or HOST.</summary>
        public const string NominateAnswerer = "NOMINATE_ANSWERER";

        public const string StartRound1 = "HOST_START_ROUND1";
        public const string NextQuestion = "HOST_NEXT_ROUND1_QUESTION";

        /// <summary>The nominated player submits. PLAYER intent, never the Host.</summary>
        public const string SubmitAnswer = "SUBMIT_ROUND1_ANSWER";

        public const string CloseQuestion = "HOST_CLOSE_ROUND1_QUESTION";
        public const string RuleAnswer = "HOST_RULE_ROUND1_ANSWER";
        public const string OpenRetry = "HOST_OPEN_ROUND1_RETRY";
        public const string RevealAnswer = "HOST_REVEAL_ROUND1_ANSWER";
        public const string StartTiebreak = "HOST_START_ROUND1_TIEBREAK";

        /// <summary>DEVELOPMENT ONLY. Refused unless dev tools are enabled.</summary>
        public const string DevStartRound1 = "DEV_START_ROUND1";
    }

    public static class Round1Events
    {
        public const string RoundStarted = "ROUND1_STARTED";
        public const string NomineeSet = "ROUND1_NOMINEE_SET";
        public const string QuestionRevealed = "ROUND1_QUESTION_REVEALED";
        public const string AnswerSubmitted = "ROUND1_ANSWER_SUBMITTED";
        public const string QuestionClosed = "ROUND1_QUESTION_CLOSED";
        public const string AnswerGraded = "ROUND1_ANSWER_GRADED";
        public const string HostReviewRequired = "ROUND1_HOST_REVIEW_REQUIRED";
        public const string RetryOpened = "ROUND1_RETRY_OPENED";
        public const string AnswerRevealed = "ROUND1_ANSWER_REVEALED";
        public const string ScoresAwarded = "ROUND1_SCORES_AWARDED";
        public const string MacoViewed = "ROUND1_MACO_VIEWED";
        public const string TiebreakStarted = "ROUND1_TIEBREAK_STARTED";
        public const string TiebreakResolved = "ROUND1_TIEBREAK_RESOLVED";
        public const string WinnerConfirmed = "ROUND1_WINNER_CONFIRMED";
        public const string RoundCompleted = "ROUND1_COMPLETED";
    }

    public static class Round1Difficulties
    {
        public const string Easy = "EASY";
        public const string Medium = "MEDIUM";
        public const string Hard = "HARD";
    }

    /// <summary>Where one question is in its life. The reveal is LAST.</summary>
    public static class Round1QuestionPhases
    {
        public const string Pending = "pending";
        public const string Open = "open";
        public const string Grading = "grading";
        public const string HostReview = "host_review";
        public const string Retry = "retry";
        public const string Revealed = "revealed";
    }

    /// <summary>Where the ROUND is.</summary>
    public static class Round1Phases
    {
        public const string Nominating = "nominating";
        public const string Questions = "questions";
        public const string Tiebreak = "tiebreak";
        public const string Complete = "complete";
    }

    public static class Round1Verdicts
    {
        public const string Correct = "CORRECT";
        public const string Incorrect = "INCORRECT";
        public const string NeedsHostReview = "NEEDS_HOST_REVIEW";
    }

    /// <summary>One team's Round 1 points, as a serialisable pair.</summary>
    [Serializable]
    public class Round1TeamCount
    {
        public string teamId;
        public int value;
    }

    /// <summary>One team's three nominated answerers. §11. IDs, never names.</summary>
    [Serializable]
    public class Round1NomineeEntry
    {
        public string teamId;
        public string easyPlayerId;
        public string mediumPlayerId;
        public string hardPlayerId;
        public bool complete;

        public bool Exists => !string.IsNullOrEmpty(teamId);

        /// <summary>The nominee for one difficulty, or empty.</summary>
        public string For(string difficulty)
        {
            if (difficulty == Round1Difficulties.Easy) return easyPlayerId;
            if (difficulty == Round1Difficulties.Medium) return mediumPlayerId;
            if (difficulty == Round1Difficulties.Hard) return hardPlayerId;
            return string.Empty;
        }
    }

    /// <summary>
    /// One team's answer to one question, as the HOST sees it.
    ///
    /// The Host receives the submitted text because the Host grades it. A
    /// player's snapshot carries only their own team's.
    /// </summary>
    [Serializable]
    public class Round1TeamAnswerView
    {
        public string teamId;
        public bool submitted;

        /// <summary>The submitted text. Empty where the viewer is not entitled.</summary>
        public string answer;

        public string verdict;
        public string source;
        public bool hostOverrode;
        public bool usedRetry;

        /// <summary>BB awarded. Doubled where Double It! applied.</summary>
        public int awardedBb;

        /// <summary>Round 1 points awarded. Mirrors awardedBb; NOT the same total.</summary>
        public int awardedPoints;

        public bool doubled;
        public string assistedByTeamId;
        public string[] assistingTeamIds;

        public bool Exists => !string.IsNullOrEmpty(teamId);
        public bool HasAnswer => !string.IsNullOrEmpty(answer);
        public bool NeedsReview => verdict == Round1Verdicts.NeedsHostReview;
        public bool IsCorrect => verdict == Round1Verdicts.Correct;
        public bool IsGraded => !string.IsNullOrEmpty(verdict) && !NeedsReview;

        /// <summary>Whether this team is leaning on another's answer. §11.</summary>
        public bool HasAssist => !string.IsNullOrEmpty(assistedByTeamId);
    }

    /// <summary>The current question, as the display sees it.</summary>
    [Serializable]
    public class Round1QuestionView
    {
        public int questionNumber;
        public int totalQuestions;
        public string itemId;
        public string difficulty;
        public string prompt;

        /// <summary>BB for a correct answer, before any Double It!.</summary>
        public int value;

        public string phase;
        public int remainingMs;
        public long deadlineAt;

        /// <summary>
        /// ⚠ EMPTY IN EVERY PHASE BUT `revealed`. §11 — the answer is revealed
        /// after the question AND retry flow completes, so the server sends
        /// nothing here until then.
        /// </summary>
        public string correctAnswer;

        public Round1TeamAnswerView[] answers;
        public string challengeId;

        public bool Exists => !string.IsNullOrEmpty(itemId);
        public bool IsOpen => phase == Round1QuestionPhases.Open;
        public bool IsRevealed => phase == Round1QuestionPhases.Revealed;
        public bool IsRetry => phase == Round1QuestionPhases.Retry;
        public bool IsGrading =>
            phase == Round1QuestionPhases.Grading || phase == Round1QuestionPhases.HostReview;

        /// <summary>The answer, only once revealed.</summary>
        public bool HasCorrectAnswer => IsRevealed && !string.IsNullOrEmpty(correctAnswer);

        public Round1TeamAnswerView AnswerOf(string teamId)
        {
            foreach (var entry in answers ?? Array.Empty<Round1TeamAnswerView>())
            {
                if (entry.teamId == teamId) return entry;
            }
            return null;
        }
    }

    /// <summary>One sudden-death tiebreak question. D-032.</summary>
    [Serializable]
    public class Round1TiebreakAttemptView
    {
        public int attemptNumber;
        public string itemId;
        public string prompt;
        public string difficulty;
        public string phase;
        public int remainingMs;
        public string[] participatingTeamIds;
        public Round1TeamAnswerView[] answers;
        public string correctAnswer;
        public string[] eliminatedTeamIds;
        public string outcome;
        public string explanation;

        public bool Exists => !string.IsNullOrEmpty(itemId);
        public bool IsOpen => phase == Round1QuestionPhases.Open;
        public bool IsRevealed => phase == Round1QuestionPhases.Revealed;
    }

    /// <summary>
    /// The Round 1 tiebreak. D-032.
    ///
    /// ⚠ NOT §21's end-of-game Sudden Death. That is a different mode with
    /// different rules, a buzzer, and the whole game at stake. This only decides
    /// who won Round 1, and moves no BB and no points.
    /// </summary>
    [Serializable]
    public class Round1TiebreakView
    {
        public string[] tiedTeamIds;
        public string[] activeTeamIds;
        public Round1TiebreakAttemptView current;
        public Round1TiebreakAttemptView[] history;
        public bool complete;
        public string winningTeamId;

        public bool Exists => tiedTeamIds != null && tiedTeamIds.Length > 0;
        public Round1TiebreakAttemptView Current =>
            current != null && current.Exists ? current : null;
    }

    /// <summary>One team's Round 1 standing. Points, NOT BB.</summary>
    [Serializable]
    public class Round1StandingView
    {
        public string teamId;
        public int points;
        public int correctCount;

        public bool Exists => !string.IsNullOrEmpty(teamId);
    }

    /// <summary>A live Maco! viewing. Only ever in ONE player's snapshot.</summary>
    [Serializable]
    public class Round1MacoView
    {
        public string viewingPlayerId;
        public string viewingTeamId;
        public string targetTeamId;
        public string answer;
        public long expiresAt;
        public int remainingMs;

        public bool Exists => !string.IsNullOrEmpty(viewingPlayerId);
    }

    /// <summary>Round 1 as the Host display sees it.</summary>
    [Serializable]
    public class Round1StateView
    {
        public int roundIndex;
        public string phase;
        public Round1NomineeEntry[] nominees;
        public bool nominationsComplete;
        public string[] participatingTeamIds;

        public Round1QuestionView current;
        public int questionsAsked;
        public int totalQuestions;

        /// <summary>
        /// THE ROUND 1 POINT TOTAL, as a list. `points` is a keyed object the
        /// web reads and JsonUtility cannot, so this carries the same numbers.
        /// </summary>
        public Round1TeamCount[] pointList;

        public Round1StandingView[] standings;
        public Round1TiebreakView tiebreak;
        public string winningTeamId;

        // --- Scoped to the asking viewer. Empty on the HOST's snapshot. -----
        public string yourNomineeRole;
        public bool youMaySubmit;
        public Round1MacoView macoView;

        public bool Exists => totalQuestions > 0;
        public bool HasWinner => !string.IsNullOrEmpty(winningTeamId);
        public bool IsNominating => phase == Round1Phases.Nominating;
        public bool IsAskingQuestions => phase == Round1Phases.Questions;
        public bool IsTiebreak => phase == Round1Phases.Tiebreak;

        /// <summary>The question running now, or null when genuinely none.</summary>
        public Round1QuestionView Current => current != null && current.Exists ? current : null;

        /// <summary>The tiebreak, or null when Round 1 did not tie.</summary>
        public Round1TiebreakView Tiebreak =>
            tiebreak != null && tiebreak.Exists ? tiebreak : null;

        /// <summary>This team's Round 1 points. NOT its BB.</summary>
        public int PointsOf(string teamId)
        {
            foreach (var entry in pointList ?? Array.Empty<Round1TeamCount>())
            {
                if (entry.teamId == teamId) return entry.value;
            }
            return 0;
        }

        /// <summary>This team's nominees, or null.</summary>
        public Round1NomineeEntry NomineesOf(string teamId)
        {
            foreach (var entry in nominees ?? Array.Empty<Round1NomineeEntry>())
            {
                if (entry.teamId == teamId) return entry;
            }
            return null;
        }
    }
}

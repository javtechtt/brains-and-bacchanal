using System;

namespace BrainsAndBacchanal.Protocol
{
    /// <summary>
    /// C# mirror of the Round 4 protocol (packages/protocol/src/round4.ts).
    /// Phase 7D-B.
    ///
    /// The TypeScript side is the source of truth. NOTHING HERE DECIDES
    /// ANYTHING — the Host display renders what the server says and sends
    /// intents. Round 4 is Family Feud (GAME_RULES_LOCKED.md §19-§20).
    ///
    /// ============ THE BOARD IS SERVER-ONLY UNTIL REVEALED ============
    /// `Round4BoardAnswerView` never carries an unrevealed answer's text or
    /// value. Nothing here adds a field for it — the same content-safety
    /// discipline as Round3ItemView and Round1QuestionView.
    /// ===================================================================
    ///
    /// ============ THREE COUNTERS, KEPT SEPARATE ============
    ///   accumulatedPoints -> ONE survey's running pot. Reset every survey.
    ///   the steal wager    -> a separate stake (the existing generic wager).
    ///   BB                 -> the game's score, paid only on survey resolution.
    /// =========================================================
    ///
    /// ⚠ JsonUtility CANNOT REPRESENT A NULL CLASS FIELD. A JSON null arrives
    /// as a default-filled object, never as C# null. Every nullable object
    /// below carries an `Exists` predicate keyed on a field the server never
    /// leaves empty, and callers must use it rather than `!= null`.
    /// </summary>
    public static class Round4Intents
    {
        public const string HostBeginRound4 = "HOST_BEGIN_ROUND4";
        public const string HostStartFaceoff = "HOST_START_FACEOFF";

        /// <summary>PLAYER: a face-off participant buzzes in.</summary>
        public const string SubmitBuzz = "SUBMIT_BUZZ";

        /// <summary>PLAYER: the buzzed-in team's (or opponent's one-shot) face-off answer.</summary>
        public const string SubmitFaceoffAnswer = "SUBMIT_FACEOFF_ANSWER";

        public const string HostRuleFaceoffAnswer = "HOST_RULE_FACEOFF_ANSWER";

        /// <summary>Host starts the opponent's one-shot 3s clock — never automatic.</summary>
        public const string HostStartOpponentChanceTimer = "HOST_START_OPPONENT_CHANCE_TIMER";

        /// <summary>PLAYER: the face-off winner chooses PLAY or PASS.</summary>
        public const string ChoosePlayOrPass = "CHOOSE_PLAY_OR_PASS";

        /// <summary>
        /// Host starts the current board turn's 5s clock. Live play: answers
        /// are spoken and matched by the Host, so the Host also decides when
        /// each turn's clock actually starts — never automatic.
        /// </summary>
        public const string HostStartBoardTurnTimer = "HOST_START_BOARD_TURN_TIMER";

        /// <summary>Host cancels the running board turn timer without recording a strike.</summary>
        public const string HostCancelBoardTurnTimer = "HOST_CANCEL_BOARD_TURN_TIMER";

        /// <summary>PLAYER: the active board player's answer.</summary>
        public const string SubmitBoardAnswer = "SUBMIT_BOARD_ANSWER";

        public const string HostRuleBoardAnswer = "HOST_RULE_BOARD_ANSWER";
        public const string HostRecordStrike = "HOST_RECORD_STRIKE";

        /// <summary>Host directly sets the strike count — live jurisdiction, any time.</summary>
        public const string HostSetStrikes = "HOST_SET_STRIKES";

        /// <summary>Host starts the steal's 30s confer/answer clock — never automatic.</summary>
        public const string HostStartStealTimer = "HOST_START_STEAL_TIMER";

        /// <summary>PLAYER: the stealing team locks its wager (may be 0).</summary>
        public const string SubmitStealWager = "SUBMIT_STEAL_WAGER";

        /// <summary>PLAYER: the stealing team's one final answer.</summary>
        public const string SubmitStealAnswer = "SUBMIT_STEAL_ANSWER";

        public const string HostRuleStealAnswer = "HOST_RULE_STEAL_ANSWER";

        /// <summary>DEVELOPMENT ONLY — enter Round 4 without playing Rounds 1-3.</summary>
        public const string DevStartRound4 = "DEV_START_ROUND4";
    }

    public static class Round4Events
    {
        public const string RoundStarted = "ROUND4_STARTED";
        public const string SurveyRevealed = "ROUND4_SURVEY_REVEALED";
        public const string FaceoffBuzzed = "ROUND4_FACEOFF_BUZZED";
        public const string FaceoffAnswerSubmitted = "ROUND4_FACEOFF_ANSWER_SUBMITTED";
        public const string OpponentChanceTimerStarted = "ROUND4_OPPONENT_CHANCE_TIMER_STARTED";
        public const string FaceoffResolved = "ROUND4_FACEOFF_RESOLVED";
        public const string PlayOrPassChosen = "ROUND4_PLAY_OR_PASS_CHOSEN";
        public const string BoardTurnTimerStarted = "ROUND4_BOARD_TURN_TIMER_STARTED";
        public const string BoardAnswerRevealed = "ROUND4_BOARD_ANSWER_REVEALED";
        public const string StrikeRecorded = "ROUND4_STRIKE_RECORDED";
        public const string StealStarted = "ROUND4_STEAL_STARTED";
        public const string StealTimerStarted = "ROUND4_STEAL_TIMER_STARTED";
        public const string StealWagerLocked = "ROUND4_STEAL_WAGER_LOCKED";
        public const string StealResolved = "ROUND4_STEAL_RESOLVED";
        public const string SurveyResolved = "ROUND4_SURVEY_RESOLVED";
        public const string MatchupResolved = "ROUND4_MATCHUP_RESOLVED";
        public const string Completed = "ROUND4_COMPLETED";
    }

    public static class Round4MatchupStages
    {
        public const string First = "FIRST";
        public const string Final = "FINAL";
    }

    public static class Round4FaceoffStatuses
    {
        public const string Reading = "reading";
        public const string Buzzed = "buzzed";
        public const string OpponentChance = "opponent_chance";
        public const string Decided = "decided";
        public const string Complete = "complete";
    }

    public static class Round4PlayDecisions
    {
        public const string Play = "PLAY";
        public const string Pass = "PASS";
    }

    public static class Round4StealStatuses
    {
        public const string Conferring = "conferring";
        public const string AwaitingWager = "awaiting_wager";
        public const string AwaitingAnswer = "awaiting_answer";
        public const string Resolved = "resolved";
    }

    public static class Round4SurveyProgress
    {
        public const string NotStarted = "not_started";
        public const string Faceoff = "faceoff";
        public const string BoardPlay = "board_play";
        public const string Steal = "steal";
        public const string Resolved = "resolved";
    }

    /// <summary>A team's frozen entering standing. Captured once at Round 4 entry. §20.</summary>
    [Serializable]
    public class Round4EnteringStanding
    {
        public string teamId;
        public string rank;
        public int enteringBb;
    }

    /// <summary>Whether a team may still earn Family Feud BB. §20 step 6.</summary>
    [Serializable]
    public class Round4ScoringGate
    {
        public string teamId;
        public bool gated;
        public string gatedAtStage;
    }

    /// <summary>One board answer as a client may see it — before or after reveal.</summary>
    [Serializable]
    public class Round4BoardAnswerView
    {
        public string answerId;
        public int rank;
        public bool revealed;

        /// <summary>
        /// Null until revealed, EXCEPT on the Host's own snapshot (Phase
        /// "live answers" / 7D-B2) — the Host runs Round 4 live and must see
        /// the board to match a spoken answer. Never sent this way to any
        /// player; the room only ever sets `forHost:true` on the Host's own
        /// per-connection snapshot request, never on a broadcast event.
        /// </summary>
        public string text;

        public int value;

        /// <summary>Whether `value`/`text` are meaningful. JsonUtility gives 0/"" for a real null.</summary>
        public bool hasValue;

        public bool steupsRemoved;
        public string steupsRemovedForTeamId;
    }

    /// <summary>The board as a client sees it: current reveal state, never the hidden rest.</summary>
    [Serializable]
    public class Round4BoardView
    {
        public string surveyId;
        public string prompt;
        public int questionNumber;
        public int answerCount;
        public Round4BoardAnswerView[] answers;
        public bool doubled;
        public int accumulatedPoints;
        public int strikes;
        public int maxStrikes;
    }

    /// <summary>
    /// An authoritative Round 4 deadline, as a client sees it. Mirrors the
    /// TS `Round4TimerView` (round4.ts §7D-B1) — server-computed
    /// `remainingMs`, display only. `Exists` keys on `durationMs > 0` since a
    /// real timer's duration is always positive (3000/5000/30000ms).
    /// </summary>
    [Serializable]
    public class Round4TimerView
    {
        public int durationMs;
        public int remainingMs;
        public bool paused;
        public bool expired;
        public long startedAt;

        public bool Exists => durationMs > 0;
    }

    /// <summary>The face-off, as a client sees it. §19.</summary>
    [Serializable]
    public class Round4FaceoffView
    {
        public string status;
        public string[] participantTeamIds;
        public string buzzedTeamId;
        public long buzzedAt;
        public string opponentTeamId;
        public string winningTeamId;
        public string playDecision;
        public Round4TimerView answerTimer;

        public bool Exists => !string.IsNullOrEmpty(status);
        public bool HasBuzzedTeam => !string.IsNullOrEmpty(buzzedTeamId);
        public bool HasOpponentTeam => !string.IsNullOrEmpty(opponentTeamId);
        public bool HasWinner => !string.IsNullOrEmpty(winningTeamId);
        public bool HasDecision => !string.IsNullOrEmpty(playDecision);
    }

    /// <summary>Board play, as a client sees it. Null outside normal board play.</summary>
    [Serializable]
    public class Round4BoardPlayView
    {
        public string controllingTeamId;
        public string[] playerOrder;
        public int currentPlayerIndex;
        public int strikes;
        public Round4TimerView turnTimer;

        public bool Exists => !string.IsNullOrEmpty(controllingTeamId);
    }

    /// <summary>The steal, as a client sees it. Null outside a steal. §19.</summary>
    [Serializable]
    public class Round4StealView
    {
        public string status;
        public string stealingTeamId;
        public string defendingTeamId;
        public string wagerId;
        public int wagerAmount;
        public bool hasWagerAmount;
        public int maxWager;
        public bool hasMaxWager;
        public bool resolved;
        public bool won;
        public bool hasWon;
        public Round4TimerView conferTimer;

        public bool Exists => !string.IsNullOrEmpty(status);
    }

    /// <summary>One survey as a client sees it, folding in the board, face-off and steal.</summary>
    [Serializable]
    public class Round4SurveyView
    {
        public string progress;
        public Round4BoardView board;
        public Round4FaceoffView faceoff;
        public Round4BoardPlayView boardPlay;
        public Round4StealView steal;
        public string resolvedWinnerTeamId;
        public int awardedBb;
        public bool hasAwardedBb;
        public long resolvedAt;

        public bool Exists => board != null && !string.IsNullOrEmpty(board.surveyId);

        /// <summary>Null when no face-off is running (outside the faceoff phase).</summary>
        public Round4FaceoffView Faceoff => faceoff != null && faceoff.Exists ? faceoff : null;

        /// <summary>Null when board play is not running.</summary>
        public Round4BoardPlayView BoardPlay => boardPlay != null && boardPlay.Exists ? boardPlay : null;

        /// <summary>Null outside a steal.</summary>
        public Round4StealView Steal => steal != null && steal.Exists ? steal : null;
    }

    /// <summary>The whole Round 4 state a client needs. §19-§20.</summary>
    [Serializable]
    public class Round4StateView
    {
        public int roundIndex;
        public Round4EnteringStanding[] enteringStandings;
        public string matchupStage;
        public string[] matchupTeamIds;

        /// <summary>The team sitting out the current matchup, in a 3-team game. Empty in a 2-team game.</summary>
        public string inactiveTeamId;

        public Round4ScoringGate[] scoringGates;
        public int surveysPlayedInMatchup;
        public Round4SurveyView current;
        public bool complete;
        public string matchupWinnerTeamId;
        public string round4WinnerTeamId;

        public bool Exists => roundIndex == 4;
        public bool HasInactiveTeam => !string.IsNullOrEmpty(inactiveTeamId);
        public bool HasMatchupWinner => !string.IsNullOrEmpty(matchupWinnerTeamId);
        public bool HasRound4Winner => !string.IsNullOrEmpty(round4WinnerTeamId);

        /// <summary>The survey running now, or null when genuinely none.</summary>
        public Round4SurveyView Current => current != null && current.Exists ? current : null;

        /// <summary>Whether this team is gated from further Family Feud BB. §20 step 6.</summary>
        public bool IsGated(string teamId)
        {
            foreach (var gate in scoringGates ?? Array.Empty<Round4ScoringGate>())
            {
                if (gate.teamId == teamId) return gate.gated;
            }
            return false;
        }
    }
}

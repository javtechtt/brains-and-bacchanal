using System;
using UnityEngine;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal
{
    /// <summary>
    /// ==================== ROUND 1 ====================
    ///
    /// Phase 7C spec §14. The Host presentation for Round 1 — nominations, the
    /// fifteen questions, grading and Host review, the reveal, and the
    /// sudden-death trivia tiebreak.
    ///
    /// Functional, not finished — Phase 8 does the theatre.
    ///
    /// ============ THE HOST SEES THE ANSWERS. THE PLAYERS DO NOT. ============
    /// Round 1 is machine-graded free text, so the Host must read what each team
    /// wrote in order to overrule a ruling (§4E). That is why the Host snapshot
    /// carries the submitted answers and a player's does not.
    ///
    /// The CANONICAL answer is different: the server withholds it from the Host
    /// too until the question is revealed (§11). There is no button here to
    /// peek, because there is no field to read.
    /// ========================================================================
    ///
    /// ============ THE HOST NEVER TYPES CONTENT ============
    /// §13 — the game supplies the questions. NEXT QUESTION asks the server for
    /// the next one; there is no text field here, deliberately.
    /// ======================================================
    ///
    /// It computes nothing. The verdicts, the BB, the points and the tiebreak
    /// outcome all arrive from the server; every button sends an intent.
    /// </summary>
    public partial class HostLobby
    {
        private Vector2 _round1Scroll;

        private void DrawRound1Panel(LobbySnapshot snapshot, HostGameSnapshot game)
        {
            GUILayout.BeginVertical(GUILayout.Width(380));

            GUILayout.Label("ROUND 1", HeaderStyle);

            if (game == null || !game.GameRunning || game.game == null)
            {
                GUILayout.Label("No game running.");
                GUILayout.EndVertical();
                return;
            }

            var session = game.game;
            var round1 = session.round1;

            // `round1 != null` is NOT a null check: JsonUtility turns a JSON
            // null into an empty object, so every other round arrives as a
            // non-null Round1StateView with no questions.
            if (round1 == null || !round1.Exists)
            {
                DrawRound1Entry(session, game);
                GUILayout.EndVertical();
                return;
            }

            _round1Scroll = GUILayout.BeginScrollView(_round1Scroll, GUILayout.Height(560));

            DrawRound1Standings(round1, game);
            GUILayout.Space(8);

            if (round1.IsNominating)
            {
                DrawNominations(round1, game);
            }
            else if (round1.IsTiebreak)
            {
                DrawTiebreak(round1, game, session);
            }
            else
            {
                DrawRound1Question(round1, game, session);
            }

            if (round1.HasWinner)
            {
                GUILayout.Space(8);
                GUILayout.Label($"ROUND 1 WINNER: {TeamLabel(game, round1.winningTeamId)}");
            }

            GUILayout.EndScrollView();
            GUILayout.EndVertical();
        }

        private void DrawRound1Entry(GameSessionView session, HostGameSnapshot game)
        {
            GUILayout.Label("Round 1 has not started.");
            GUILayout.Label($"Currently: {session.phase}, round {session.roundIndex}.");
            GUILayout.Space(6);

            // Round 1 normally starts ITSELF when the game starts — it is the
            // first round (spec §18). This is only for a room that somehow
            // reached a running game without it.
            if (!game.devToolsEnabled)
            {
                GUILayout.Label("Round 1 begins with the game. If it has");
                GUILayout.Label("not, start the game first.");
                return;
            }

            GUI.enabled = !_busy && !session.paused;
            if (GUILayout.Button("[DEV] START ROUND 1", GUILayout.Height(44)))
            {
                _ = SubmitGameIntentAsync(Round1Intents.DevStartRound1, "{}");
            }
            GUI.enabled = true;
        }

        /// <summary>
        /// Round 1 POINTS. Labelled so, never BB.
        ///
        /// §11 keeps them separate and so does this display: a Host who reads
        /// this as BB will not understand why the round winner is not the BB
        /// leader, which is a real and legal outcome.
        /// </summary>
        private void DrawRound1Standings(Round1StateView round1, HostGameSnapshot game)
        {
            GUILayout.Label("ROUND 1 POINTS (not BB)");
            foreach (var standing in round1.standings ?? Array.Empty<Round1StandingView>())
            {
                GUILayout.Label(
                    $"  {TeamLabel(game, standing.teamId)}: {standing.points}" +
                    $"   ({standing.correctCount} right)");
            }

            GUILayout.Label(
                $"Question {round1.questionsAsked} of {round1.totalQuestions}");
        }

        // -------------------------------------------------------------------
        // Nomination
        // -------------------------------------------------------------------

        /// <summary>
        /// Who answers what. §11, spec §14.
        ///
        /// The Host must be able to SEE every team's three nominees and whether
        /// the set is complete, because Round 1 will not start until it is.
        /// </summary>
        private void DrawNominations(Round1StateView round1, HostGameSnapshot game)
        {
            GUILayout.Label("NOMINEES");

            foreach (var entry in round1.nominees ?? Array.Empty<Round1NomineeEntry>())
            {
                var previous = GUI.color;
                GUI.color = entry.complete ? Color.green : Color.yellow;
                GUILayout.Label($"{TeamLabel(game, entry.teamId)}  {(entry.complete ? "ready" : "incomplete")}");
                GUI.color = previous;

                GUILayout.Label($"   Easy:   {PlayerLabel(game, entry.easyPlayerId)}");
                GUILayout.Label($"   Medium: {PlayerLabel(game, entry.mediumPlayerId)}");
                GUILayout.Label($"   Hard:   {PlayerLabel(game, entry.hardPlayerId)}");
            }

            GUILayout.Space(8);

            GUI.enabled = !_busy && round1.nominationsComplete;
            if (GUILayout.Button("START ROUND 1", GUILayout.Height(44)))
            {
                _ = SubmitGameIntentAsync(Round1Intents.StartRound1, "{}");
            }
            GUI.enabled = true;

            if (!round1.nominationsComplete)
            {
                GUILayout.Label("Every team needs all three before");
                GUILayout.Label("Round 1 can start.");
            }
        }

        // -------------------------------------------------------------------
        // A question
        // -------------------------------------------------------------------

        private void DrawRound1Question(
            Round1StateView round1,
            HostGameSnapshot game,
            GameSessionView session)
        {
            var question = round1.Current;

            if (question == null)
            {
                GUILayout.Label("No question on screen.");
                DrawNextQuestionButton(round1, session);
                return;
            }

            GUILayout.Label(
                $"Q{question.questionNumber}/{question.totalQuestions}   " +
                $"{question.difficulty}   {question.value} BB");

            GUILayout.Label(question.prompt, WrapStyle);

            if (question.IsOpen)
            {
                GUILayout.Label($"{Mathf.CeilToInt(question.remainingMs / 1000f)}s left");
            }

            GUILayout.Space(6);
            DrawAnswers(question, round1, game);

            GUILayout.Space(8);

            // ⚠ The canonical answer appears only once the server reveals it.
            if (question.HasCorrectAnswer)
            {
                GUILayout.Label("THE ANSWER WAS:");
                GUILayout.Label(question.correctAnswer, WrapStyle);
                GUILayout.Space(6);
                DrawNextQuestionButton(round1, session);
                return;
            }

            DrawQuestionControls(question, round1, session);
        }

        /// <summary>
        /// Each team's submitted answer and its ruling.
        ///
        /// This is the Host's grading screen: the text they wrote, what the
        /// machine decided, and two buttons to overrule it (§4E).
        /// </summary>
        private void DrawAnswers(
            Round1QuestionView question,
            Round1StateView round1,
            HostGameSnapshot game)
        {
            foreach (var answer in question.answers ?? Array.Empty<Round1TeamAnswerView>())
            {
                GUILayout.BeginVertical(GUI.skin.box);

                var label = TeamLabel(game, answer.teamId);
                if (answer.HasAssist)
                {
                    // ALLYUH HELP ME! — this team is leaning on another's
                    // answer, and is scored on THAT answer's outcome (§11).
                    label += $"  (using {TeamLabel(game, answer.assistedByTeamId)})";
                }
                GUILayout.Label(label);

                if (!answer.submitted)
                {
                    GUILayout.Label("   no answer");
                }
                else
                {
                    GUILayout.Label($"   \"{answer.answer}\"", WrapStyle);
                }

                if (!string.IsNullOrEmpty(answer.verdict))
                {
                    var previous = GUI.color;
                    GUI.color = answer.IsCorrect
                        ? Color.green
                        : answer.NeedsReview
                            ? Color.yellow
                            : Color.grey;
                    var overrode = answer.hostOverrode ? "  (Host)" : "";
                    GUILayout.Label($"   {answer.verdict}  [{answer.source}]{overrode}");
                    GUI.color = previous;
                }
                else if (answer.submitted)
                {
                    GUILayout.Label("   grading…");
                }

                if (question.IsRevealed && answer.awardedBb > 0)
                {
                    var doubled = answer.doubled ? "  (Double It!)" : "";
                    GUILayout.Label(
                        $"   +{answer.awardedBb} BB  +{answer.awardedPoints} pts{doubled}");
                }

                // The Host rules on any submitted answer, at any time before the
                // reveal. Not only the uncertain ones — §4E lets the Host
                // correct an automated ruling too.
                if (answer.submitted && !question.IsRevealed)
                {
                    GUILayout.BeginHorizontal();
                    GUI.enabled = !_busy;
                    if (GUILayout.Button("CORRECT"))
                    {
                        _ = SubmitGameIntentAsync(
                            Round1Intents.RuleAnswer,
                            "{\"teamId\":\"" + answer.teamId + "\",\"verdict\":\"CORRECT\"}");
                    }
                    if (GUILayout.Button("WRONG"))
                    {
                        _ = SubmitGameIntentAsync(
                            Round1Intents.RuleAnswer,
                            "{\"teamId\":\"" + answer.teamId + "\",\"verdict\":\"INCORRECT\"}");
                    }
                    GUI.enabled = true;
                    GUILayout.EndHorizontal();

                    // FORGIVE MEH! — only after a FINAL wrong ruling (§11).
                    if (answer.verdict == Round1Verdicts.Incorrect && !answer.usedRetry)
                    {
                        GUI.enabled = !_busy;
                        if (GUILayout.Button("FORGIVE MEH! — 10s retry"))
                        {
                            _ = SubmitGameIntentAsync(
                                Round1Intents.OpenRetry,
                                "{\"teamId\":\"" + answer.teamId + "\"}");
                        }
                        GUI.enabled = true;
                    }
                }

                GUILayout.EndVertical();
            }
        }

        private void DrawQuestionControls(
            Round1QuestionView question,
            Round1StateView round1,
            GameSessionView session)
        {
            GUI.enabled = !_busy && !session.paused;

            if (question.IsOpen)
            {
                if (GUILayout.Button("CLOSE & GRADE", GUILayout.Height(40)))
                {
                    _ = SubmitGameIntentAsync(Round1Intents.CloseQuestion, "{}");
                }
                GUILayout.Label("Or let the 60 seconds run out.");
            }
            else
            {
                // The reveal is LAST. The server refuses it while anything is
                // ungraded or waiting on the Host, so a premature press is
                // simply rejected rather than leaking the answer.
                if (GUILayout.Button("REVEAL THE ANSWER", GUILayout.Height(44)))
                {
                    _ = SubmitGameIntentAsync(Round1Intents.RevealAnswer, "{}");
                }
                GUILayout.Label("Refused until every answer is ruled.");
            }

            GUI.enabled = true;
        }

        private void DrawNextQuestionButton(Round1StateView round1, GameSessionView session)
        {
            if (round1.questionsAsked >= round1.totalQuestions)
            {
                GUILayout.Label("All 15 questions are done.");
                return;
            }

            GUI.enabled = !_busy && !session.paused;
            if (GUILayout.Button("NEXT QUESTION", GUILayout.Height(44)))
            {
                _ = SubmitGameIntentAsync(Round1Intents.NextQuestion, "{}");
            }
            GUI.enabled = true;
        }

        // -------------------------------------------------------------------
        // Tiebreak
        // -------------------------------------------------------------------

        /// <summary>
        /// The sudden-death trivia tiebreak. D-032, spec §12.
        ///
        /// ⚠ NOT §21's end-of-game Sudden Death. Labelled here so a Host cannot
        /// mistake one for the other: this moves no BB, adds no points, and only
        /// decides who won Round 1.
        /// </summary>
        private void DrawTiebreak(
            Round1StateView round1,
            HostGameSnapshot game,
            GameSessionView session)
        {
            var tiebreak = round1.Tiebreak;
            if (tiebreak == null) return;

            GUILayout.Label("ROUND 1 TIEBREAK — sudden-death trivia");
            GUILayout.Label("No BB. No points. Round 1 only.");
            GUILayout.Space(4);

            GUILayout.Label($"Tied: {string.Join(", ", tiebreak.tiedTeamIds ?? Array.Empty<string>())}");
            GUILayout.Label($"Still in: {string.Join(", ", tiebreak.activeTeamIds ?? Array.Empty<string>())}");

            if (tiebreak.complete)
            {
                GUILayout.Label($"WINNER: {TeamLabel(game, tiebreak.winningTeamId)}");
                return;
            }

            var attempt = tiebreak.Current;
            GUILayout.Space(6);

            if (attempt == null || attempt.IsRevealed)
            {
                if (attempt != null && !string.IsNullOrEmpty(attempt.explanation))
                {
                    GUILayout.Label(attempt.explanation, WrapStyle);
                    GUILayout.Space(4);
                }

                GUI.enabled = !_busy && !session.paused;
                if (GUILayout.Button("NEXT TIEBREAK QUESTION", GUILayout.Height(44)))
                {
                    _ = SubmitGameIntentAsync(Round1Intents.StartTiebreak, "{}");
                }
                GUI.enabled = true;
                return;
            }

            GUILayout.Label($"Tiebreak {attempt.attemptNumber}   {attempt.difficulty}");
            GUILayout.Label(attempt.prompt, WrapStyle);

            if (attempt.IsOpen)
            {
                GUILayout.Label($"{Mathf.CeilToInt(attempt.remainingMs / 1000f)}s left");
            }

            GUILayout.Space(6);
            foreach (var answer in attempt.answers ?? Array.Empty<Round1TeamAnswerView>())
            {
                GUILayout.BeginVertical(GUI.skin.box);
                GUILayout.Label(TeamLabel(game, answer.teamId));
                GUILayout.Label(answer.submitted ? $"   \"{answer.answer}\"" : "   no answer", WrapStyle);

                if (!string.IsNullOrEmpty(answer.verdict))
                {
                    GUILayout.Label($"   {answer.verdict}");
                }

                if (answer.submitted && !attempt.IsRevealed)
                {
                    GUILayout.BeginHorizontal();
                    GUI.enabled = !_busy;
                    if (GUILayout.Button("CORRECT"))
                    {
                        _ = SubmitGameIntentAsync(
                            Round1Intents.RuleAnswer,
                            "{\"teamId\":\"" + answer.teamId + "\",\"verdict\":\"CORRECT\"}");
                    }
                    if (GUILayout.Button("WRONG"))
                    {
                        _ = SubmitGameIntentAsync(
                            Round1Intents.RuleAnswer,
                            "{\"teamId\":\"" + answer.teamId + "\",\"verdict\":\"INCORRECT\"}");
                    }
                    GUI.enabled = true;
                    GUILayout.EndHorizontal();
                }
                GUILayout.EndVertical();
            }

            GUILayout.Space(6);
            GUI.enabled = !_busy && !session.paused;
            if (GUILayout.Button("RESOLVE THIS TIEBREAK", GUILayout.Height(40)))
            {
                _ = SubmitGameIntentAsync(Round1Intents.RevealAnswer, "{}");
            }
            GUI.enabled = true;
        }

        /// <summary>A player's display name, or their id if unknown.</summary>
        private string PlayerLabel(HostGameSnapshot game, string playerId)
        {
            if (string.IsNullOrEmpty(playerId)) return "— nobody —";
            foreach (var player in game?.players ?? Array.Empty<LobbyPlayer>())
            {
                if (player.playerId == playerId) return player.displayName;
            }
            return playerId;
        }
    }
}

using System;
using System.Collections.Generic;
using UnityEngine;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal
{
    /// <summary>
    /// ==================== ROUND 4 — FAMILY FEUD ====================
    ///
    /// Phase 7D-B. GAME_RULES_LOCKED.md §19 (Family Feud) and §20
    /// (Three-Team Round 4).
    ///
    /// Functional, not finished — Phase 8 does the theatre.
    ///
    /// It computes nothing. Every value shown (the board, the pot, strikes,
    /// the buzzer winner, the steal wager) arrives from the server; every
    /// button here sends the EXACT intent the room already accepts
    /// (packages/game-rules/src/room.ts's Round4 handlers) and redraws from
    /// whatever comes back. There is no local timer expiry, no answer
    /// matching and no face-off/steal winner decided here — the Host's own
    /// judgement calls (HOST_RULE_FACEOFF_ANSWER / HOST_RULE_BOARD_ANSWER /
    /// HOST_RULE_STEAL_ANSWER) are still just intents, sent after the Host
    /// reads what the server already knows.
    ///
    /// CONTENT SAFETY: the unrevealed board never reaches this panel —
    /// `Round4BoardAnswerView.text`/`value` are empty/0 until `revealed` is
    /// true, and this file has no code path that could show them earlier
    /// because the data itself never arrives.
    ///
    /// Sudden Death (§21 / D-034) is its OWN panel — see HostSuddenDeathPanel.cs.
    /// </summary>
    public partial class HostLobby
    {
        private Vector2 _round4Scroll;

        private void DrawRound4Panel(LobbySnapshot snapshot, HostGameSnapshot game)
        {
            GUILayout.BeginVertical(GUILayout.Width(420));

            GUILayout.Label("ROUND 4 — FAMILY FEUD", HeaderStyle);

            if (game == null || !game.GameRunning || game.game == null)
            {
                GUILayout.Label("No game running.");
                GUILayout.EndVertical();
                return;
            }

            var session = game.game;
            var round4 = session.round4;

            // `round4 != null` is NOT a null check: JsonUtility turns a JSON
            // null into an empty object, so every other round arrives as a
            // non-null Round4StateView with roundIndex 0.
            if (round4 == null || !round4.Exists)
            {
                DrawRound4Entry(session, game);
                GUILayout.EndVertical();
                return;
            }

            _round4Scroll = GUILayout.BeginScrollView(_round4Scroll, GUILayout.Height(620));

            DrawMatchupHeader(round4, game);
            GUILayout.Space(6);

            if (round4.complete)
            {
                DrawRound4Complete(round4, game);
            }
            else
            {
                var current = round4.Current;
                if (current == null)
                {
                    DrawStartFaceoffButton(session, game);
                }
                else
                {
                    DrawBoard(current, game);
                    GUILayout.Space(8);

                    var faceoff = current.Faceoff;
                    var boardPlay = current.BoardPlay;
                    var steal = current.Steal;

                    if (steal != null) DrawSteal(steal, current, game, session);
                    else if (boardPlay != null) DrawBoardPlay(boardPlay, current, game, session);
                    else if (faceoff != null) DrawFaceoff(faceoff, game, session);
                    else
                    {
                        // `current.progress == "resolved"` and nothing is
                        // running — the survey cleared (or a steal settled
                        // it) and Round 4 is simply waiting on the Host to
                        // reveal the next one. Made explicit so this does not
                        // read as "nothing happened."
                        var previous = GUI.color;
                        GUI.color = Color.green;
                        GUILayout.Label("SURVEY RESOLVED", HeaderStyle);
                        GUI.color = previous;
                        if (!string.IsNullOrEmpty(current.resolvedWinnerTeamId))
                        {
                            GUILayout.Label($"Winner: {TeamLabel(game, current.resolvedWinnerTeamId)}"
                                + (current.hasAwardedBb ? $"  (+{current.awardedBb} BB)" : ""));
                        }
                        DrawStartFaceoffButton(session, game);
                    }
                }
            }

            GUILayout.EndScrollView();
            GUILayout.EndVertical();
        }

        private void DrawRound4Entry(GameSessionView session, HostGameSnapshot game)
        {
            GUILayout.Label("Round 4 has not started.");

            if (!game.devToolsEnabled)
            {
                GUILayout.Label("Development tools are disabled, so");
                GUILayout.Label("there is no way in from here yet.");
                return;
            }

            GUILayout.Label($"Currently: {session.phase}, round {session.roundIndex}.");
            GUILayout.Space(6);

            GUILayout.Label("Strikes before a steal (default 3, set once for all of Round 4):");
            GUILayout.BeginHorizontal();
            if (GUILayout.RepeatButton("−", GUILayout.Width(28), GUILayout.Height(26)))
            {
                _round4MaxStrikesInput = Mathf.Max(1, _round4MaxStrikesInput - 1);
            }
            GUILayout.Label(_round4MaxStrikesInput.ToString(), GUILayout.Width(30));
            if (GUILayout.RepeatButton("+", GUILayout.Width(28), GUILayout.Height(26)))
            {
                _round4MaxStrikesInput += 1;
            }
            GUILayout.EndHorizontal();
            GUILayout.Space(4);

            GUI.enabled = !_busy && !session.paused;
            if (GUILayout.Button("[DEV] START ROUND 4", GUILayout.Height(44)))
            {
                _ = SubmitGameIntentAsync(
                    Round4Intents.DevStartRound4,
                    $"{{\"maxStrikes\":{_round4MaxStrikesInput}}}");
            }
            GUI.enabled = true;

            GUILayout.Space(4);
            GUILayout.Label("Development only. Walks the real phases");
            GUILayout.Label("to Round 4. Not a production rule.");
        }

        /// <summary>Strike ceiling chosen on the entry screen, before Round 4 starts.</summary>
        private int _round4MaxStrikesInput = 3;

        /// <summary>
        /// The 3-team matchup structure, made legible. §20.
        ///
        /// Entering standings are FROZEN — never recomputed from live BB — so
        /// this shows them as captured, not as a live leaderboard.
        /// </summary>
        private void DrawMatchupHeader(Round4StateView round4, HostGameSnapshot game)
        {
            GUILayout.Label($"Matchup: {round4.matchupStage}", HeaderStyle);

            GUILayout.Label("ENTERING STANDINGS (frozen at Round 4 start)");
            foreach (var standing in round4.enteringStandings ?? Array.Empty<Round4EnteringStanding>())
            {
                var active = Array.IndexOf(round4.matchupTeamIds ?? Array.Empty<string>(), standing.teamId) >= 0;
                var inactive = round4.HasInactiveTeam && round4.inactiveTeamId == standing.teamId;
                var gated = round4.IsGated(standing.teamId);

                var previous = GUI.color;
                if (inactive) GUI.color = Color.grey;
                else if (active) GUI.color = Color.cyan;
                GUILayout.Label(
                    $"  {standing.rank}: {TeamLabel(game, standing.teamId)}" +
                    $" (entered with {standing.enteringBb} BB)" +
                    (inactive ? "  [WAITING — not in this matchup]" : "") +
                    (gated ? "  [no further Family Feud BB]" : ""));
                GUI.color = previous;
            }

            if (round4.HasInactiveTeam)
            {
                GUILayout.Label($"Sitting out this matchup: {TeamLabel(game, round4.inactiveTeamId)}");
            }

            GUILayout.Label(
                $"Current matchup: {string.Join(" vs ", Array.ConvertAll(round4.matchupTeamIds ?? Array.Empty<string>(), id => TeamLabel(game, id)))}");
            GUILayout.Label($"Surveys played this matchup: {round4.surveysPlayedInMatchup}");
        }

        private void DrawStartFaceoffButton(GameSessionView session, HostGameSnapshot game)
        {
            GUILayout.Space(6);
            GUI.enabled = !_busy && !session.paused;
            if (GUILayout.Button("HOST: START NEXT FACE-OFF", GUILayout.Height(40)))
            {
                _ = SubmitGameIntentAsync(Round4Intents.HostStartFaceoff, "{}");
            }
            GUI.enabled = true;
            GUILayout.Label("Reveals the next survey from the content");
            GUILayout.Label("source and opens the buzzer while you read.");
        }

        /// <summary>The survey board: prompt, revealed answers, blanks, pot, strikes. §19.</summary>
        private void DrawBoard(Round4SurveyView current, HostGameSnapshot game)
        {
            var board = current.board;
            GUILayout.Label(board.prompt, HeaderStyle);
            if (board.doubled)
            {
                var previous = GUI.color;
                GUI.color = Color.yellow;
                GUILayout.Label("DOUBLED (Q4/Q5)");
                GUI.color = previous;
            }

            foreach (var answer in board.answers ?? Array.Empty<Round4BoardAnswerView>())
            {
                if (answer.revealed)
                {
                    var removedNote = answer.steupsRemoved
                        ? $"  (Steups! removed for {TeamLabel(game, answer.steupsRemovedForTeamId)})"
                        : "";
                    GUILayout.Label($"  #{answer.rank}  {answer.text} — {answer.value}{removedNote}");
                }
                else
                {
                    GUILayout.Label($"  #{answer.rank}  ______________");
                }
            }

            GUILayout.Space(4);
            GUILayout.Label($"POT: {board.accumulatedPoints}    STRIKES: {board.strikes} / {board.maxStrikes}");
        }

        /// <summary>Face-off: participants, buzzer state, timer, ruling controls. §19.</summary>
        private void DrawFaceoff(Round4FaceoffView faceoff, HostGameSnapshot game, GameSessionView session)
        {
            GUILayout.Label("FACE-OFF", HeaderStyle);
            var participants = faceoff.participantTeamIds ?? Array.Empty<string>();
            GUILayout.Label(
                $"{string.Join("  vs  ", Array.ConvertAll(participants, id => TeamLabel(game, id)))}");
            GUILayout.Label($"Status: {faceoff.status}");

            if (faceoff.HasBuzzedTeam)
            {
                GUILayout.Label($"Buzzed first: {TeamLabel(game, faceoff.buzzedTeamId)}");
            }
            if (faceoff.HasOpponentTeam)
            {
                GUILayout.Label($"Opponent's one chance: {TeamLabel(game, faceoff.opponentTeamId)}");
            }

            // Phase 7D-B1: the authoritative 3s answer window, server-computed
            // on every snapshot (Round4TimerView) — the same shape/discipline
            // as the generic session.challenge.timer this Host panel already
            // reads elsewhere. Null exactly when nobody currently holds the
            // floor (Round4FaceoffView.answerTimer's own null case).
            var faceoffTimerRunning = faceoff.answerTimer != null && faceoff.answerTimer.Exists
                && faceoff.answerTimer.remainingMs > 0 && !faceoff.answerTimer.expired;
            if (faceoffTimerRunning)
            {
                var t = faceoff.answerTimer;
                GUILayout.Label($"Answer window: {Mathf.CeilToInt(t.remainingMs / 1000f)}s{(t.paused ? " (paused)" : "")}");
            }
            else if (faceoff.status == Round4FaceoffStatuses.OpponentChance)
            {
                // Phase "live answers": the FIRST buzz's 3s clock still starts
                // automatically (buzzing in starts your own clock) — only the
                // opponent's one-shot chance needs the Host to start it,
                // since often it is a formality after a clearly weak #1 miss.
                GUI.enabled = !_busy && !session.paused;
                if (GUILayout.Button("START OPPONENT'S 3s TIMER", GUILayout.Height(32)))
                {
                    _ = SubmitGameIntentAsync(Round4Intents.HostStartOpponentChanceTimer, "{}");
                }
                GUI.enabled = true;
            }

            if (faceoff.status == Round4FaceoffStatuses.Buzzed || faceoff.status == Round4FaceoffStatuses.OpponentChance)
            {
                var judgingTeamId = faceoff.status == Round4FaceoffStatuses.Buzzed
                    ? faceoff.buzzedTeamId
                    : faceoff.opponentTeamId;

                GUILayout.Space(4);
                GUILayout.Label($"RULE {TeamLabel(game, judgingTeamId)}'S ANSWER");
                GUILayout.Label("Click the board answer that matches what was said:");
                GUI.enabled = !_busy && !session.paused;
                // Phase "live answers": the Host's own snapshot carries every
                // answer's text/value regardless of reveal state (see
                // Round4BoardAnswerView.text's doc comment), so the Host picks
                // the real answer instead of guessing a bare rank number.
                var answers = new List<Round4BoardAnswerView>(current.board.answers ?? Array.Empty<Round4BoardAnswerView>());
                answers.Sort((a, b) => a.rank.CompareTo(b.rank));
                foreach (var answer in answers)
                {
                    var label = string.IsNullOrEmpty(answer.text)
                        ? $"#{answer.rank} (unknown text)"
                        : $"#{answer.rank}: {answer.text} ({answer.value})";
                    if (GUILayout.Button(label, GUILayout.Height(26)))
                    {
                        _ = SubmitGameIntentAsync(
                            Round4Intents.HostRuleFaceoffAnswer,
                            $"{{\"teamId\":\"{judgingTeamId}\",\"matchedRank\":{answer.rank}}}");
                    }
                }
                if (GUILayout.Button("No valid match", GUILayout.Height(28)))
                {
                    _ = SubmitGameIntentAsync(
                        Round4Intents.HostRuleFaceoffAnswer,
                        $"{{\"teamId\":\"{judgingTeamId}\"}}");
                }
                GUI.enabled = true;
            }
            else if (faceoff.status == Round4FaceoffStatuses.Decided)
            {
                if (faceoff.HasWinner)
                {
                    GUILayout.Label($"Face-off winner: {TeamLabel(game, faceoff.winningTeamId)}");
                }
                GUILayout.Label("Waiting for PLAY or PASS…");
            }
        }

        /// <summary>Normal board play: active player, timer, strikes, ruling controls. §19.</summary>
        private void DrawBoardPlay(
            Round4BoardPlayView boardPlay,
            Round4SurveyView current,
            HostGameSnapshot game,
            GameSessionView session)
        {
            GUILayout.Label("BOARD PLAY", HeaderStyle);
            GUILayout.Label($"On the board: {TeamLabel(game, boardPlay.controllingTeamId)}");

            var order = boardPlay.playerOrder ?? Array.Empty<string>();
            if (order.Length > 0 && boardPlay.currentPlayerIndex >= 0 && boardPlay.currentPlayerIndex < order.Length)
            {
                GUILayout.Label($"Current player: {order[boardPlay.currentPlayerIndex]}");
            }

            // Phase "live answers": the 5s clock no longer starts itself —
            // pose the question aloud to the active player, THEN start it.
            var boardTimerRunning = boardPlay.turnTimer != null && boardPlay.turnTimer.Exists
                && boardPlay.turnTimer.remainingMs > 0 && !boardPlay.turnTimer.expired;
            if (boardTimerRunning)
            {
                var t = boardPlay.turnTimer;
                GUILayout.Label($"Answer window: {Mathf.CeilToInt(t.remainingMs / 1000f)}s{(t.paused ? " (paused)" : "")}");
                // Live play: someone answered before the clock ran out — stop
                // it here rather than race the timeout, then rule the answer
                // via the board below.
                GUI.enabled = !_busy && !session.paused;
                if (GUILayout.Button("CANCEL TIMER (someone answered)", GUILayout.Height(26)))
                {
                    _ = SubmitGameIntentAsync(Round4Intents.HostCancelBoardTurnTimer, "{}");
                }
                GUI.enabled = true;
            }
            else
            {
                GUI.enabled = !_busy && !session.paused;
                if (GUILayout.Button("START 5s ANSWER TIMER", GUILayout.Height(32)))
                {
                    _ = SubmitGameIntentAsync(Round4Intents.HostStartBoardTurnTimer, "{}");
                }
                GUI.enabled = true;
            }

            GUILayout.Space(4);
            GUILayout.Label("RULE THIS TURN'S ANSWER");
            GUILayout.Label("Unrevealed answers — click the one that was spoken:");
            GUI.enabled = !_busy && !session.paused;
            foreach (var answer in current.board.answers ?? Array.Empty<Round4BoardAnswerView>())
            {
                if (answer.revealed) continue;
                // Phase "live answers": the Host's OWN snapshot carries this
                // text even before reveal (see Round4BoardAnswerView.text's
                // doc comment) — nothing a player ever receives.
                var label = string.IsNullOrEmpty(answer.text)
                    ? $"✓ #{answer.rank} (unknown text) — reveal it"
                    : $"✓ #{answer.rank}: {answer.text} ({answer.value})";
                if (GUILayout.Button(label, GUILayout.Height(26)))
                {
                    _ = SubmitGameIntentAsync(
                        Round4Intents.HostRuleBoardAnswer,
                        $"{{\"answerId\":\"{answer.answerId}\"}}");
                }
            }

            GUILayout.Space(4);
            GUILayout.Label("OR RECORD A STRIKE");
            if (GUILayout.Button("WRONG — strike", GUILayout.Height(30)))
            {
                _ = SubmitGameIntentAsync(Round4Intents.HostRecordStrike, "{\"reason\":\"wrong\"}");
            }
            if (GUILayout.Button("DUPLICATE — strike", GUILayout.Height(26)))
            {
                _ = SubmitGameIntentAsync(Round4Intents.HostRecordStrike, "{\"reason\":\"duplicate\"}");
            }
            if (GUILayout.Button("OFF-BOARD — strike", GUILayout.Height(26)))
            {
                _ = SubmitGameIntentAsync(Round4Intents.HostRecordStrike, "{\"reason\":\"off_board\"}");
            }
            if (GUILayout.Button("TIMEOUT — strike", GUILayout.Height(26)))
            {
                _ = SubmitGameIntentAsync(Round4Intents.HostRecordStrike, "{\"reason\":\"timeout\"}");
            }
            GUILayout.Space(6);
            GUILayout.Label($"STRIKES: {boardPlay.strikes} / {current.board.maxStrikes} — Host override:");
            GUILayout.BeginHorizontal();
            GUI.enabled = !_busy && !session.paused && boardPlay.strikes > 0;
            if (GUILayout.Button("− 1 strike", GUILayout.Height(26)))
            {
                _ = SubmitGameIntentAsync(
                    Round4Intents.HostSetStrikes,
                    $"{{\"count\":{Math.Max(0, boardPlay.strikes - 1)}}}");
            }
            GUI.enabled = !_busy && !session.paused;
            if (GUILayout.Button("+ 1 strike", GUILayout.Height(26)))
            {
                _ = SubmitGameIntentAsync(
                    Round4Intents.HostSetStrikes,
                    $"{{\"count\":{boardPlay.strikes + 1}}}");
            }
            GUILayout.EndHorizontal();
            GUI.enabled = true;
            GUILayout.Label("Live jurisdiction — corrects a mistaken call at any time.");
            GUILayout.Space(2);
            GUILayout.Label("If FORGIVE MEH! owes a retry, the server refuses");
            GUILayout.Label("the strike above until the retry is used — retry");
            GUILayout.Label("with this instead:");
            if (GUILayout.Button("WRONG AFTER RETRY — strike", GUILayout.Height(26)))
            {
                _ = SubmitGameIntentAsync(Round4Intents.HostRecordStrike, "{\"reason\":\"wrong\",\"afterRetry\":true}");
            }
            GUI.enabled = true;
        }

        /// <summary>Steal: stealing team, timer, wager, final answer, ruling. §19.</summary>
        private void DrawSteal(
            Round4StealView steal,
            Round4SurveyView current,
            HostGameSnapshot game,
            GameSessionView session)
        {
            GUILayout.Label("STEAL", HeaderStyle);
            GUILayout.Label($"Stealing: {TeamLabel(game, steal.stealingTeamId)}");
            GUILayout.Label($"Defending: {TeamLabel(game, steal.defendingTeamId)}");
            GUILayout.Label($"Status: {steal.status}");

            // Phase "live answers": the 30s clock no longer starts itself on
            // the third strike — announce the steal to the team, THEN start it.
            var stealTimerRunning = steal.conferTimer != null && steal.conferTimer.Exists
                && steal.conferTimer.remainingMs > 0 && !steal.conferTimer.expired;
            if (stealTimerRunning)
            {
                var t = steal.conferTimer;
                GUILayout.Label($"Conferring window: {Mathf.CeilToInt(t.remainingMs / 1000f)}s{(t.paused ? " (paused)" : "")}");
            }
            else if (!steal.resolved)
            {
                GUI.enabled = !_busy && !session.paused;
                if (GUILayout.Button("START 30s STEAL TIMER", GUILayout.Height(32)))
                {
                    _ = SubmitGameIntentAsync(Round4Intents.HostStartStealTimer, "{}");
                }
                GUI.enabled = true;
            }

            if (steal.hasWagerAmount)
            {
                GUILayout.Label($"Wager locked: {steal.wagerAmount} BB (cap {(steal.hasMaxWager ? steal.maxWager.ToString() : "?")})");
            }
            else
            {
                GUILayout.Label("Waiting for the stealing team's wager…");
            }

            if (steal.resolved)
            {
                GUILayout.Label(steal.hasWon
                    ? (steal.won ? "Steal succeeded." : "Steal failed.")
                    : "Steal resolved.");
                return;
            }

            // §19: the wager is locked BEFORE the stealing team answers. Ruling
            // early — before a wager exists — would resolve the steal and
            // permanently close the wager input on their phone with none ever
            // recorded. The one exception is a genuinely expired 30s window:
            // then the team simply has nothing staked, same as real Family
            // Feud when a team steals with no side bet.
            var timerExpired = steal.conferTimer != null && steal.conferTimer.expired;
            var canRule = steal.hasWagerAmount || timerExpired;

            GUILayout.Space(6);
            GUILayout.Label("RULE THE STEAL ANSWER");
            if (!canRule)
            {
                GUILayout.Label("Waiting for a wager, or for the 30s window to run out…");
            }
            GUI.enabled = !_busy && !session.paused && canRule;
            if (GUILayout.Button("CORRECT — steal succeeds", GUILayout.Height(34)))
            {
                _ = SubmitGameIntentAsync(Round4Intents.HostRuleStealAnswer, "{\"correct\":true}");
            }
            if (GUILayout.Button("WRONG — steal fails", GUILayout.Height(34)))
            {
                _ = SubmitGameIntentAsync(Round4Intents.HostRuleStealAnswer, "{\"correct\":false}");
            }
            GUI.enabled = true;
        }

        private void DrawRound4Complete(Round4StateView round4, HostGameSnapshot game)
        {
            var previous = GUI.color;
            GUI.color = Color.green;
            GUILayout.Label("ROUND 4 COMPLETE", HeaderStyle);
            GUI.color = previous;

            if (round4.HasRound4Winner)
            {
                GUILayout.Label($"Winner: {TeamLabel(game, round4.round4WinnerTeamId)}");
            }
            else
            {
                GUILayout.Label("Tied leaders — Sudden Death is not implemented yet.");
            }
        }
    }
}

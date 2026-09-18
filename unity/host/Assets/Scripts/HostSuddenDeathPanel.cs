using System;
using UnityEngine;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal
{
    /// <summary>
    /// ==================== SUDDEN DEATH ====================
    ///
    /// Phase 7D-B2. GAME_RULES_LOCKED.md §21, replaced by DECISION_LOG.md
    /// D-034: a face-off sequence (same mechanic as Round 4's own face-off,
    /// §19) — first team to win two face-offs IN A ROW wins the game.
    ///
    /// Functional, not finished — Phase 8 does the theatre.
    ///
    /// It computes nothing. Every value shown arrives from the server; every
    /// button sends the EXACT intent the room already accepts
    /// (packages/game-rules/src/room.ts's Sudden Death handlers). The Host's
    /// own ruling (HOST_RULE_SUDDEN_DEATH_ANSWER) is still just an intent.
    ///
    /// THE HOST CAN TRIGGER THIS AT ANY POINT — not only a genuine BB tie —
    /// per the project owner's explicit request (D-034). The "BEGIN SUDDEN
    /// DEATH" controls below are available whenever Sudden Death has not
    /// already started, regardless of what round or phase the game is in.
    ///
    /// CONTENT SAFETY: the question's board never reaches this panel —
    /// `SuddenDeathFaceoffView` carries only the prompt and (once decided)
    /// the winner, never the ranked answers themselves.
    /// </summary>
    public partial class HostLobby
    {
        private Vector2 _suddenDeathScroll;
        private string _suddenDeathTeamAInput = "";
        private string _suddenDeathTeamBInput = "";

        private void DrawSuddenDeathPanel(LobbySnapshot snapshot, HostGameSnapshot game)
        {
            GUILayout.BeginVertical(GUILayout.Width(360));

            GUILayout.Label("SUDDEN DEATH", HeaderStyle);

            if (game == null || !game.GameRunning || game.game == null)
            {
                GUILayout.Label("No game running.");
                GUILayout.EndVertical();
                return;
            }

            var session = game.game;
            var suddenDeath = session.suddenDeath;

            if (suddenDeath == null || !suddenDeath.Exists)
            {
                DrawSuddenDeathEntry(session, game);
                GUILayout.EndVertical();
                return;
            }

            _suddenDeathScroll = GUILayout.BeginScrollView(_suddenDeathScroll, GUILayout.Height(420));

            DrawSuddenDeathStreaks(suddenDeath, game);
            GUILayout.Space(6);

            if (suddenDeath.complete)
            {
                var previous = GUI.color;
                GUI.color = Color.green;
                GUILayout.Label("SUDDEN DEATH COMPLETE", HeaderStyle);
                GUI.color = previous;
                if (suddenDeath.HasWinner)
                {
                    GUILayout.Label($"WINNER: {TeamLabel(game, suddenDeath.winnerTeamId)}");
                }
            }
            else
            {
                var current = suddenDeath.Current;
                if (current == null)
                {
                    DrawSuddenDeathStartFaceoffButton(session, game);
                }
                else
                {
                    DrawSuddenDeathFaceoff(current, game, session);
                }
            }

            GUILayout.EndScrollView();
            GUILayout.EndVertical();
        }

        /// <summary>
        /// The Host names exactly two teams and begins Sudden Death — at ANY
        /// point, per D-034. Not gated on a tie check: the project owner
        /// wanted this control regardless of the game's current standings.
        /// </summary>
        private void DrawSuddenDeathEntry(GameSessionView session, HostGameSnapshot game)
        {
            GUILayout.Label("Not running. Begin it with any two teams:");
            GUILayout.Space(4);

            GUILayout.Label("Team A id (e.g. TEAM_A):");
            _suddenDeathTeamAInput = GUILayout.TextField(_suddenDeathTeamAInput, GUILayout.Height(24));
            GUILayout.Label("Team B id (e.g. TEAM_B):");
            _suddenDeathTeamBInput = GUILayout.TextField(_suddenDeathTeamBInput, GUILayout.Height(24));

            GUILayout.Space(6);
            var canBegin = !_busy && !session.paused
                && !string.IsNullOrEmpty(_suddenDeathTeamAInput)
                && !string.IsNullOrEmpty(_suddenDeathTeamBInput);
            GUI.enabled = canBegin;
            if (GUILayout.Button("BEGIN SUDDEN DEATH", GUILayout.Height(40)))
            {
                _ = SubmitGameIntentAsync(
                    SuddenDeathIntents.HostBeginSuddenDeath,
                    $"{{\"teamIds\":[\"{_suddenDeathTeamAInput}\",\"{_suddenDeathTeamBInput}\"]}}");
            }
            GUI.enabled = true;

            GUILayout.Space(4);
            GUILayout.Label("Callable at any point — not only a real tie.");
            GUILayout.Label("Face-offs only. First to 2 wins IN A ROW wins.");
        }

        private void DrawSuddenDeathStreaks(SuddenDeathStateView suddenDeath, HostGameSnapshot game)
        {
            GUILayout.Label("STREAKS (first to 2 in a row wins)", HeaderStyle);
            foreach (var streak in suddenDeath.streaks ?? Array.Empty<SuddenDeathStreak>())
            {
                var previous = GUI.color;
                if (streak.consecutiveWins >= 1) GUI.color = Color.yellow;
                GUILayout.Label($"  {TeamLabel(game, streak.teamId)}: {streak.consecutiveWins} in a row");
                GUI.color = previous;
            }
        }

        private void DrawSuddenDeathStartFaceoffButton(GameSessionView session, HostGameSnapshot game)
        {
            GUILayout.Space(6);
            GUI.enabled = !_busy && !session.paused;
            if (GUILayout.Button("HOST: START NEXT FACE-OFF", GUILayout.Height(40)))
            {
                _ = SubmitGameIntentAsync(SuddenDeathIntents.HostStartSuddenDeathFaceoff, "{}");
            }
            GUI.enabled = true;
            GUILayout.Label("Reveals the next question and opens the");
            GUILayout.Label("buzzer while you read it aloud.");
        }

        private void DrawSuddenDeathFaceoff(
            SuddenDeathFaceoffView faceoff,
            HostGameSnapshot game,
            GameSessionView session)
        {
            GUILayout.Label("FACE-OFF", HeaderStyle);
            GUILayout.Label(faceoff.prompt);
            var participants = faceoff.participantTeamIds ?? Array.Empty<string>();
            GUILayout.Label(string.Join("  vs  ", Array.ConvertAll(participants, id => TeamLabel(game, id))));
            GUILayout.Label($"Status: {faceoff.status}");

            if (faceoff.HasBuzzedTeam)
            {
                GUILayout.Label($"Buzzed first: {TeamLabel(game, faceoff.buzzedTeamId)}");
            }

            var timerRunning = faceoff.answerTimer != null && faceoff.answerTimer.Exists
                && faceoff.answerTimer.remainingMs > 0 && !faceoff.answerTimer.expired;
            if (timerRunning)
            {
                var t = faceoff.answerTimer;
                GUILayout.Label($"Answer window: {Mathf.CeilToInt(t.remainingMs / 1000f)}s{(t.paused ? " (paused)" : "")}");
            }

            if (faceoff.status == SuddenDeathFaceoffStatuses.Buzzed)
            {
                GUILayout.Space(4);
                GUILayout.Label($"RULE {TeamLabel(game, faceoff.buzzedTeamId)}'S ANSWER");
                GUILayout.Label("§21/D-034: only the #1 answer wins — anything");
                GUILayout.Label("else loses this face-off outright, no opponent chance.");
                GUI.enabled = !_busy && !session.paused;
                if (GUILayout.Button("CORRECT (#1 answer) — wins this face-off", GUILayout.Height(32)))
                {
                    _ = SubmitGameIntentAsync(
                        SuddenDeathIntents.HostRuleSuddenDeathAnswer,
                        $"{{\"teamId\":\"{faceoff.buzzedTeamId}\",\"correct\":true}}");
                }
                if (GUILayout.Button("WRONG — loses this face-off outright", GUILayout.Height(32)))
                {
                    _ = SubmitGameIntentAsync(
                        SuddenDeathIntents.HostRuleSuddenDeathAnswer,
                        $"{{\"teamId\":\"{faceoff.buzzedTeamId}\",\"correct\":false}}");
                }
                GUI.enabled = true;
            }
            else if (faceoff.status == SuddenDeathFaceoffStatuses.Reading)
            {
                GUILayout.Space(4);
                GUILayout.Label("Waiting for a buzz. If nobody buzzes, this");
                GUILayout.Label("face-off decides nothing — start a fresh one");
                GUILayout.Label("whenever you are ready:");
                GUI.enabled = !_busy && !session.paused;
                if (GUILayout.Button("NO DECISION — reveal a fresh face-off", GUILayout.Height(30)))
                {
                    _ = SubmitGameIntentAsync(SuddenDeathIntents.HostRecordSuddenDeathNoDecision, "{}");
                }
                GUI.enabled = true;
            }
            else if (faceoff.status == SuddenDeathFaceoffStatuses.Decided)
            {
                if (faceoff.HasWinner)
                {
                    GUILayout.Label($"Face-off winner: {TeamLabel(game, faceoff.winningTeamId)}");
                }
                else if (faceoff.noDecision)
                {
                    GUILayout.Label("No decision — nothing changed.");
                }
                DrawSuddenDeathStartFaceoffButton(session, game);
            }
        }
    }
}

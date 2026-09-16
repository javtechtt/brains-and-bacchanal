using System;
using UnityEngine;
using BrainsAndBacchanal.Protocol;
// Aliased, not imported wholesale: System.Diagnostics.Debug would collide with
// UnityEngine.Debug the moment anything in this file logs.
using Stopwatch = System.Diagnostics.Stopwatch;

namespace BrainsAndBacchanal
{
    /// <summary>
    /// ============ DEVELOPMENT ENGINE TEST PANEL — NOT FINAL GAMEPLAY ============
    ///
    /// Phase 5 spec §22: enough Host surface to OBSERVE and EXERCISE the generic
    /// authoritative engine before any round exists.
    ///
    /// Everything here is GENERIC. A challenge with a type the Host types in by
    /// hand, a turn, a timer with a duration the Host picks, a Host ruling, a BB
    /// adjustment. There is no Round 1 screen, no Family Feud board, no card, no
    /// Market and no Maco Mail — those are Phases 6-7, and several of their rules
    /// are still open in docs/OPEN_RULES.md.
    ///
    /// NONE OF IT SHIPS. Phase 8 builds the real Host presentation; this is a
    /// test instrument, kept in its own file so that is obvious at a glance and
    /// so deleting it later touches nothing else.
    ///
    /// AND IT DECIDES NOTHING. Every button sends an intent and redraws whatever
    /// the server says is true afterwards. No BB arithmetic, no floor rule, no
    /// timer expiry and no legality check lives in this file.
    /// ===========================================================================
    /// </summary>
    public partial class HostLobby
    {
        // --- Test-panel input state ----------------------------------------
        private string _devChallengeType = "TEST_CHALLENGE";
        private string _devTimerSeconds = "30";
        private string _devBbAmount = "500";
        private string _devTeamId = TeamIds.A;
        private Vector2 _devScroll;

        /// <summary>
        /// Phases this panel offers.
        ///
        /// A FIXED array, so the Layout and Repaint passes of one OnGUI call
        /// always draw the same number of buttons — the same discipline the
        /// lobby panel documents. These are generic engine phases; the server's
        /// transition table decides which are reachable from where and refuses
        /// the rest. This panel never predicts that.
        /// </summary>
        private static readonly string[] PhaseButtons =
        {
            "ROUND_INTRO", "CHALLENGE_INTRO", "RESULT", "ROUND_COMPLETE",
        };

        /// <summary>
        /// Draw the engine test panel.
        ///
        /// Both snapshots are passed in, already captured once by OnGUI, so
        /// every draw call in this pass sees identical values.
        /// </summary>
        private void DrawEnginePanel(LobbySnapshot snapshot, HostGameSnapshot game)
        {
            GUILayout.BeginVertical(GUILayout.Width(380));

            GUILayout.Label("GAME ENGINE  [DEV]", HeaderStyle);

            if (game == null || !game.GameRunning)
            {
                GUILayout.Label("No game running.");
                GUILayout.Label(snapshot.room.teamsLocked
                    ? "Press START GAME."
                    : "Lock the teams first.");
                GUILayout.EndVertical();
                return;
            }

            var session = game.game;

            GUILayout.Label($"Phase: {session.phase}");
            GUILayout.Label($"Round: {session.roundIndex}");

            if (session.paused)
            {
                var previous = GUI.color;
                GUI.color = Color.yellow;
                GUILayout.Label($"PAUSED ({session.pause?.reason})");
                GUILayout.Label($"Resumes to: {session.pause?.resumePhase}");
                GUI.color = previous;
            }

            GUILayout.Space(4);
            DrawTeamBalances(game);

            GUILayout.Space(4);
            DrawChallengeStatus(session);

            if (!string.IsNullOrEmpty(_lastEvent)) GUILayout.Label($"Last event: {_lastEvent}");

            GUILayout.Space(6);

            _devScroll = GUILayout.BeginScrollView(_devScroll, GUILayout.Height(320));

            // Resume comes FIRST and stays available while paused: it is the one
            // action that matters when the game is stopped, and D-011 makes it
            // Host-only, so nothing else can offer it.
            if (session.paused)
            {
                GUI.enabled = !_busy;
                if (GUILayout.Button("RESUME GAME", GUILayout.Height(40)))
                {
                    _ = SubmitGameIntentAsync(GameIntents.ResumeGame, "{}");
                }
                GUI.enabled = true;
                GUILayout.Space(8);
            }

            DrawPhaseControls(session);
            GUILayout.Space(6);
            DrawChallengeControls(snapshot, session);
            GUILayout.Space(6);
            DrawTimerControls(session);
            GUILayout.Space(6);
            DrawRulingControls(snapshot, session);
            GUILayout.Space(6);
            DrawDevBbControls(snapshot, game);

            GUILayout.EndScrollView();
            GUILayout.EndVertical();
        }

        private void DrawTeamBalances(HostGameSnapshot game)
        {
            var teams = game.teams ?? Array.Empty<GameTeamView>();
            foreach (var team in teams)
            {
                GUILayout.BeginHorizontal();
                GUILayout.Label(TeamIds.Label(team.teamId), GUILayout.Width(90));
                // DISPLAYED, NEVER COMPUTED. The server owns the ledger and the
                // floor at zero; this is the number it sent.
                GUILayout.Label($"{team.bb} BB", GUILayout.Width(90));
                GUILayout.EndHorizontal();
            }
        }

        private void DrawChallengeStatus(GameSessionView session)
        {
            var challenge = session.challenge;
            if (challenge == null || string.IsNullOrEmpty(challenge.challengeId))
            {
                GUILayout.Label("Challenge: none");
                GUILayout.Label("Turn: —");
                GUILayout.Label("Active: —");
                GUILayout.Label("Timer: none");
                return;
            }

            GUILayout.Label($"Challenge: {challenge.challengeType} ({challenge.status})");

            var turn = session.turn;
            var turnText = turn != null && turn.HasTeam
                ? TeamIds.Label(turn.teamId) + (turn.HasPlayer ? $" / {NameOf(turn.playerId)}" : "")
                : "nobody";
            GUILayout.Label($"Turn: {turnText}");

            var active = challenge.activePlayerIds ?? Array.Empty<string>();
            GUILayout.Label(active.Length == 0
                ? "Active: nobody"
                : $"Active: {string.Join(", ", NamesOf(active))}");

            var timer = challenge.timer;
            if (timer != null && !string.IsNullOrEmpty(timer.timerId))
            {
                var seconds = Mathf.CeilToInt(DisplayRemainingMs(timer) / 1000f);
                GUILayout.Label($"Timer: {seconds}s{(timer.paused ? "  (frozen)" : "")}");
            }
            else
            {
                GUILayout.Label("Timer: none");
            }
        }

        private void DrawPhaseControls(GameSessionView session)
        {
            GUILayout.Label("Phase", SubHeaderStyle);
            GUI.enabled = !_busy && !session.paused;

            GUILayout.BeginHorizontal();
            foreach (var phase in PhaseButtons)
            {
                if (GUILayout.Button(phase, GUILayout.Width(115)))
                {
                    _ = SubmitGameIntentAsync(GameIntents.AdvancePhase, "{\"to\":" + Quote(phase) + "}");
                }
            }
            GUILayout.EndHorizontal();

            if (GUILayout.Button("Pause", GUILayout.Width(115)))
            {
                _ = SubmitGameIntentAsync(GameIntents.PauseGame, "{}");
            }

            GUI.enabled = true;
        }

        private void DrawChallengeControls(LobbySnapshot snapshot, GameSessionView session)
        {
            GUILayout.Label("Challenge  [generic]", SubHeaderStyle);
            GUI.enabled = !_busy && !session.paused;

            GUILayout.BeginHorizontal();
            GUILayout.Label("Type", GUILayout.Width(40));
            // Free text, because challengeType is a plain string on the wire.
            // Offering a fixed menu here would imply a decision about round
            // composition that OPEN_RULES.md §1 leaves open.
            _devChallengeType = GUILayout.TextField(_devChallengeType, GUILayout.Width(200));
            GUILayout.EndHorizontal();

            GUILayout.BeginHorizontal();
            if (GUILayout.Button("Prepare", GUILayout.Width(95)))
            {
                _ = SubmitGameIntentAsync(
                    GameIntents.PrepareChallenge,
                    "{\"challengeType\":" + Quote(_devChallengeType) + "}");
            }
            if (GUILayout.Button("Begin", GUILayout.Width(95)))
            {
                _ = SubmitGameIntentAsync(GameIntents.StartChallenge, "{}");
            }
            if (GUILayout.Button("To review", GUILayout.Width(95)))
            {
                _ = SubmitGameIntentAsync(GameIntents.RequestReview, "{}");
            }
            GUILayout.EndHorizontal();

            GUILayout.BeginHorizontal();
            GUILayout.Label("Turn", GUILayout.Width(40));
            foreach (var teamId in TeamsInPlay(snapshot))
            {
                if (GUILayout.Button(TeamIds.Label(teamId), GUILayout.Width(85)))
                {
                    // Includes the selected player when there is one, so the
                    // Host can set a team turn or a player turn from one row.
                    var payload = "{\"teamId\":" + Quote(teamId) +
                                  (string.IsNullOrEmpty(_selectedPlayerId)
                                      ? ""
                                      : ",\"playerId\":" + Quote(_selectedPlayerId)) + "}";
                    _ = SubmitGameIntentAsync(GameIntents.SetTurn, payload);
                }
            }
            GUILayout.EndHorizontal();

            GUILayout.BeginHorizontal();
            GUI.enabled = !_busy && !session.paused && !string.IsNullOrEmpty(_selectedPlayerId);

            // Names the player rather than saying "selected". Marking someone
            // active is what makes their phone dropping pause the game (D-011),
            // and a button that does not say who it acts on is how the wrong
            // person ends up active.
            var activeLabel = string.IsNullOrEmpty(_selectedPlayerId)
                ? "Set ACTIVE (pick a player)"
                : $"Set ACTIVE: {NameOf(_selectedPlayerId)}";

            if (GUILayout.Button(activeLabel, GUILayout.Width(200)))
            {
                _ = SubmitGameIntentAsync(
                    GameIntents.SetActivePlayers,
                    "{\"playerIds\":[" + Quote(_selectedPlayerId) + "]}");
            }
            GUI.enabled = !_busy && !session.paused;
            if (GUILayout.Button("Clear active", GUILayout.Width(120)))
            {
                _ = SubmitGameIntentAsync(GameIntents.SetActivePlayers, "{\"playerIds\":[]}");
            }
            GUILayout.EndHorizontal();

            GUI.enabled = true;
        }

        private void DrawTimerControls(GameSessionView session)
        {
            GUILayout.Label("Timer", SubHeaderStyle);
            GUI.enabled = !_busy && !session.paused;

            GUILayout.BeginHorizontal();
            GUILayout.Label("Seconds", GUILayout.Width(60));
            // A test duration the Host types. NO challenge duration is decided
            // anywhere in this build: Think Fast (OPEN_RULES.md §2), Sing a Song
            // (§6) and the Round 4 / Sudden Death timers (§11) are all open.
            _devTimerSeconds = GUILayout.TextField(_devTimerSeconds, GUILayout.Width(55));

            if (GUILayout.Button("Start", GUILayout.Width(85)))
            {
                if (int.TryParse(_devTimerSeconds, out var seconds) && seconds > 0)
                {
                    _ = SubmitGameIntentAsync(
                        GameIntents.StartTimer,
                        "{\"durationMs\":" + (seconds * 1000) + "}");
                }
                else
                {
                    _lastError = "Timer seconds must be a positive whole number.";
                }
            }
            if (GUILayout.Button("Cancel", GUILayout.Width(85)))
            {
                _ = SubmitGameIntentAsync(GameIntents.CancelTimer, "{}");
            }
            GUILayout.EndHorizontal();

            GUI.enabled = true;
        }

        private void DrawRulingControls(LobbySnapshot snapshot, GameSessionView session)
        {
            GUILayout.Label("Host ruling  [subjective]", SubHeaderStyle);
            GUI.enabled = !_busy && !session.paused;

            // Which team a ruling is about. The HOST is authoritative for the
            // judgment itself; the server records it and never re-judges it.
            GUILayout.BeginHorizontal();
            GUILayout.Label("Team", GUILayout.Width(40));
            foreach (var teamId in TeamsInPlay(snapshot))
            {
                var selected = _devTeamId == teamId;
                if (GUILayout.Toggle(selected, " " + TeamIds.Label(teamId), GUILayout.Width(95)) && !selected)
                {
                    _devTeamId = teamId;
                }
            }
            GUILayout.EndHorizontal();

            GUILayout.BeginHorizontal();
            if (GUILayout.Button("VALID", GUILayout.Width(95))) SubmitRuling(HostRulingKinds.Valid);
            if (GUILayout.Button("INVALID", GUILayout.Width(95))) SubmitRuling(HostRulingKinds.Invalid);
            if (GUILayout.Button("WINNER", GUILayout.Width(95))) SubmitRuling(HostRulingKinds.SelectWinner);
            GUILayout.EndHorizontal();

            GUILayout.BeginHorizontal();
            // Resolving with a BB amount exercises the real award path —
            // challenge result through the ledger — rather than editing a
            // balance directly.
            if (GUILayout.Button("RESOLVE (award selected team)", GUILayout.Width(220)))
            {
                var amount = ParsedBbAmount();
                var payload = "{\"winningTeamIds\":[" + Quote(_devTeamId) + "]" +
                              ",\"bbDeltas\":{" + Quote(_devTeamId) + ":" + amount + "}}";
                _ = SubmitGameIntentAsync(GameIntents.ResolveChallenge, payload);
            }
            if (GUILayout.Button("RESOLVE (no BB)", GUILayout.Width(140)))
            {
                _ = SubmitGameIntentAsync(GameIntents.ResolveChallenge, "{}");
            }
            GUILayout.EndHorizontal();

            GUI.enabled = true;
        }

        private void SubmitRuling(string kind)
        {
            var payload = "{\"kind\":" + Quote(kind) + ",\"teamId\":" + Quote(_devTeamId) +
                          (string.IsNullOrEmpty(_selectedPlayerId)
                              ? ""
                              : ",\"playerId\":" + Quote(_selectedPlayerId)) + "}";
            _ = SubmitGameIntentAsync(GameIntents.Ruling, payload);
        }

        private void DrawDevBbControls(LobbySnapshot snapshot, HostGameSnapshot game)
        {
            GUILayout.Label("BB  [DEV ONLY — will not exist in the game]", SubHeaderStyle);

            if (!game.devToolsEnabled)
            {
                // The server refuses these outright unless it was started with
                // development tools on, so the panel says so rather than
                // offering buttons that would only be rejected.
                GUILayout.Label("Development controls are disabled on this server.");
                return;
            }

            GUI.enabled = !_busy;

            GUILayout.BeginHorizontal();
            GUILayout.Label("Amount", GUILayout.Width(60));
            _devBbAmount = GUILayout.TextField(_devBbAmount, GUILayout.Width(65));
            GUILayout.EndHorizontal();

            foreach (var teamId in TeamsInPlay(snapshot))
            {
                GUILayout.BeginHorizontal();
                GUILayout.Label(TeamIds.Label(teamId), GUILayout.Width(70));
                if (GUILayout.Button("+", GUILayout.Width(40))) AdjustBb(teamId, ParsedBbAmount());
                if (GUILayout.Button("−", GUILayout.Width(40))) AdjustBb(teamId, -ParsedBbAmount());

                // Proves the floor without any arithmetic here: the server
                // clamps, and the balance that comes back is the evidence.
                if (GUILayout.Button("−5000 (floor test)", GUILayout.Width(140)))
                {
                    AdjustBb(teamId, -5000);
                }
                GUILayout.EndHorizontal();
            }

            GUI.enabled = true;
        }

        private void AdjustBb(string teamId, int delta)
        {
            var payload = "{\"teamId\":" + Quote(teamId) + ",\"delta\":" + delta + "}";
            _ = SubmitGameIntentAsync(GameIntents.DevAdjustBb, payload);
        }

        private int ParsedBbAmount()
        {
            return int.TryParse(_devBbAmount, out var value) ? value : 0;
        }

        /// <summary>Display name for a playerId. Test readout only.</summary>
        private string NameOf(string playerId)
        {
            var players = _snapshot?.players;
            if (players == null) return playerId;
            foreach (var player in players)
            {
                if (player.playerId == playerId) return player.displayName;
            }
            return playerId;
        }

        private string[] NamesOf(string[] playerIds)
        {
            var names = new string[playerIds.Length];
            for (var i = 0; i < playerIds.Length; i++) names[i] = NameOf(playerIds[i]);
            return names;
        }

        /// <summary>
        /// What the timer should READ right now, interpolated since the last
        /// snapshot.
        ///
        /// WHY THIS IS NEEDED: a running timer emits no events. The engine
        /// announces TIMER_STARTED and then says nothing until it expires or
        /// something else happens, because a per-second tick would be pure
        /// network noise and would inflate nothing useful.
        ///
        /// So a display that only refreshed on events showed the value from
        /// TIMER_STARTED — a frozen "30" — until the next event arrived. When
        /// that event was GAME_PAUSED, the number finally jumped to its true
        /// value, which looks exactly like "the timer kept running through the
        /// disconnect". It had not: the server had frozen it correctly, and the
        /// display was simply stale. Found during the Phase 5 physical test.
        ///
        /// AUTHORITY IS UNCHANGED. This moves a number on a screen between
        /// server updates. It never decides expiry — that is the server's, and
        /// arrives as TIMER_EXPIRED (D-022). Floored at zero so a slow snapshot
        /// cannot show a negative countdown.
        /// </summary>
        private float DisplayRemainingMs(TimerView timer)
        {
            // A paused timer holds still. The server has banked the remaining
            // time and excludes the pause from elapsed time, so counting down
            // here would contradict it — and would recreate the very bug this
            // method exists to fix.
            if (timer.paused) return timer.remainingMs;

            var elapsedMs =
                (Stopwatch.GetTimestamp() - _gameSnapshotAtTicks) * 1000.0 / Stopwatch.Frequency;
            return Mathf.Max(0f, timer.remainingMs - (float)elapsedMs);
        }

        private static GUIStyle _subHeaderStyle;
        private static GUIStyle SubHeaderStyle => _subHeaderStyle ??= new GUIStyle(GUI.skin.label)
        {
            fontSize = 13,
            fontStyle = FontStyle.Bold,
        };
    }
}

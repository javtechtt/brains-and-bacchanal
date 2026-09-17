using System;
using UnityEngine;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal
{
    /// <summary>
    /// ================ ROUND 2 — "SHAKE UP YUHSELF!" ================
    ///
    /// Phase 7A spec §19. The FIRST REAL ROUND PRESENTATION: the current
    /// physical challenge, the team balances, the card status, and the Host
    /// controls that actually run a game.
    ///
    /// Functional, not finished. Phase 8 builds the branded presentation —
    /// no animation, no sound and no theatre here, deliberately (§19: "Do not
    /// add flashy animations yet").
    ///
    /// ================ WHAT THIS PANEL DOES NOT DO ================
    /// It does not run Bottle Battle, Match Makers, Grabbers or Bombers.
    /// D-003 puts those in the room, with the Host and the players and whatever
    /// props the game needs. There is no timer to start, no score to enter and
    /// no winner detection — the Host WATCHES the game and says who won.
    ///
    /// It also computes nothing. The 500, the ×2 and the final balance all
    /// arrive from the server. Every button below sends an intent and redraws
    /// whatever the server says afterwards.
    /// ==============================================================
    ///
    /// THE TWO-STEP WINNER FLOW is the one piece of interaction design that
    /// matters here. Selecting a team and paying a team are separate intents,
    /// because a misclick on a single button would award 500 or 1,000 BB
    /// irreversibly in front of a room of people. So: tap a team, see it named
    /// on screen, then press a clearly separated CONFIRM.
    /// </summary>
    public partial class HostLobby
    {
        private Vector2 _round2Scroll;

        /// <summary>
        /// Draw the Round 2 panel.
        ///
        /// Both snapshots are passed in, already captured once by OnGUI, so
        /// every draw call in this pass sees identical values — the same
        /// Layout/Repaint discipline the other panels document.
        /// </summary>
        private void DrawRound2Panel(LobbySnapshot snapshot, HostGameSnapshot game)
        {
            GUILayout.BeginVertical(GUILayout.Width(360));

            GUILayout.Label("ROUND 2 — SHAKE UP YUHSELF!", HeaderStyle);

            if (game == null || !game.GameRunning || game.game == null)
            {
                GUILayout.Label("No game running.");
                GUILayout.EndVertical();
                return;
            }

            var session = game.game;
            var round2 = session.round2;

            // `round2 != null` is NOT enough: JsonUtility turns a JSON null into an
            // empty object, so every round outside Round 2 arrives as a non-null
            // Round2StateView with no challenges. `Exists` is the real test.
            if (round2 == null || !round2.Exists)
            {
                DrawRound2Entry(session, game);
                GUILayout.EndVertical();
                return;
            }

            _round2Scroll = GUILayout.BeginScrollView(_round2Scroll, GUILayout.Height(520));

            DrawRound2Progress(round2);
            GUILayout.Space(6);

            if (round2.complete)
            {
                DrawRoundComplete(round2);
            }
            else
            {
                DrawCurrentChallenge(session, game, round2);
            }

            GUILayout.Space(8);
            DrawRound2Results(round2);

            GUILayout.EndScrollView();
            GUILayout.EndVertical();
        }

        /// <summary>
        /// The development entry into Round 2.
        ///
        /// Round 1 does not exist yet, so there is no production route here
        /// (Phase 7A §4). The button is drawn only when the SERVER reports
        /// development tools enabled — and the server refuses the intent anyway
        /// if it is not, so hiding it is convenience, never the protection.
        /// </summary>
        private void DrawRound2Entry(GameSessionView session, HostGameSnapshot game)
        {
            GUILayout.Label("Round 2 has not started.");

            if (!game.devToolsEnabled)
            {
                GUILayout.Label("Round 1 is not implemented yet, and");
                GUILayout.Label("development tools are disabled on this");
                GUILayout.Label("server, so there is no way in.");
                return;
            }

            GUILayout.Label($"Currently: {session.phase}, round {session.roundIndex}.");
            GUILayout.Space(6);

            GUI.enabled = !_busy && !session.paused;
            if (GUILayout.Button("[DEV] START ROUND 2", GUILayout.Height(44)))
            {
                _ = SubmitGameIntentAsync(Round2Intents.DevStartRound2, "{}");
            }
            GUI.enabled = true;

            GUILayout.Space(4);
            GUILayout.Label("Development only. Walks the real phases");
            GUILayout.Label("to Round 2 because Round 1 does not");
            GUILayout.Label("exist yet. Not a production rule.");
        }

        /// <summary>Four names with their state. The order is the server's.</summary>
        private void DrawRound2Progress(Round2StateView round2)
        {
            GUILayout.Label($"Challenge {Math.Min(round2.resolvedCount + 1, round2.challenges.Length)} of {round2.challenges.Length}");

            foreach (var challenge in round2.challenges)
            {
                var previous = GUI.color;
                if (challenge.IsResolved) GUI.color = Color.green;
                else if (challenge.IsInProgress) GUI.color = Color.cyan;
                else GUI.color = Color.grey;

                var marker = challenge.IsResolved ? "✓" : challenge.IsInProgress ? "▶" : "·";
                GUILayout.Label($"{marker} {challenge.displayName}");
                GUI.color = previous;
            }
        }

        /// <summary>
        /// The challenge on screen now, and the controls that run it.
        /// </summary>
        private void DrawCurrentChallenge(
            GameSessionView session,
            HostGameSnapshot game,
            Round2StateView round2)
        {
            var current = round2.Current;
            if (current == null)
            {
                GUILayout.Label("No current challenge.");
                return;
            }

            GUILayout.Space(4);
            GUILayout.Label(current.displayName.ToUpperInvariant(), HeaderStyle);
            GUILayout.Label($"{current.baseRewardBb} BB to the winner");

            GUILayout.Space(6);
            DrawRound2Balances(game, round2);

            GUILayout.Space(6);
            DrawEligibleCards(round2, session);

            GUILayout.Space(8);

            // --- Step 0: prepare and start -----------------------------------
            if (!current.IsInProgress)
            {
                GUILayout.Label("Prepare the challenge to put it on screen.");

                // The engine requires CHALLENGE_INTRO before a challenge can be
                // prepared. Offered as a button rather than done silently: the
                // phase is real state clients see, not an implementation detail.
                GUI.enabled = !_busy && !session.paused && session.phase != "CHALLENGE_INTRO";
                if (GUILayout.Button("1. Go to CHALLENGE INTRO", GUILayout.Height(32)))
                {
                    _ = SubmitGameIntentAsync(
                        GameIntents.AdvancePhase,
                        "{\"to\":\"CHALLENGE_INTRO\"}");
                }

                GUI.enabled = !_busy && !session.paused && session.phase == "CHALLENGE_INTRO";
                if (GUILayout.Button($"2. PREPARE {current.displayName}", GUILayout.Height(36)))
                {
                    // NO CHALLENGE TYPE IS SENT. The server hands out the next
                    // one in the locked order, so the Host cannot skip a game.
                    _ = SubmitGameIntentAsync(Round2Intents.PrepareChallenge, "{}");
                }
                GUI.enabled = true;
                return;
            }

            // --- Step 1: begin play, open the card window ---------------------
            GUI.enabled = !_busy && !session.paused && session.phase == "CHALLENGE_INTRO";
            if (GUILayout.Button("3. BEGIN CHALLENGE", GUILayout.Height(36)))
            {
                _ = SubmitGameIntentAsync(GameIntents.StartChallenge, "{}");
            }

            GUI.enabled = !_busy && !session.paused && session.phase == "ACTIVE_PLAY";
            if (GUILayout.Button("4. OPEN CARD WINDOW", GUILayout.Height(32)))
            {
                // The challenge kind comes from the server's own Round 2 state,
                // so the eligibility row is never guessed here.
                _ = SubmitGameIntentAsync(
                    SharedIntents.OpenCardWindow,
                    $"{{\"challengeKind\":\"{round2.cardChallengeKind}\"}}");
            }
            GUI.enabled = true;

            GUILayout.Space(10);

            // --- Step 2: the winner, in two deliberate taps -------------------
            GUILayout.Label("SELECT WINNER", HeaderStyle);
            GUILayout.Label("The Host judges the physical game.");

            var teams = round2.participatingTeamIds ?? Array.Empty<string>();
            foreach (var teamId in teams)
            {
                var selected = round2.pendingWinnerTeamId == teamId;
                var previous = GUI.color;
                if (selected) GUI.color = Color.cyan;

                GUI.enabled = !_busy && !session.paused;
                if (GUILayout.Button(
                        $"{(selected ? "● " : "○ ")}{TeamLabel(game, teamId)}",
                        GUILayout.Height(40)))
                {
                    _ = SubmitGameIntentAsync(
                        Round2Intents.SelectWinner,
                        $"{{\"teamId\":\"{teamId}\"}}");
                }
                GUI.enabled = true;
                GUI.color = previous;
            }

            GUILayout.Space(8);

            // --- Step 3: CONFIRM. This is the one that pays. ------------------
            if (round2.HasPendingWinner)
            {
                var previous = GUI.color;
                GUI.color = Color.yellow;
                GUILayout.Label($"Confirm: {TeamLabel(game, round2.pendingWinnerTeamId)} wins");
                GUI.color = previous;

                GUI.enabled = !_busy && !session.paused;
                if (GUILayout.Button("★ CONFIRM RESULT ★", GUILayout.Height(52)))
                {
                    // NO AMOUNT IS SENT. The server takes the reward from
                    // configuration and the multiplier from the shared systems.
                    _ = SubmitGameIntentAsync(Round2Intents.ConfirmResult, "{}");
                }
                GUI.enabled = true;
            }
            else
            {
                GUILayout.Label("Select a team before confirming.");
            }
        }

        /// <summary>
        /// Balances, with the selected team marked.
        ///
        /// Displayed, never calculated. The server owns the ledger and the
        /// floor at zero.
        /// </summary>
        private void DrawRound2Balances(HostGameSnapshot game, Round2StateView round2)
        {
            var teams = game.teams ?? Array.Empty<GameTeamView>();
            foreach (var team in teams)
            {
                var marker = round2.pendingWinnerTeamId == team.teamId ? " ←" : "";
                GUILayout.Label($"{team.displayName} — {team.bb} BB{marker}");
            }
        }

        /// <summary>
        /// Which Bacchanal cards are legal here, and whether one is in force.
        ///
        /// GAME_RULES_LOCKED.md §6 — Round 2 permits Double It only. The label
        /// is written here because it is a caption, but the RULE is the
        /// server's: an illegal card is refused server-side whatever this says.
        /// </summary>
        private void DrawEligibleCards(Round2StateView round2, GameSessionView session)
        {
            GUILayout.Label("Eligible Bacchanal: Double It only");

            var shared = _game?.shared;
            if (shared?.cardWindow != null && shared.cardWindow.open)
            {
                var previous = GUI.color;
                GUI.color = Color.cyan;
                GUILayout.Label("Card window OPEN");
                GUI.color = previous;
            }

            // A resolved Clash names the card that survived, so a DOUBLE_IT in
            // force is visible here before the award lands — which is what lets
            // a Host explain 1,000 BB rather than be surprised by it.
            //
            // Read from the Clash rather than from per-team advantage usage: the
            // Host view exposes no usage map (a TypeScript Record has no
            // JsonUtility equivalent), and the Clash result is the authoritative
            // record of the card having taken effect anyway.
            var clash = shared?.clash;
            if (clash?.result != null && clash.result.winningCardType == "DOUBLE_IT")
            {
                var previous = GUI.color;
                GUI.color = Color.yellow;
                GUILayout.Label($"DOUBLE IT active — {clash.result.winningTeamId}");
                GUI.color = previous;
            }
        }

        /// <summary>Results so far: who won each game, and what was paid.</summary>
        private void DrawRound2Results(Round2StateView round2)
        {
            if (round2.resolvedCount == 0) return;

            GUILayout.Label("RESULTS", HeaderStyle);
            foreach (var challenge in round2.challenges)
            {
                if (!challenge.IsResolved) continue;

                var doubled = challenge.doubled ? "  (DOUBLE IT ×2)" : "";
                GUILayout.Label(
                    $"{challenge.displayName}: {challenge.winningTeamId} +{challenge.awardedBb}{doubled}");
            }
        }

        private void DrawRoundComplete(Round2StateView round2)
        {
            var previous = GUI.color;
            GUI.color = Color.green;
            GUILayout.Label("ROUND 2 COMPLETE", HeaderStyle);
            GUI.color = previous;

            GUILayout.Label($"All {round2.challenges.Length} challenges resolved.");
            GUILayout.Space(4);
            // Phase 7A §18 — the round stops here. Round 3 is not this phase's.
            GUILayout.Label("Round 3 is not implemented yet.");
        }

        /// <summary>A team's display name, falling back to its id.</summary>
        private static string TeamLabel(HostGameSnapshot game, string teamId)
        {
            var teams = game.teams ?? Array.Empty<GameTeamView>();
            foreach (var team in teams)
            {
                if (team.teamId == teamId) return team.displayName;
            }
            return teamId;
        }
    }
}

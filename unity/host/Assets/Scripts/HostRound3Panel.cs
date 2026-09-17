using System;
using UnityEngine;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal
{
    /// <summary>
    /// ==================== ROUND 3 ====================
    ///
    /// Phase 7B spec §32. The Host presentation for the four Round 3
    /// challenges, the challenge-win counter and the rock-paper-scissors
    /// tiebreaker.
    ///
    /// Functional, not finished — Phase 8 does the theatre.
    ///
    /// ============ THE CONTROLS CHANGE BY CHALLENGE ============
    /// Round 3's four challenges are not interchangeable the way Round 2's
    /// were, so this panel branches on the challenge's FORMAT rather than its
    /// name:
    ///
    ///   elimination (Think Fast) -> VALID / OUT, and whose turn it is
    ///   points (the other three) -> award a point, NEXT item
    ///
    /// Branching on format rather than on `challengeType` means a future
    /// challenge of either shape needs no new UI.
    /// ==========================================================
    ///
    /// It computes nothing. The scores, the counter, the BB and the RPS result
    /// all arrive from the server; every button sends an intent and redraws.
    ///
    /// THE HOST NEVER TYPES CONTENT. §13 — the game supplies the topic, the
    /// logo, the letter and the song scenario. NEXT ITEM asks the server for
    /// the next one; there is no text field here, deliberately.
    /// </summary>
    public partial class HostLobby
    {
        private Vector2 _round3Scroll;

        private void DrawRound3Panel(LobbySnapshot snapshot, HostGameSnapshot game)
        {
            GUILayout.BeginVertical(GUILayout.Width(380));

            GUILayout.Label("ROUND 3", HeaderStyle);

            if (game == null || !game.GameRunning || game.game == null)
            {
                GUILayout.Label("No game running.");
                GUILayout.EndVertical();
                return;
            }

            var session = game.game;
            var round3 = session.round3;

            // `round3 != null` is NOT a null check: JsonUtility turns a JSON
            // null into an empty object, so every other round arrives as a
            // non-null Round3StateView with no challenges.
            if (round3 == null || !round3.Exists)
            {
                DrawRound3Entry(session, game);
                GUILayout.EndVertical();
                return;
            }

            _round3Scroll = GUILayout.BeginScrollView(_round3Scroll, GUILayout.Height(560));

            DrawRound3Progress(round3);
            GUILayout.Space(6);
            DrawChallengeWins(round3, game);
            GUILayout.Space(8);

            var tiebreaker = round3.Tiebreaker;
            if (tiebreaker != null)
            {
                DrawTiebreaker(tiebreaker, game);
            }
            else if (round3.complete)
            {
                DrawRound3Complete(round3, game);
            }
            else
            {
                DrawCurrentChallenge(session, game, round3);
            }

            GUILayout.EndScrollView();
            GUILayout.EndVertical();
        }

        private void DrawRound3Entry(GameSessionView session, HostGameSnapshot game)
        {
            GUILayout.Label("Round 3 has not started.");

            if (!game.devToolsEnabled)
            {
                GUILayout.Label("Development tools are disabled, so");
                GUILayout.Label("there is no way in from here yet.");
                return;
            }

            GUILayout.Label($"Currently: {session.phase}, round {session.roundIndex}.");
            GUILayout.Space(6);

            GUI.enabled = !_busy && !session.paused;
            if (GUILayout.Button("[DEV] START ROUND 3", GUILayout.Height(44)))
            {
                _ = SubmitGameIntentAsync(Round3Intents.DevStartRound3, "{}");
            }
            GUI.enabled = true;

            GUILayout.Space(4);
            GUILayout.Label("Development only. Walks the real phases");
            GUILayout.Label("to Round 3. Not a production rule.");
        }

        private void DrawRound3Progress(Round3StateView round3)
        {
            GUILayout.Label(
                $"Challenge {Math.Min(round3.resolvedCount + 1, round3.challenges.Length)} of {round3.challenges.Length}");

            foreach (var challenge in round3.challenges)
            {
                var previous = GUI.color;
                if (challenge.IsResolved) GUI.color = Color.green;
                else if (challenge.IsInProgress) GUI.color = Color.cyan;
                else GUI.color = Color.grey;

                var marker = challenge.IsResolved ? "✓" : challenge.IsInProgress ? "▶" : "·";
                var winner = challenge.IsResolved && !string.IsNullOrEmpty(challenge.winningTeamId)
                    ? $"  → {challenge.winningTeamId}"
                    : "";
                GUILayout.Label($"{marker} {challenge.displayName}{winner}");
                GUI.color = previous;
            }
        }

        /// <summary>
        /// The counter that decides the round.
        ///
        /// Labelled "wins", never BB — §13 keeps them separate and so does this
        /// display, because collapsing them on screen is how a Host comes to
        /// believe five logos are worth five of something.
        /// </summary>
        private void DrawChallengeWins(Round3StateView round3, HostGameSnapshot game)
        {
            GUILayout.Label("ROUND 3 WINS (not BB)");
            foreach (var teamId in round3.participatingTeamIds ?? Array.Empty<string>())
            {
                GUILayout.Label($"  {TeamLabel(game, teamId)}: {round3.WinsOf(teamId)}");
            }
        }

        private void DrawCurrentChallenge(
            GameSessionView session,
            HostGameSnapshot game,
            Round3StateView round3)
        {
            var current = round3.Current;
            if (current == null)
            {
                GUILayout.Label("No current challenge.");
                return;
            }

            GUILayout.Label(current.displayName.ToUpperInvariant(), HeaderStyle);

            // --- Prepare and start ------------------------------------------
            if (!current.IsInProgress)
            {
                GUI.enabled = !_busy && !session.paused && session.phase != "CHALLENGE_INTRO";
                if (GUILayout.Button("1. Go to CHALLENGE INTRO", GUILayout.Height(30)))
                {
                    _ = SubmitGameIntentAsync(GameIntents.AdvancePhase, "{\"to\":\"CHALLENGE_INTRO\"}");
                }

                GUI.enabled = !_busy && !session.paused && session.phase == "CHALLENGE_INTRO";
                if (GUILayout.Button($"2. PREPARE {current.displayName}", GUILayout.Height(34)))
                {
                    _ = SubmitGameIntentAsync(Round3Intents.PrepareChallenge, "{}");
                }
                GUI.enabled = true;
                return;
            }

            GUI.enabled = !_busy && !session.paused && session.phase == "CHALLENGE_INTRO";
            if (GUILayout.Button("3. BEGIN CHALLENGE", GUILayout.Height(34)))
            {
                _ = SubmitGameIntentAsync(GameIntents.StartChallenge, "{}");
            }
            GUI.enabled = true;

            GUILayout.Space(6);
            DrawCurrentItem(current, session);
            GUILayout.Space(8);

            // The controls that differ by format.
            if (current.IsElimination) DrawThinkFastControls(current, session, game);
            else DrawPointsControls(current, session, game, round3);

            GUILayout.Space(10);
            DrawConfirmChallenge(current, session, game, round3);
        }

        /// <summary>The game-supplied item, and the button that asks for the next.</summary>
        private void DrawCurrentItem(Round3ChallengeView current, GameSessionView session)
        {
            var item = current.currentItem;
            if (item != null && item.Exists)
            {
                if (item.HasLetter)
                {
                    var previous = GUI.color;
                    GUI.color = Color.cyan;
                    GUILayout.Label($"LETTER: {item.letter}", HeaderStyle);
                    GUI.color = previous;
                }
                GUILayout.Label($"#{item.index}  {item.body}");
                if (item.HasImage) GUILayout.Label($"  image: {item.imageRef}");
                if (item.remainingMs > 0) GUILayout.Label($"  {item.remainingMs / 1000}s left");
            }
            else
            {
                GUILayout.Label("No item revealed yet.");
            }

            // §14 — Think Fast has ONE topic, revealed automatically when the
            // challenge starts. Offering NEXT there would replace the topic
            // teams are mid-way through answering, and the server refuses it.
            if (!current.UsesItemStream)
            {
                GUILayout.Label("One topic for the whole challenge.");
                return;
            }

            GUI.enabled = !_busy && !session.paused && session.phase == "ACTIVE_PLAY";
            // NO TEXT FIELD. §13 — the game supplies the content; this asks the
            // server for the next item rather than letting the Host invent one.
            if (GUILayout.Button("NEXT ITEM", GUILayout.Height(34)))
            {
                _ = SubmitGameIntentAsync(Round3Intents.NextItem, "{}");
            }
            GUI.enabled = true;
        }

        /// <summary>Think Fast: whose turn, and the two judgments. §14.</summary>
        private void DrawThinkFastControls(
            Round3ChallengeView current,
            GameSessionView session,
            HostGameSnapshot game)
        {
            var tf = current.thinkFast;
            if (tf == null || !tf.Exists)
            {
                GUILayout.Label("Think Fast has not started.");
                return;
            }

            GUILayout.Label("TURN ORDER (previous round standings)");
            foreach (var teamId in tf.turnOrder)
            {
                var isOut = Array.IndexOf(tf.eliminatedTeamIds ?? Array.Empty<string>(), teamId) >= 0;
                var isCurrent = tf.currentTeamId == teamId;
                var previous = GUI.color;
                if (isOut) GUI.color = Color.grey;
                else if (isCurrent) GUI.color = Color.cyan;
                GUILayout.Label($"  {(isCurrent ? "▶ " : "  ")}{TeamLabel(game, teamId)}{(isOut ? "  (out)" : "")}");
                GUI.color = previous;
            }

            GUILayout.Space(6);
            if (tf.HasCurrentTeam)
            {
                GUILayout.Label($"Answering: {TeamLabel(game, tf.currentTeamId)}");
            }

            GUI.enabled = !_busy && !session.paused && tf.HasCurrentTeam;
            if (GUILayout.Button("VALID — next team", GUILayout.Height(36)))
            {
                _ = SubmitGameIntentAsync(Round3Intents.ThinkFastValid, "{}");
            }
            if (GUILayout.Button("CANNOT ANSWER — out", GUILayout.Height(36)))
            {
                _ = SubmitGameIntentAsync(Round3Intents.ThinkFastEliminate, "{}");
            }
            GUI.enabled = true;
        }

        /// <summary>The three points-scored challenges. §15-§17.</summary>
        private void DrawPointsControls(
            Round3ChallengeView current,
            GameSessionView session,
            HostGameSnapshot game,
            Round3StateView round3)
        {
            GUILayout.Label($"SCORE (target {current.targetScore})");
            foreach (var teamId in round3.participatingTeamIds ?? Array.Empty<string>())
            {
                GUILayout.Label($"  {TeamLabel(game, teamId)}: {current.ScoreOf(teamId)}");
            }

            if (current.targetReached)
            {
                var previous = GUI.color;
                GUI.color = Color.yellow;
                GUILayout.Label("Target reached — confirm when ready.");
                GUI.color = previous;
            }

            GUILayout.Space(4);
            GUILayout.Label("AWARD A POINT");
            GUI.enabled = !_busy && !session.paused;
            foreach (var teamId in round3.participatingTeamIds ?? Array.Empty<string>())
            {
                if (GUILayout.Button($"+1  {TeamLabel(game, teamId)}", GUILayout.Height(32)))
                {
                    _ = SubmitGameIntentAsync(
                        Round3Intents.AwardPoint,
                        $"{{\"teamId\":\"{teamId}\"}}");
                }
            }
            GUI.enabled = true;
        }

        /// <summary>
        /// Confirming the challenge winner.
        ///
        /// Required even when a team has reached the target — §15-§17 give the
        /// Host discretion to end a challenge earlier or later, so a score never
        /// resolves anything on its own.
        /// </summary>
        private void DrawConfirmChallenge(
            Round3ChallengeView current,
            GameSessionView session,
            HostGameSnapshot game,
            Round3StateView round3)
        {
            GUILayout.Label("CONFIRM CHALLENGE WINNER", HeaderStyle);
            GUILayout.Label("The Host decides when this challenge ends.");

            GUI.enabled = !_busy && !session.paused && current.IsInProgress;
            foreach (var teamId in round3.participatingTeamIds ?? Array.Empty<string>())
            {
                // Think Fast: an eliminated team cannot be the winner.
                var eliminated =
                    current.IsElimination
                    && current.thinkFast != null
                    && Array.IndexOf(current.thinkFast.eliminatedTeamIds ?? Array.Empty<string>(), teamId) >= 0;
                if (eliminated) continue;

                if (GUILayout.Button($"★ {TeamLabel(game, teamId)} WINS", GUILayout.Height(40)))
                {
                    _ = SubmitGameIntentAsync(
                        Round3Intents.ConfirmChallenge,
                        $"{{\"teamId\":\"{teamId}\"}}");
                }
            }
            GUI.enabled = true;
        }

        /// <summary>
        /// The rock-paper-scissors tiebreaker. §18.
        ///
        /// THE HOST HAS NO BUTTONS HERE. The teams choose on their phones, the
        /// server reveals when both are in, and this display reports. A Host
        /// control would be a way to reveal early, which §18 forbids.
        /// </summary>
        private void DrawTiebreaker(RpsTiebreakerView tiebreaker, HostGameSnapshot game)
        {
            var previous = GUI.color;
            GUI.color = Color.yellow;
            GUILayout.Label("ROUND 3 TIED — ROCK PAPER SCISSORS", HeaderStyle);
            GUI.color = previous;

            GUILayout.Label("Not a Bacchanal Clash. No cards involved.");
            GUILayout.Space(4);

            var tied = string.Join(" vs ", Array.ConvertAll(
                tiebreaker.tiedTeamIds ?? Array.Empty<string>(), id => TeamLabel(game, id)));
            GUILayout.Label($"Tied: {tied}");

            var current = tiebreaker.current;
            if (current != null && current.Exists && !current.resolved)
            {
                GUILayout.Space(4);
                GUILayout.Label($"Attempt #{current.attemptNumber}");
                foreach (var teamId in current.participatingTeamIds ?? Array.Empty<string>())
                {
                    var chosen =
                        Array.IndexOf(current.submittedTeamIds ?? Array.Empty<string>(), teamId) >= 0;
                    // WHO has chosen, never WHAT. The Host sees no choice before
                    // the reveal either — §18.
                    GUILayout.Label($"  {TeamLabel(game, teamId)}: {(chosen ? "chosen" : "waiting…")}");
                }
            }

            foreach (var past in tiebreaker.history ?? Array.Empty<RpsAttemptView>())
            {
                var line = $"#{past.attemptNumber}: ";
                foreach (var entry in past.revealedChoices ?? Array.Empty<Round3TeamChoice>())
                {
                    line += $"{TeamLabel(game, entry.teamId)} {entry.choice}  ";
                }
                GUILayout.Label($"{line}— {past.explanation}");
            }

            if (tiebreaker.complete && !string.IsNullOrEmpty(tiebreaker.winningTeamId))
            {
                GUI.color = Color.green;
                GUILayout.Label($"{TeamLabel(game, tiebreaker.winningTeamId)} WINS ROUND 3", HeaderStyle);
                GUI.color = previous;
            }
        }

        private void DrawRound3Complete(Round3StateView round3, HostGameSnapshot game)
        {
            var previous = GUI.color;
            GUI.color = Color.green;
            GUILayout.Label("ROUND 3 COMPLETE", HeaderStyle);
            GUI.color = previous;

            if (round3.HasWinner)
            {
                GUILayout.Label($"Winner: {TeamLabel(game, round3.winningTeamId)}");
            }
            GUILayout.Space(4);
            GUILayout.Label("Round 4 is not implemented yet.");
        }
    }
}

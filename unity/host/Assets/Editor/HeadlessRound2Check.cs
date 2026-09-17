using System;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using BrainsAndBacchanal.Net;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Headless end-to-end check of ROUND 2 — DEVELOPMENT ONLY. Phase 7A §37.
    ///
    /// Runs the SAME WebSocket client and the SAME C# DTOs the Host scene uses,
    /// against the real running production game server, in batch mode.
    ///
    /// ================== WHY THIS IS NOT OPTIONAL ==================
    /// Phase 6 found a real bug this way, and the spec cites it: "in-process
    /// tests passed while the serialized client view was wrong."
    ///
    /// JsonUtility FAILS QUIETLY. A C# field that does not match the server's
    /// JSON deserialises to zero, null or "" rather than throwing. So a drift
    /// in <c>Round2StateView</c> or <c>Round2ChallengeView</c> would appear on a
    /// TV, in front of a room of people, as:
    ///
    ///   - a blank challenge name where "BOTTLE BATTLE" should be,
    ///   - "0 BB" for a 500 BB award,
    ///   - a CONFIRM button that never enables because the pending winner
    ///     deserialised to null.
    ///
    /// None of those raise an error anywhere. The only way to catch them is to
    /// read real server JSON through the real DTOs and assert the values, which
    /// is what this does.
    /// ==============================================================
    ///
    /// It asserts the six things §37 names: the current challenge, the
    /// Host-selectable teams, the result, the BB update, the Double It result
    /// and round completion.
    ///
    /// Invoked with:
    ///   Unity.exe -batchmode -quit -nographics -projectPath unity/host \
    ///     -executeMethod BrainsAndBacchanal.EditorTools.HeadlessRound2Check.Run
    ///
    /// Server host/port come from BB_SERVER_HOST / BB_SERVER_PORT. THE SERVER
    /// MUST RUN WITH DEVELOPMENT TOOLS ENABLED: Round 1 does not exist, so the
    /// only way into Round 2 is DEV_START_ROUND2.
    /// </summary>
    public static class HeadlessRound2Check
    {
        private static int _checks;
        private static int _failures;

        public static void Run()
        {
            var host = Environment.GetEnvironmentVariable("BB_SERVER_HOST");
            if (string.IsNullOrEmpty(host)) host = "127.0.0.1";

            var portText = Environment.GetEnvironmentVariable("BB_SERVER_PORT");
            if (!int.TryParse(portText, out var port)) port = 4000;

            try
            {
                // Task.Run + ConfigureAwait(false) throughout — see
                // HeadlessEngineCheck's header comment for why.
                Task.Run(() => RunAsync(host, port)).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                Fail("unhandled exception: " + ex);
            }

            Debug.Log($"[BBROUND2] SUMMARY checks={_checks} failures={_failures}");
            EditorApplication.Exit(_failures == 0 ? 0 : 1);
        }

        private static async Task RunAsync(string host, int port)
        {
            var url = $"ws://{host}:{port}/room/ws";
            Debug.Log($"[BBROUND2] connecting to {url}");

            // ---- A room, two teams, a started game -----------------------------
            var hostClient = new BenchmarkWebSocketClient { RoomId = "pending" };
            var connected = await hostClient.ConnectAsync(url).ConfigureAwait(false);
            Check("host connects", connected, hostClient.LastError);
            if (!connected) return;

            var createAck = await hostClient.SubmitAsync(RoomIntents.CreateRoom, "{}")
                .ConfigureAwait(false);
            if (createAck == null || !createAck.ok) { Fail("CREATE_ROOM: " + Describe(createAck)); return; }

            var created = JsonUtility.FromJson<RoomCreatedPayload>(createAck.snapshotJson);
            if (created == null) { Fail("room payload did not parse"); return; }
            hostClient.RoomId = created.roomId;

            var p1 = await JoinRound2Player(url, created, "Unity R2 P1").ConfigureAwait(false);
            var p2 = await JoinRound2Player(url, created, "Unity R2 P2").ConfigureAwait(false);
            if (p1 == null || p2 == null) { Fail("players could not join"); return; }

            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p1.PlayerId + "\",\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p2.PlayerId + "\",\"teamId\":\"TEAM_B\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.LockTeams, "{}").ConfigureAwait(false);
            await hostClient.SubmitAsync(GameIntents.StartGame, "{}").ConfigureAwait(false);

            var beforeRound2 = await GameSnapshot(hostClient).ConfigureAwait(false);
            // NOT `round2 == null`: JsonUtility cannot produce a null class field,
            // so a JSON null arrives as an empty object. Round2StateView.Exists is
            // what distinguishes "not in Round 2" from "in Round 2" in C#.
            Check("round2 is absent before Round 2 starts",
                beforeRound2?.game != null
                && (beforeRound2.game.round2 == null || !beforeRound2.game.round2.Exists),
                "round2 was present outside Round 2");

            if (beforeRound2 != null && !beforeRound2.devToolsEnabled)
            {
                Fail("server has development tools DISABLED — Round 2 cannot be entered "
                     + "because Round 1 is not implemented. Start it with dev tools on.");
                return;
            }

            // ---- Enter Round 2 ---------------------------------------------------
            var enterAck = await hostClient.SubmitAsync(Round2Intents.DevStartRound2, "{}")
                .ConfigureAwait(false);
            Check("[DEV] START ROUND 2 accepted", enterAck != null && enterAck.ok, Describe(enterAck));

            var entered = await GameSnapshot(hostClient).ConfigureAwait(false);
            var round2 = entered?.game?.round2;

            // THE CORE DTO CHECK. If Round2StateView drifted, every one of these
            // is zero/null rather than an error.
            Check("round2 deserialises", round2 != null && round2.Exists,
                "round2 was absent after entry");
            if (round2 == null || !round2.Exists) return;

            Check("roundIndex is 2", round2.roundIndex == 2, $"roundIndex={round2.roundIndex}");
            Check("four challenges arrive",
                round2.challenges != null && round2.challenges.Length == 4,
                Describe(round2.challenges));
            Check("challenge order is the locked order",
                round2.challenges != null
                && round2.challenges.Length == 4
                && round2.challenges[0].challengeType == "BOTTLE_BATTLE"
                && round2.challenges[1].challengeType == "MATCH_MAKERS"
                && round2.challenges[2].challengeType == "GRABBERS"
                && round2.challenges[3].challengeType == "BOMBERS",
                "order was not Bottle Battle, Match Makers, Grabbers, Bombers");

            // §37 — "Host-selectable teams". If this is empty the Host UI draws
            // no buttons and the round is unplayable.
            Check("participating teams arrive",
                round2.participatingTeamIds != null && round2.participatingTeamIds.Length == 2,
                Describe(round2.participatingTeamIds));

            Check("card challenge kind is ROUND2_PHYSICAL",
                round2.cardChallengeKind == "ROUND2_PHYSICAL",
                "cardChallengeKind=" + round2.cardChallengeKind);

            // ---- Challenge 1: a normal 500 BB win --------------------------------
            await PrepareAndStart(hostClient).ConfigureAwait(false);

            var running = await GameSnapshot(hostClient).ConfigureAwait(false);
            var current = running?.game?.round2?.Current;

            // §37 — "current challenge". The single most visible field: this is
            // what the TV shows.
            Check("current challenge arrives", current != null, "current was null");
            Check("current challenge is Bottle Battle",
                current?.challengeType == "BOTTLE_BATTLE",
                "challengeType=" + current?.challengeType);
            Check("display name arrives from the server",
                current?.displayName == "Bottle Battle",
                "displayName='" + current?.displayName + "'");
            Check("base reward is 500",
                current != null && current.baseRewardBb == 500,
                "baseRewardBb=" + current?.baseRewardBb);
            Check("current challenge reports in_progress",
                current != null && current.IsInProgress,
                "progress=" + current?.progress);

            // Selection, step one: no BB moves.
            var bbBefore = BbOf(running, "TEAM_A");
            await hostClient.SubmitAsync(Round2Intents.SelectWinner, "{\"teamId\":\"TEAM_A\"}")
                .ConfigureAwait(false);

            var selected = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("pending winner arrives — the CONFIRM button depends on it",
                selected?.game?.round2 != null && selected.game.round2.HasPendingWinner
                && selected.game.round2.pendingWinnerTeamId == "TEAM_A",
                "pendingWinnerTeamId=" + selected?.game?.round2?.pendingWinnerTeamId);
            Check("selection alone pays nothing",
                BbOf(selected, "TEAM_A") == bbBefore,
                "before=" + bbBefore + " after=" + BbOf(selected, "TEAM_A"));

            // Confirmation, step two: this pays.
            var confirmAck = await hostClient.SubmitAsync(Round2Intents.ConfirmResult, "{}")
                .ConfigureAwait(false);
            Check("result confirmed", confirmAck != null && confirmAck.ok, Describe(confirmAck));

            var resolved = await GameSnapshot(hostClient).ConfigureAwait(false);
            var first = resolved?.game?.round2?.challenges?[0];

            // §37 — "result" and "BB update".
            Check("resolved challenge reports its winner",
                first != null && first.IsResolved && first.winningTeamId == "TEAM_A",
                $"progress={first?.progress} winner={first?.winningTeamId}");
            Check("awarded BB arrives as 500",
                first != null && first.awardedBb == 500,
                "awardedBb=" + first?.awardedBb);
            Check("the team balance moved by 500",
                BbOf(resolved, "TEAM_A") == bbBefore + 500,
                "before=" + bbBefore + " after=" + BbOf(resolved, "TEAM_A"));
            Check("pending winner is cleared after confirming",
                resolved?.game?.round2 != null && !resolved.game.round2.HasPendingWinner,
                "pendingWinnerTeamId=" + resolved?.game?.round2?.pendingWinnerTeamId);
            Check("resolvedCount is 1", resolved?.game?.round2?.resolvedCount == 1,
                "resolvedCount=" + resolved?.game?.round2?.resolvedCount);

            // A second confirmation must not pay again (§14).
            var again = await hostClient.SubmitAsync(Round2Intents.ConfirmResult,
                "{\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            Check("a second confirmation is refused", again != null && !again.ok, Describe(again));
            var afterDuplicate = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("no BB was paid twice",
                BbOf(afterDuplicate, "TEAM_A") == bbBefore + 500,
                "bb=" + BbOf(afterDuplicate, "TEAM_A"));

            // A phone must not be able to select a winner (§13, §30).
            var phoneAttempt = await p1.Client.SubmitAsync(
                Round2Intents.SelectWinner, "{\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            Check("a phone cannot select the winner",
                phoneAttempt != null && !phoneAttempt.ok, Describe(phoneAttempt));

            // ---- Challenge 2: with Double It, over the wire ----------------------
            await PrepareAndStart(hostClient).ConfigureAwait(false);
            await hostClient.SubmitAsync(SharedIntents.DealBacchanalCards, "{}").ConfigureAwait(false);

            var doubleCardId = await FindDoubleIt(hostClient, p1.Client).ConfigureAwait(false);
            if (string.IsNullOrEmpty(doubleCardId))
            {
                Fail("no deal produced a DOUBLE_IT for Team A after many redeals");
            }
            else
            {
                await hostClient.SubmitAsync(SharedIntents.OpenCardWindow,
                    "{\"challengeKind\":\"ROUND2_PHYSICAL\"}").ConfigureAwait(false);

                var playAck = await p1.Client.SubmitAsync(SharedIntents.PlayBacchanalCard,
                    "{\"cardInstanceId\":\"" + doubleCardId + "\"}").ConfigureAwait(false);
                Check("Double It is accepted in a Round 2 window",
                    playAck != null && playAck.ok, Describe(playAck));

                // Round 2 permits no counter card, so the Clash resolves as soon
                // as the server sees nobody can respond. Poll rather than sleep a
                // fixed 6 seconds: the window is the server's business, and the
                // snapshot is the only thing that says it is done.
                await WaitForClashResolution(hostClient).ConfigureAwait(false);

                var bbBeforeDouble = BbOf(await GameSnapshot(hostClient).ConfigureAwait(false), "TEAM_A");

                await hostClient.SubmitAsync(Round2Intents.SelectWinner, "{\"teamId\":\"TEAM_A\"}")
                    .ConfigureAwait(false);
                await hostClient.SubmitAsync(Round2Intents.ConfirmResult, "{}").ConfigureAwait(false);

                var doubledSnap = await GameSnapshot(hostClient).ConfigureAwait(false);
                var second = doubledSnap?.game?.round2?.challenges?[1];

                // §37 — "Double It result". 1,000 is the SERVER's arithmetic;
                // Unity multiplies nothing.
                Check("doubled award arrives as 1,000",
                    second != null && second.awardedBb == 1000,
                    "awardedBb=" + second?.awardedBb);
                Check("the doubled flag arrives true",
                    second != null && second.doubled,
                    "doubled=" + second?.doubled);
                Check("the balance moved by 1,000",
                    BbOf(doubledSnap, "TEAM_A") == bbBeforeDouble + 1000,
                    "before=" + bbBeforeDouble + " after=" + BbOf(doubledSnap, "TEAM_A"));
            }

            // ---- Challenges 3 and 4, then completion -----------------------------
            await PlayChallenge(hostClient, "TEAM_B").ConfigureAwait(false);
            await PlayChallenge(hostClient, "TEAM_B").ConfigureAwait(false);

            var complete = await GameSnapshot(hostClient).ConfigureAwait(false);
            var finalRound = complete?.game?.round2;

            // §37 — "round completion".
            Check("round reports complete after four challenges",
                finalRound != null && finalRound.complete,
                "complete=" + finalRound?.complete);
            Check("resolvedCount is 4", finalRound?.resolvedCount == 4,
                "resolvedCount=" + finalRound?.resolvedCount);
            Check("current is absent once the round is complete",
                finalRound != null && finalRound.Current == null,
                "current was still present");

            // No fifth challenge (§18, §29).
            await hostClient.SubmitAsync(GameIntents.AdvancePhase, "{\"to\":\"CHALLENGE_INTRO\"}")
                .ConfigureAwait(false);
            var fifth = await hostClient.SubmitAsync(Round2Intents.PrepareChallenge, "{}")
                .ConfigureAwait(false);
            Check("a fifth physical challenge is refused",
                fifth != null && !fifth.ok, Describe(fifth));

            // ---- The Host reconnects (§24) ---------------------------------------
            var returning = new BenchmarkWebSocketClient { RoomId = created.roomId };
            if (await returning.ConnectAsync(url).ConfigureAwait(false))
            {
                var reAck = await returning.SubmitAsync(RoomIntents.ReconnectHost,
                    "{\"hostToken\":\"" + created.hostToken + "\"}").ConfigureAwait(false);
                Check("Host reconnects", reAck != null && reAck.ok, Describe(reAck));

                var restored = await GameSnapshot(returning).ConfigureAwait(false);
                Check("Round 2 is restored to the reconnecting Host",
                    restored?.game?.round2 != null
                    && restored.game.round2.complete
                    && restored.game.round2.resolvedCount == 4,
                    "round2 did not survive the Host reconnect");
                Check("no winner was reselected on reconnect",
                    restored?.game?.round2 != null && !restored.game.round2.HasPendingWinner,
                    "pendingWinnerTeamId=" + restored?.game?.round2?.pendingWinnerTeamId);

                await returning.DisconnectAsync().ConfigureAwait(false);
            }

            await p1.Client.DisconnectAsync().ConfigureAwait(false);
            await p2.Client.DisconnectAsync().ConfigureAwait(false);
            await hostClient.DisconnectAsync().ConfigureAwait(false);
        }

        // -------------------------------------------------------------------
        // Helpers
        // -------------------------------------------------------------------

        /// <summary>Advance to CHALLENGE_INTRO, prepare the next game, start it.</summary>
        private static async Task PrepareAndStart(BenchmarkWebSocketClient hostClient)
        {
            await hostClient.SubmitAsync(GameIntents.AdvancePhase, "{\"to\":\"CHALLENGE_INTRO\"}")
                .ConfigureAwait(false);
            await hostClient.SubmitAsync(Round2Intents.PrepareChallenge, "{}").ConfigureAwait(false);
            await hostClient.SubmitAsync(GameIntents.StartChallenge, "{}").ConfigureAwait(false);
        }

        private static async Task PlayChallenge(BenchmarkWebSocketClient hostClient, string teamId)
        {
            await PrepareAndStart(hostClient).ConfigureAwait(false);
            await hostClient.SubmitAsync(Round2Intents.SelectWinner,
                "{\"teamId\":\"" + teamId + "\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(Round2Intents.ConfirmResult, "{}").ConfigureAwait(false);
        }

        /// <summary>
        /// Redeal until Team A holds a DOUBLE_IT, and return its instance id.
        ///
        /// The development redeal exists for exactly this: a random starting
        /// deal will not reliably hand the team under test the one card Round 2
        /// permits. Everything still goes through real intents.
        /// </summary>
        private static async Task<string> FindDoubleIt(
            BenchmarkWebSocketClient hostClient, BenchmarkWebSocketClient phone)
        {
            for (var attempt = 0; attempt < 200; attempt++)
            {
                var snap = await PlayerGameSnapshot(phone).ConfigureAwait(false);
                foreach (var card in snap?.shared?.yourHand ?? Array.Empty<OwnCardView>())
                {
                    if (card.cardType == "DOUBLE_IT") return card.cardInstanceId;
                }
                await hostClient.SubmitAsync(SharedIntents.DevRedealBacchanalCards, "{}")
                    .ConfigureAwait(false);
            }
            return null;
        }

        /// <summary>
        /// Wait until the Clash has resolved, by asking the server.
        ///
        /// Polled rather than slept: the window length is the server's (D-029
        /// raised it once already), and the snapshot is what actually says the
        /// card took effect. A hard-coded sleep would silently pass if the
        /// window changed again.
        /// </summary>
        private static async Task WaitForClashResolution(BenchmarkWebSocketClient hostClient)
        {
            for (var attempt = 0; attempt < 60; attempt++)
            {
                var snap = await GameSnapshot(hostClient).ConfigureAwait(false);
                var clash = snap?.shared?.clash;
                if (clash == null || clash.resolved) return;
                await Task.Delay(250).ConfigureAwait(false);
            }
            Fail("the Clash never resolved");
        }

        private sealed class Round2Player
        {
            public BenchmarkWebSocketClient Client;
            public string PlayerId;
            public string Token;
        }

        private static async Task<Round2Player> JoinRound2Player(
            string url, RoomCreatedPayload room, string name)
        {
            var client = new BenchmarkWebSocketClient { RoomId = "pending" };
            if (!await client.ConnectAsync(url).ConfigureAwait(false)) return null;

            var ack = await client.SubmitAsync(RoomIntents2.JoinRoom,
                "{\"roomCode\":\"" + room.roomCode + "\",\"displayName\":\"" + name + "\"}")
                .ConfigureAwait(false);
            if (ack == null || !ack.ok) return null;

            var joined = JsonUtility.FromJson<JoinAcceptedPayload>(ack.snapshotJson);
            if (joined == null) return null;

            client.RoomId = room.roomId;
            return new Round2Player
            {
                Client = client,
                PlayerId = joined.playerId,
                Token = joined.reconnectToken,
            };
        }

        private static async Task<HostGameSnapshot> GameSnapshot(BenchmarkWebSocketClient client)
        {
            var ack = await client.SubmitAsync(GameIntents.RequestGameSnapshot, "{}")
                .ConfigureAwait(false);
            if (ack == null || !ack.ok || string.IsNullOrEmpty(ack.snapshotJson)) return null;
            return JsonUtility.FromJson<HostGameSnapshot>(ack.snapshotJson);
        }

        private static async Task<PlayerGameSnapshot> PlayerGameSnapshot(
            BenchmarkWebSocketClient client)
        {
            var ack = await client.SubmitAsync(GameIntents.RequestGameSnapshot, "{}")
                .ConfigureAwait(false);
            if (ack == null || !ack.ok || string.IsNullOrEmpty(ack.snapshotJson)) return null;
            return JsonUtility.FromJson<PlayerGameSnapshot>(ack.snapshotJson);
        }

        private static int BbOf(HostGameSnapshot snapshot, string teamId)
        {
            foreach (var team in snapshot?.teams ?? Array.Empty<GameTeamView>())
            {
                if (team.teamId == teamId) return team.bb;
            }
            return -1;
        }

        private static string Describe(IntentAck ack)
        {
            if (ack == null) return "null ack";
            return ack.ok ? "ok" : $"{ack.error?.code}: {ack.error?.message}";
        }

        private static string Describe<T>(T[] array)
        {
            return array == null ? "null" : $"length={array.Length}";
        }

        private static void Check(string label, bool passed, string detail)
        {
            _checks++;
            if (passed)
            {
                Debug.Log($"[BBROUND2] PASS {label}");
            }
            else
            {
                _failures++;
                Debug.Log($"[BBROUND2] FAIL {label} — {detail}");
            }
        }

        private static void Fail(string message)
        {
            _checks++;
            _failures++;
            Debug.Log($"[BBROUND2] FAIL {message}");
        }
    }
}

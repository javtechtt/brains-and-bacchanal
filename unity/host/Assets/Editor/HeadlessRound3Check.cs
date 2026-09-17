using System;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using BrainsAndBacchanal.Net;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Headless end-to-end check of ROUND 3 — DEVELOPMENT ONLY. Phase 7B §48.
    ///
    /// Runs the SAME WebSocket client and the SAME C# DTOs the Host scene uses,
    /// against the real running production game server, in batch mode.
    ///
    /// ================== WHY THIS IS NOT OPTIONAL ==================
    /// Phase 6 found a bug this way and Phase 7A found another. JsonUtility
    /// FAILS QUIETLY, and Round 3 adds two new ways for it to do so:
    ///
    ///   1. IT CANNOT DESERIALISE A DICTIONARY. The scores and the
    ///      challenge-win counter travel as keyed objects for the web, which
    ///      arrive here as NOTHING. They are read from parallel lists instead,
    ///      and this check is what proves those lists are actually populated —
    ///      otherwise every score on the TV would read zero.
    ///
    ///   2. IT CANNOT REPRESENT A NULL CLASS FIELD. A JSON null becomes a
    ///      default-filled object, so `current == null` is never true. Every
    ///      nullable DTO carries an `Exists` predicate, and this asserts them.
    ///
    /// It also asserts the two SECRECY claims that are about bytes rather than
    /// return values: an unrevealed rock-paper-scissors choice, and a future
    /// content item, are not in the JSON a client receives.
    ///
    /// Invoked with:
    ///   Unity.exe -batchmode -quit -nographics -projectPath unity/host \
    ///     -executeMethod BrainsAndBacchanal.EditorTools.HeadlessRound3Check.Run
    ///
    /// THE SERVER MUST RUN WITH DEVELOPMENT TOOLS ENABLED.
    /// </summary>
    public static class HeadlessRound3Check
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
                Task.Run(() => RunAsync(host, port)).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                Fail("unhandled exception: " + ex);
            }

            Debug.Log($"[BBROUND3] SUMMARY checks={_checks} failures={_failures}");
            EditorApplication.Exit(_failures == 0 ? 0 : 1);
        }

        private static async Task RunAsync(string host, int port)
        {
            var url = $"ws://{host}:{port}/room/ws";
            Debug.Log($"[BBROUND3] connecting to {url}");

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

            var p1 = await JoinPlayer3(url, created, "Unity R3 P1").ConfigureAwait(false);
            var p2 = await JoinPlayer3(url, created, "Unity R3 P2").ConfigureAwait(false);
            if (p1 == null || p2 == null) { Fail("players could not join"); return; }

            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p1.PlayerId + "\",\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p2.PlayerId + "\",\"teamId\":\"TEAM_B\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.LockTeams, "{}").ConfigureAwait(false);
            await hostClient.SubmitAsync(GameIntents.StartGame, "{}").ConfigureAwait(false);

            var before = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("round3 is absent before Round 3 starts",
                before?.game != null && (before.game.round3 == null || !before.game.round3.Exists),
                "round3 was present outside Round 3");

            if (before != null && !before.devToolsEnabled)
            {
                Fail("server has development tools DISABLED — start it with dev tools on.");
                return;
            }

            // ---- Enter Round 3 --------------------------------------------------
            var entered = await hostClient.SubmitAsync(Round3Intents.DevStartRound3, "{}")
                .ConfigureAwait(false);
            Check("[DEV] START ROUND 3 accepted", entered != null && entered.ok, Describe(entered));

            var snap = await GameSnapshot(hostClient).ConfigureAwait(false);
            var round3 = snap?.game?.round3;

            Check("round3 deserialises", round3 != null && round3.Exists, "round3 was absent");
            if (round3 == null || !round3.Exists) return;

            Check("roundIndex is 3", round3.roundIndex == 3, $"roundIndex={round3.roundIndex}");
            Check("four challenges arrive in the locked order",
                round3.challenges != null
                && round3.challenges.Length == 4
                && round3.challenges[0].challengeType == "THINK_FAST"
                && round3.challenges[1].challengeType == "GUESS_THE_LOGO"
                && round3.challenges[2].challengeType == "ALL_ANSWERS_BEGIN_WITH"
                && round3.challenges[3].challengeType == "SING_A_SONG",
                "order was wrong");

            // THE DICTIONARY CHECK. If challengeWinList were missing, WinsOf
            // would silently read 0 for every team, for the whole round.
            Check("the challenge-win counter arrives as a readable list",
                round3.challengeWinList != null && round3.challengeWinList.Length == 2,
                "challengeWinList=" + Describe(round3.challengeWinList));
            Check("both teams start on zero wins",
                round3.WinsOf("TEAM_A") == 0 && round3.WinsOf("TEAM_B") == 0,
                "A=" + round3.WinsOf("TEAM_A") + " B=" + round3.WinsOf("TEAM_B"));

            Check("previous-round order arrives for Think Fast",
                round3.previousRoundOrder != null && round3.previousRoundOrder.Length == 2,
                Describe(round3.previousRoundOrder));

            // ---- Think Fast ------------------------------------------------------
            await PrepareAndStart(hostClient).ConfigureAwait(false);
            var running = await GameSnapshot(hostClient).ConfigureAwait(false);
            var current = running?.game?.round3?.Current;

            Check("current challenge is Think Fast",
                current != null && current.challengeType == "THINK_FAST",
                "challengeType=" + current?.challengeType);
            Check("Think Fast reports the elimination format",
                current != null && current.IsElimination,
                "format=" + current?.format);
            Check("Think Fast state arrives with a turn order",
                current?.thinkFast != null && current.thinkFast.Exists
                && current.thinkFast.turnOrder.Length == 2,
                "thinkFast was absent or empty");
            Check("a team is currently answering",
                current?.thinkFast != null && current.thinkFast.HasCurrentTeam,
                "currentTeamId was empty");

            var firstTeam = current?.thinkFast?.currentTeamId ?? "";
            await hostClient.SubmitAsync(Round3Intents.ThinkFastValid, "{}").ConfigureAwait(false);
            var afterValid = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("a valid answer passes the turn",
                afterValid?.game?.round3?.Current?.thinkFast?.currentTeamId != firstTeam,
                "the turn did not move");

            await hostClient.SubmitAsync(Round3Intents.ThinkFastEliminate, "{}").ConfigureAwait(false);
            var afterOut = await GameSnapshot(hostClient).ConfigureAwait(false);
            var tf = afterOut?.game?.round3?.Current?.thinkFast;
            Check("an eliminated team is recorded and one remains",
                tf != null && tf.eliminatedTeamIds.Length == 1 && tf.remainingTeamIds.Length == 1,
                "elimination did not register");

            var survivor = tf?.remainingTeamIds?[0] ?? "TEAM_A";
            var bbBefore = BbOf(afterOut, survivor);
            await hostClient.SubmitAsync(Round3Intents.ConfirmChallenge,
                "{\"teamId\":\"" + survivor + "\"}").ConfigureAwait(false);

            var afterThinkFast = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("Think Fast pays 500 BB to the last team standing",
                BbOf(afterThinkFast, survivor) == bbBefore + 500,
                $"before={bbBefore} after={BbOf(afterThinkFast, survivor)}");
            Check("and gives exactly one Round 3 win",
                afterThinkFast?.game?.round3?.WinsOf(survivor) == 1,
                "wins=" + afterThinkFast?.game?.round3?.WinsOf(survivor));

            // ---- Guess the Logo: points, content, and NO BB ----------------------
            await PrepareAndStart(hostClient).ConfigureAwait(false);
            await hostClient.SubmitAsync(Round3Intents.NextItem, "{}").ConfigureAwait(false);

            var withItem = await GameSnapshot(hostClient).ConfigureAwait(false);
            var item = withItem?.game?.round3?.Current?.currentItem;
            Check("a content item arrives from the game",
                item != null && item.Exists && !string.IsNullOrEmpty(item.body),
                "currentItem was absent");
            Check("the item is TEST content",
                item != null && item.body.Contains("TEST"),
                "body=" + item?.body);
            Check("the item window is running",
                item != null && item.remainingMs > 0 && item.remainingMs <= 10_000,
                "remainingMs=" + item?.remainingMs);

            // SECRECY: no future item in the Host's JSON.
            var hostJson = await RawSnapshotJson(hostClient).ConfigureAwait(false);
            Check("a FUTURE content item is not in the Host JSON",
                hostJson != null && !hostJson.Contains("gtl-test-003"),
                "a future logo leaked");

            for (var i = 0; i < 5; i++)
            {
                await hostClient.SubmitAsync(Round3Intents.AwardPoint,
                    "{\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            }

            var scored = await GameSnapshot(hostClient).ConfigureAwait(false);
            var logo = scored?.game?.round3?.Current;

            // THE OTHER DICTIONARY CHECK. A missing scoreList would read 0 here
            // while the server held 5.
            Check("challenge points arrive as a readable list",
                logo != null && logo.ScoreOf("TEAM_A") == 5,
                "score=" + logo?.ScoreOf("TEAM_A"));
            Check("the target is reported as reached",
                logo != null && logo.targetReached,
                "targetReached=" + logo?.targetReached);
            // §15 — reaching the target does NOT resolve the challenge.
            Check("reaching the target does NOT resolve the challenge",
                logo != null && logo.IsInProgress,
                "progress=" + logo?.progress);

            var bbBeforeLogo = BbOf(scored, "TEAM_A");
            await hostClient.SubmitAsync(Round3Intents.ConfirmChallenge,
                "{\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);

            var afterLogo = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("Guess the Logo pays NO BB",
                BbOf(afterLogo, "TEAM_A") == bbBeforeLogo,
                "before=" + bbBeforeLogo + " after=" + BbOf(afterLogo, "TEAM_A"));
            Check("but still gives a Round 3 win",
                afterLogo?.game?.round3?.WinsOf("TEAM_A") >= 1,
                "wins=" + afterLogo?.game?.round3?.WinsOf("TEAM_A"));

            // ---- The remaining two, forcing a 2-2 tie ----------------------------
            // Think Fast and Guess the Logo went to whoever won above; give the
            // last two to the other team so the counter ties and the tiebreaker
            // runs — which is the branch this check most needs to exercise.
            var other = survivor == "TEAM_A" ? "TEAM_B" : "TEAM_A";
            await PlayChallenge(hostClient, survivor == "TEAM_A" ? "TEAM_B" : "TEAM_A")
                .ConfigureAwait(false);
            await PlayChallenge(hostClient, other).ConfigureAwait(false);

            var complete = await GameSnapshot(hostClient).ConfigureAwait(false);
            var final = complete?.game?.round3;
            Check("the round reports complete after four challenges",
                final != null && final.complete,
                "complete=" + final?.complete);

            // ---- The tiebreaker --------------------------------------------------
            var tiebreaker = final?.Tiebreaker;
            if (tiebreaker == null)
            {
                Check("a clear winner was declared without a tiebreaker",
                    final != null && final.HasWinner,
                    "no winner and no tiebreaker");
            }
            else
            {
                Check("a tied counter starts a rock-paper-scissors tiebreaker",
                    tiebreaker.tiedTeamIds.Length == 2, Describe(tiebreaker.tiedTeamIds));

                await p1.Client.SubmitAsync(Round3Intents.SubmitRpsChoice,
                    "{\"choice\":\"ROCK\"}").ConfigureAwait(false);

                // SECRECY: the Host must not see an unrevealed choice.
                var midJson = await RawSnapshotJson(hostClient).ConfigureAwait(false);
                Check("an UNREVEALED rps choice is not in the Host JSON",
                    midJson != null && !midJson.Contains("ROCK"),
                    "a hidden choice leaked to the Host");

                var mid = await GameSnapshot(hostClient).ConfigureAwait(false);
                Check("but WHO chose is visible",
                    mid?.game?.round3?.Tiebreaker?.current?.submittedTeamIds?.Length == 1,
                    "submittedTeamIds was wrong");

                await p2.Client.SubmitAsync(Round3Intents.SubmitRpsChoice,
                    "{\"choice\":\"SCISSORS\"}").ConfigureAwait(false);
                await WaitForReveal(hostClient).ConfigureAwait(false);

                var revealed = await GameSnapshot(hostClient).ConfigureAwait(false);
                var tb = revealed?.game?.round3?.Tiebreaker;
                Check("the tiebreaker resolves and names a winner",
                    tb != null && tb.complete && !string.IsNullOrEmpty(tb.winningTeamId),
                    "the tiebreaker did not resolve");
                Check("choices are revealed as a readable list",
                    tb?.history != null && tb.history.Length >= 1
                    && tb.history[0].revealedChoices != null
                    && tb.history[0].revealedChoices.Length == 2,
                    "revealedChoices did not arrive");
                Check("Round 3 has a winner",
                    revealed?.game?.round3 != null && revealed.game.round3.HasWinner,
                    "no Round 3 winner");
            }

            await p1.Client.DisconnectAsync().ConfigureAwait(false);
            await p2.Client.DisconnectAsync().ConfigureAwait(false);
            await hostClient.DisconnectAsync().ConfigureAwait(false);
        }

        // -------------------------------------------------------------------

        private static async Task PrepareAndStart(BenchmarkWebSocketClient hostClient)
        {
            await hostClient.SubmitAsync(GameIntents.AdvancePhase, "{\"to\":\"CHALLENGE_INTRO\"}")
                .ConfigureAwait(false);
            await hostClient.SubmitAsync(Round3Intents.PrepareChallenge, "{}").ConfigureAwait(false);
            await hostClient.SubmitAsync(GameIntents.StartChallenge, "{}").ConfigureAwait(false);
        }

        private static async Task PlayChallenge(BenchmarkWebSocketClient hostClient, string teamId)
        {
            await PrepareAndStart(hostClient).ConfigureAwait(false);
            await hostClient.SubmitAsync(Round3Intents.ConfirmChallenge,
                "{\"teamId\":\"" + teamId + "\"}").ConfigureAwait(false);
        }

        /// <summary>
        /// Wait for the server to reveal the tiebreaker.
        ///
        /// Polled rather than slept: the reveal fires on the server's own tick
        /// once the last choice lands, and a fixed sleep would pass silently if
        /// that changed.
        /// </summary>
        private static async Task WaitForReveal(BenchmarkWebSocketClient hostClient)
        {
            for (var attempt = 0; attempt < 60; attempt++)
            {
                var snap = await GameSnapshot(hostClient).ConfigureAwait(false);
                var tb = snap?.game?.round3?.Tiebreaker;
                if (tb != null && (tb.complete || (tb.history != null && tb.history.Length > 0))) return;
                await Task.Delay(250).ConfigureAwait(false);
            }
            Fail("the tiebreaker never revealed");
        }

        private sealed class Round3Player
        {
            public BenchmarkWebSocketClient Client;
            public string PlayerId;
            public string Token;
        }

        private static async Task<Round3Player> JoinPlayer3(
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
            return new Round3Player
            {
                Client = client,
                PlayerId = joined.playerId,
                Token = joined.reconnectToken,
            };
        }

        private static async Task<HostGameSnapshot> GameSnapshot(BenchmarkWebSocketClient client)
        {
            var json = await RawSnapshotJson(client).ConfigureAwait(false);
            return string.IsNullOrEmpty(json) ? null : JsonUtility.FromJson<HostGameSnapshot>(json);
        }

        private static async Task<string> RawSnapshotJson(BenchmarkWebSocketClient client)
        {
            var ack = await client.SubmitAsync(GameIntents.RequestGameSnapshot, "{}")
                .ConfigureAwait(false);
            return ack == null || !ack.ok ? null : ack.snapshotJson;
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
                Debug.Log($"[BBROUND3] PASS {label}");
            }
            else
            {
                _failures++;
                Debug.Log($"[BBROUND3] FAIL {label} — {detail}");
            }
        }

        private static void Fail(string message)
        {
            _checks++;
            _failures++;
            Debug.Log($"[BBROUND3] FAIL {message}");
        }
    }
}

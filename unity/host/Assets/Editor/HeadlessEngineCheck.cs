using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using BrainsAndBacchanal.Net;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Headless end-to-end check of the Phase 5 game engine — DEVELOPMENT ONLY.
    ///
    /// Runs the SAME WebSocket client and the SAME C# DTOs the Host scene uses,
    /// against the real running production game server, in batch mode.
    ///
    /// It exists because compiling proves nothing about the wire, and because
    /// JsonUtility fails QUIETLY: a field that does not match the server's JSON
    /// deserialises to zero or null rather than throwing. A DTO drift would show
    /// up as "0 BB" on a TV in front of a room of people, not as an error. The
    /// only way to catch that is to read real server JSON through the real DTOs
    /// and assert the values.
    ///
    /// Invoked with:
    ///   Unity.exe -batchmode -quit -nographics -projectPath unity/host \
    ///     -executeMethod BrainsAndBacchanal.EditorTools.HeadlessEngineCheck.Run
    ///
    /// Server host/port come from BB_SERVER_HOST / BB_SERVER_PORT. The server
    /// must be running with development tools enabled for the BB checks.
    /// </summary>
    public static class HeadlessEngineCheck
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
                // Task.Run + ConfigureAwait(false) throughout: blocking Unity's
                // main thread while awaiting continuations that want to return
                // to it deadlocks. That cost a debugging session in Phase 3.
                Task.Run(() => RunAsync(host, port)).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                Fail("unhandled exception: " + ex);
            }

            Debug.Log($"[BBENGINE] SUMMARY checks={_checks} failures={_failures}");
            EditorApplication.Exit(_failures == 0 ? 0 : 1);
        }

        private static async Task RunAsync(string host, int port)
        {
            var url = $"ws://{host}:{port}/room/ws";
            Debug.Log($"[BBENGINE] connecting to {url}");

            // ---- Set up a room with two teams ---------------------------------
            var hostClient = new BenchmarkWebSocketClient { RoomId = "pending" };
            var connected = await hostClient.ConnectAsync(url).ConfigureAwait(false);
            Check("host connects", connected, hostClient.LastError);
            if (!connected) return;

            var createAck = await hostClient.SubmitAsync(RoomIntents.CreateRoom, "{}").ConfigureAwait(false);
            if (createAck == null || !createAck.ok)
            {
                Fail("CREATE_ROOM: " + Describe(createAck));
                return;
            }

            var created = JsonUtility.FromJson<RoomCreatedPayload>(createAck.snapshotJson);
            if (created == null) { Fail("room payload did not parse"); return; }
            hostClient.RoomId = created.roomId;

            var p1 = await JoinPlayer(url, created, "Unity P1").ConfigureAwait(false);
            var p2 = await JoinPlayer(url, created, "Unity P2").ConfigureAwait(false);
            if (p1 == null || p2 == null) { Fail("players could not join"); return; }

            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p1.PlayerId + "\",\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p2.PlayerId + "\",\"teamId\":\"TEAM_B\"}").ConfigureAwait(false);

            // ---- START_GAME requires locked teams ------------------------------
            var tooEarly = await hostClient.SubmitAsync(GameIntents.StartGame, "{}").ConfigureAwait(false);
            Check("START_GAME refused while teams are unlocked",
                tooEarly != null && !tooEarly.ok, Describe(tooEarly));

            var lockAck = await hostClient.SubmitAsync(RoomIntents.LockTeams, "{}").ConfigureAwait(false);
            Check("teams lock", lockAck != null && lockAck.ok, Describe(lockAck));

            var startAck = await hostClient.SubmitAsync(GameIntents.StartGame, "{}").ConfigureAwait(false);
            Check("START_GAME accepted", startAck != null && startAck.ok, Describe(startAck));

            // ---- Starting BB, read through the real DTOs -----------------------
            var game = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("game snapshot parsed", game != null, "FromJson returned null");
            if (game == null) return;

            Check("snapshot marks this connection as Host", game.isHost, "isHost false");
            Check("game is running", game.GameRunning, "no game in snapshot");
            Check("phase is ROUND_INTRO", game.game?.phase == "ROUND_INTRO", "phase=" + game.game?.phase);

            Check("two teams present", game.teams != null && game.teams.Length == 2,
                "count=" + (game.teams?.Length ?? -1));

            // The check that matters: 1,000 BB must arrive as 1000, not as the
            // zero JsonUtility produces for a mismatched field.
            foreach (var team in game.teams ?? Array.Empty<GameTeamView>())
            {
                Check($"{team.teamId} starts with 1000 BB", team.bb == 1000, "bb=" + team.bb);
            }

            Check("ledger reached the Host", game.ledger != null && game.ledger.Length >= 2,
                "entries=" + (game.ledger?.Length ?? -1));

            // ---- A generic challenge -------------------------------------------
            await hostClient.SubmitAsync(GameIntents.AdvancePhase, "{\"to\":\"CHALLENGE_INTRO\"}")
                .ConfigureAwait(false);
            var prepared = await hostClient.SubmitAsync(GameIntents.PrepareChallenge,
                "{\"challengeType\":\"UNITY_TEST_CHALLENGE\"}").ConfigureAwait(false);
            Check("challenge prepared", prepared != null && prepared.ok, Describe(prepared));

            var begun = await hostClient.SubmitAsync(GameIntents.StartChallenge, "{}").ConfigureAwait(false);
            Check("challenge started", begun != null && begun.ok, Describe(begun));

            await hostClient.SubmitAsync(GameIntents.SetTurn,
                "{\"teamId\":\"TEAM_A\",\"playerId\":\"" + p1.PlayerId + "\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(GameIntents.SetActivePlayers,
                "{\"playerIds\":[\"" + p1.PlayerId + "\"]}").ConfigureAwait(false);

            game = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("challenge type round-trips",
                game?.game?.challenge?.challengeType == "UNITY_TEST_CHALLENGE",
                "type=" + game?.game?.challenge?.challengeType);
            Check("challenge status is active",
                game?.game?.challenge?.status == "active", "status=" + game?.game?.challenge?.status);
            Check("turn parsed", game?.game?.turn?.playerId == p1.PlayerId,
                "turn=" + game?.game?.turn?.playerId);
            Check("active player parsed",
                game?.game?.challenge?.activePlayerIds != null &&
                game.game.challenge.activePlayerIds.Length == 1,
                "count=" + (game?.game?.challenge?.activePlayerIds?.Length ?? -1));

            // CONTENT SAFETY: a challenge carries a reference, never content.
            Check("challenge carries no game content",
                string.IsNullOrEmpty(game?.game?.challenge?.configRef),
                "configRef=" + game?.game?.challenge?.configRef);

            // ---- Timer ----------------------------------------------------------
            var timerAck = await hostClient.SubmitAsync(GameIntents.StartTimer, "{\"durationMs\":30000}")
                .ConfigureAwait(false);
            Check("timer started", timerAck != null && timerAck.ok, Describe(timerAck));

            game = await GameSnapshot(hostClient).ConfigureAwait(false);
            var timer = game?.game?.challenge?.timer;
            Check("timer parsed with a real duration", timer != null && timer.durationMs == 30000,
                "durationMs=" + (timer?.durationMs ?? -1));
            Check("timer is counting down",
                timer != null && timer.remainingMs > 0 && timer.remainingMs <= 30000,
                "remainingMs=" + (timer?.remainingMs ?? -1));

            // ---- D-011: the active player drops --------------------------------
            await p1.Client.DisconnectAsync().ConfigureAwait(false);

            var pausedFrame = await WaitForEvent(hostClient, GameEvents.GamePaused, 5000)
                .ConfigureAwait(false);
            Check("active player disconnect pauses the game", pausedFrame != null, "no GAME_PAUSED in 5s");

            game = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("snapshot reports paused", game?.game?.paused == true, "paused=" + game?.game?.paused);
            Check("pause reason is the disconnect",
                game?.game?.pause?.reason == "player_disconnect", "reason=" + game?.game?.pause?.reason);
            Check("pause records where to resume to",
                game?.game?.pause?.resumePhase == "ACTIVE_PLAY",
                "resumePhase=" + game?.game?.pause?.resumePhase);

            var frozenMs = game?.game?.challenge?.timer?.remainingMs ?? 0;
            Check("timer froze with time left", frozenMs > 0, "remainingMs=" + frozenMs);

            await Task.Delay(800).ConfigureAwait(false);
            game = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("frozen timer does not drain while paused",
                game?.game?.challenge?.timer?.remainingMs == frozenMs,
                $"was {frozenMs}, now {game?.game?.challenge?.timer?.remainingMs}");

            // ---- Reconnect does not resume --------------------------------------
            var returning = new BenchmarkWebSocketClient { RoomId = created.roomId };
            await returning.ConnectAsync(url).ConfigureAwait(false);
            var back = await returning.SubmitAsync(RoomIntents2.ReconnectPlayer,
                "{\"playerId\":\"" + p1.PlayerId + "\",\"reconnectToken\":\"" + p1.Token + "\"}")
                .ConfigureAwait(false);
            Check("player reconnects", back != null && back.ok, Describe(back));

            game = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("reconnecting does NOT resume the game",
                game?.game?.paused == true, "paused=" + game?.game?.paused);

            // ---- Only the Host resumes -------------------------------------------
            var byPlayer = await returning.SubmitAsync(GameIntents.ResumeGame, "{}").ConfigureAwait(false);
            Check("a phone cannot resume", byPlayer != null && !byPlayer.ok, Describe(byPlayer));

            var byHost = await hostClient.SubmitAsync(GameIntents.ResumeGame, "{}").ConfigureAwait(false);
            Check("the Host can resume", byHost != null && byHost.ok, Describe(byHost));

            game = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("resumed to the interrupted phase",
                game?.game?.phase == "ACTIVE_PLAY", "phase=" + game?.game?.phase);
            Check("challenge survived the pause",
                game?.game?.challenge?.challengeType == "UNITY_TEST_CHALLENGE",
                "type=" + game?.game?.challenge?.challengeType);
            Check("timer resumed with the time it had",
                (game?.game?.challenge?.timer?.remainingMs ?? 0) > 0,
                "remainingMs=" + game?.game?.challenge?.timer?.remainingMs);

            // ---- Host authority --------------------------------------------------
            var playerRuling = await returning.SubmitAsync(GameIntents.Ruling,
                "{\"kind\":\"valid\",\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            Check("a phone cannot rule", playerRuling != null && !playerRuling.ok, Describe(playerRuling));

            var hostRuling = await hostClient.SubmitAsync(GameIntents.Ruling,
                "{\"kind\":\"valid\",\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            Check("the Host can rule", hostRuling != null && hostRuling.ok, Describe(hostRuling));

            game = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("ruling recorded and parsed",
                game?.game?.challenge?.rulings != null && game.game.challenge.rulings.Length == 1,
                "count=" + (game?.game?.challenge?.rulings?.Length ?? -1));

            // ---- Resolution moves BB through the ledger --------------------------
            var resolve = await hostClient.SubmitAsync(GameIntents.ResolveChallenge,
                "{\"winningTeamIds\":[\"TEAM_A\"],\"bbDeltas\":{\"TEAM_A\":500}}").ConfigureAwait(false);
            Check("challenge resolved", resolve != null && resolve.ok, Describe(resolve));

            game = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("winner was awarded", BbOf(game, "TEAM_A") == 1500, "bb=" + BbOf(game, "TEAM_A"));
            Check("the other team is untouched", BbOf(game, "TEAM_B") == 1000, "bb=" + BbOf(game, "TEAM_B"));

            var resolveAgain = await hostClient.SubmitAsync(GameIntents.ResolveChallenge,
                "{\"winningTeamIds\":[\"TEAM_A\"],\"bbDeltas\":{\"TEAM_A\":500}}").ConfigureAwait(false);
            Check("a second resolution is refused",
                resolveAgain != null && !resolveAgain.ok, Describe(resolveAgain));
            game = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("no double award", BbOf(game, "TEAM_A") == 1500, "bb=" + BbOf(game, "TEAM_A"));

            // ---- The floor at zero, proved through the server ---------------------
            if (game != null && game.devToolsEnabled)
            {
                await hostClient.SubmitAsync(GameIntents.DevAdjustBb,
                    "{\"teamId\":\"TEAM_B\",\"delta\":-5000}").ConfigureAwait(false);

                game = await GameSnapshot(hostClient).ConfigureAwait(false);
                Check("BB floors at 0, never negative", BbOf(game, "TEAM_B") == 0,
                    "bb=" + BbOf(game, "TEAM_B"));
            }
            else
            {
                Debug.Log("[BBENGINE] SKIP floor test — server has development tools disabled");
            }

            // ---- Host reconnect returns to the SAME game --------------------------
            var gameIdBefore = game?.game?.gameId;
            await hostClient.DisconnectAsync().ConfigureAwait(false);

            var hostAgain = new BenchmarkWebSocketClient { RoomId = created.roomId };
            await hostAgain.ConnectAsync(url).ConfigureAwait(false);
            var rehost = await hostAgain.SubmitAsync(RoomIntents.ReconnectHost,
                "{\"hostToken\":\"" + created.hostToken + "\"}").ConfigureAwait(false);
            Check("Host reconnects", rehost != null && rehost.ok, Describe(rehost));

            var afterHost = await GameSnapshot(hostAgain).ConfigureAwait(false);
            Check("Host returns to the SAME game, not a new one",
                afterHost?.game?.gameId == gameIdBefore,
                $"before={gameIdBefore} after={afterHost?.game?.gameId}");
            Check("balances survived the Host reconnect",
                BbOf(afterHost, "TEAM_A") == 1500, "bb=" + BbOf(afterHost, "TEAM_A"));

            // ---- Content and credential safety ------------------------------------
            var raw = await RawGameSnapshotJson(hostAgain).ConfigureAwait(false);
            Check("snapshot carries no reconnect credential",
                raw != null && !raw.Contains("reconnectToken"), "found reconnectToken");
            Check("snapshot carries no Host token",
                raw != null && !raw.Contains(created.hostToken), "found hostToken");

            await returning.DisconnectAsync().ConfigureAwait(false);
            await p2.Client.DisconnectAsync().ConfigureAwait(false);
            await hostAgain.SubmitAsync(RoomIntents.CloseRoom, "{}").ConfigureAwait(false);
            await hostAgain.DisconnectAsync().ConfigureAwait(false);
        }

        // -------------------------------------------------------------------
        // Helpers
        // -------------------------------------------------------------------

        private sealed class JoinedPlayer
        {
            public BenchmarkWebSocketClient Client;
            public string PlayerId;
            public string Token;
        }

        private static async Task<JoinedPlayer> JoinPlayer(
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
            return new JoinedPlayer
            {
                Client = client,
                PlayerId = joined.playerId,
                Token = joined.reconnectToken,
            };
        }

        private static async Task<HostGameSnapshot> GameSnapshot(BenchmarkWebSocketClient client)
        {
            var json = await RawGameSnapshotJson(client).ConfigureAwait(false);
            return string.IsNullOrEmpty(json) ? null : JsonUtility.FromJson<HostGameSnapshot>(json);
        }

        private static async Task<string> RawGameSnapshotJson(BenchmarkWebSocketClient client)
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

        private static async Task<string> WaitForEvent(
            BenchmarkWebSocketClient client, string type, int timeoutMs)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                foreach (var message in client.DrainInbound())
                {
                    if (WireFraming.ReadFrameKind(message) != "event") continue;
                    var envelope = WireFraming.ParseEvent(message);
                    if (envelope != null && envelope.type == type) return message;
                }
                await Task.Delay(50).ConfigureAwait(false);
            }
            return null;
        }

        private static string Describe(IntentAck ack)
        {
            if (ack == null) return "null ack";
            return ack.ok ? "ok" : $"{ack.error?.code}: {ack.error?.message}";
        }

        private static void Check(string label, bool passed, string detail)
        {
            _checks++;
            if (passed)
            {
                Debug.Log($"[BBENGINE] PASS {label}");
            }
            else
            {
                _failures++;
                Debug.Log($"[BBENGINE] FAIL {label} — {detail}");
            }
        }

        private static void Fail(string message)
        {
            _checks++;
            _failures++;
            Debug.Log($"[BBENGINE] FAIL {message}");
        }
    }
}

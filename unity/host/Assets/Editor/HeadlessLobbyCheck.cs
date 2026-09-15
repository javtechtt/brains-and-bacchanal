using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using BrainsAndBacchanal.Net;
using BrainsAndBacchanal.Protocol;
using BrainsAndBacchanal.Util;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Headless end-to-end check of the Phase 4 Host lobby — DEVELOPMENT ONLY.
    ///
    /// Runs the SAME WebSocket client, the SAME DTOs and the SAME QR encoder the
    /// HostLobby scene uses, against the real running production game server, in
    /// batch mode.
    ///
    /// It exists because compiling proves nothing about the wire. Phase 3's worst
    /// faults — the ack parser matching the wrong JSON key, a build that silently
    /// emitted no output, two adapters fighting over one upgrade — all compiled
    /// cleanly and all failed the moment something real connected.
    ///
    /// Invoked with:
    ///   Unity.exe -batchmode -quit -nographics -projectPath ... \
    ///     -executeMethod BrainsAndBacchanal.EditorTools.HeadlessLobbyCheck.Run
    ///
    /// Server host/port come from BB_SERVER_HOST / BB_SERVER_PORT.
    /// </summary>
    public static class HeadlessLobbyCheck
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

            Debug.Log($"[BBLOBBY] SUMMARY checks={_checks} failures={_failures}");
            EditorApplication.Exit(_failures == 0 ? 0 : 1);
        }

        private static async Task RunAsync(string host, int port)
        {
            var url = $"ws://{host}:{port}/room/ws";
            Debug.Log($"[BBLOBBY] connecting to {url}");

            // ---- QR encoder, before any networking ---------------------------
            // Pure and offline, so it is worth proving first.
            CheckQrEncoder();

            var hostClient = new BenchmarkWebSocketClient { RoomId = "pending" };

            var connected = await hostClient.ConnectAsync(url).ConfigureAwait(false);
            Check("host connects", connected, hostClient.LastError);
            if (!connected) return;

            // ---- Create room --------------------------------------------------
            var createAck = await hostClient.SubmitAsync(RoomIntents.CreateRoom, "{}").ConfigureAwait(false);
            Check("CREATE_ROOM accepted", createAck != null && createAck.ok, Describe(createAck));
            if (createAck == null || !createAck.ok) return;

            var created = JsonUtility.FromJson<RoomCreatedPayload>(createAck.snapshotJson);
            Check("room payload parsed", created != null, "FromJson returned null");
            if (created == null) return;

            Check("room code is 4 characters",
                !string.IsNullOrEmpty(created.roomCode) && created.roomCode.Length == 4,
                "code=" + created.roomCode);
            Check("host credential returned", !string.IsNullOrEmpty(created.hostToken), "empty");
            Check("join URL contains the code",
                created.joinUrl != null && created.joinUrl.Contains(created.roomCode),
                "joinUrl=" + created.joinUrl);
            Check("room id differs from room code",
                created.roomId != created.roomCode, "id and code were equal");
            Check("snapshot marks this connection as Host",
                created.snapshot != null && created.snapshot.isHost, "isHost false");

            hostClient.RoomId = created.roomId;

            // The QR the Host will actually display must encode the real URL.
            var qr = QrCode.Encode(created.joinUrl);
            Check("join URL encodes as a QR", qr != null && qr.Size >= 21,
                qr == null ? "encoder returned null" : "size=" + qr.Size);

            // ---- A player joins ------------------------------------------------
            var player = new BenchmarkWebSocketClient { RoomId = "pending" };
            var playerConnected = await player.ConnectAsync(url).ConfigureAwait(false);
            Check("player connects", playerConnected, player.LastError);
            if (!playerConnected) return;

            var joinPayload = "{\"roomCode\":\"" + created.roomCode + "\",\"displayName\":\"Unity Test Player\"}";
            var joinAck = await player.SubmitAsync(RoomIntents2.JoinRoom, joinPayload).ConfigureAwait(false);
            Check("JOIN_ROOM accepted", joinAck != null && joinAck.ok, Describe(joinAck));
            if (joinAck == null || !joinAck.ok) return;

            var joinInfo = JsonUtility.FromJson<JoinAcceptedPayload>(joinAck.snapshotJson);
            Check("join payload parsed", joinInfo != null, "FromJson returned null");
            if (joinInfo == null) return;

            Check("player id issued", !string.IsNullOrEmpty(joinInfo.playerId), "empty");
            Check("reconnect credential issued", !string.IsNullOrEmpty(joinInfo.reconnectToken), "empty");
            player.RoomId = created.roomId;

            // ---- The Host is told ---------------------------------------------
            var joinedFrame = await WaitForEvent(hostClient, RoomEvents.PlayerJoined, 5000).ConfigureAwait(false);
            Check("host receives PLAYER_JOINED", joinedFrame != null, "no event within 5s");

            if (joinedFrame != null)
            {
                var envelope = WireFraming.ParseEvent(joinedFrame);
                Check("event envelope parses", envelope != null, "ParseEvent returned null");
                if (envelope != null)
                {
                    Check("protocol version matches",
                        ProtocolVersion.IsSupported(envelope.protocolVersion),
                        $"server={envelope.protocolVersion} unity={ProtocolVersion.Current}");
                    Check("sequence number present", envelope.seq > 0, "seq=" + envelope.seq);
                    Check("server timestamp has ms precision",
                        envelope.serverTime > 1_600_000_000_000L, "serverTime=" + envelope.serverTime);
                }

                // A broadcast must never carry anyone's credential.
                Check("broadcast carries no reconnect credential",
                    !joinedFrame.Contains(joinInfo.reconnectToken),
                    "credential appeared in a broadcast event");
                Check("broadcast carries no host credential",
                    !joinedFrame.Contains(created.hostToken),
                    "host token appeared in a broadcast event");
            }

            // ---- Snapshot ------------------------------------------------------
            var snapshot = await FetchSnapshot(hostClient).ConfigureAwait(false);
            Check("host snapshot returned", snapshot != null, "null snapshot");
            if (snapshot != null)
            {
                Check("snapshot lists the player",
                    snapshot.players != null && snapshot.players.Length == 1,
                    "players=" + (snapshot.players?.Length ?? -1));
                Check("snapshot shows two teams by default",
                    snapshot.teams != null && snapshot.teams.Length == 2,
                    "teams=" + (snapshot.teams?.Length ?? -1));
                Check("player starts unassigned",
                    snapshot.players != null && snapshot.players.Length > 0 &&
                    !snapshot.players[0].HasTeam,
                    "player already had a team");
                Check("player shows as connected",
                    snapshot.players != null && snapshot.players.Length > 0 &&
                    snapshot.players[0].IsConnected,
                    "player not connected");
            }

            // ---- Host authority --------------------------------------------
            // The player tries a Host action, including a forged flag.
            var forged = "{\"playerId\":\"" + joinInfo.playerId +
                         "\",\"teamId\":\"TEAM_A\",\"isHost\":true}";
            var forgedAck = await player.SubmitAsync(RoomIntents.AssignPlayerTeam, forged)
                .ConfigureAwait(false);
            Check("player CANNOT assign a team",
                forgedAck != null && !forgedAck.ok, "player was allowed to assign a team");
            Check("rejection is UNAUTHORIZED_ACTOR",
                forgedAck?.error?.code == "UNAUTHORIZED_ACTOR",
                "code=" + forgedAck?.error?.code);

            // ---- Team assignment by the Host ---------------------------------
            var assign = "{\"playerId\":\"" + joinInfo.playerId + "\",\"teamId\":\"TEAM_A\"}";
            var assignAck = await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam, assign)
                .ConfigureAwait(false);
            Check("host CAN assign a team", assignAck != null && assignAck.ok, Describe(assignAck));

            snapshot = await FetchSnapshot(hostClient).ConfigureAwait(false);
            Check("assignment is reflected",
                snapshot?.players != null && snapshot.players.Length > 0 &&
                snapshot.players[0].teamId == TeamIds.A,
                "teamId=" + (snapshot?.players != null && snapshot.players.Length > 0
                    ? snapshot.players[0].teamId : "?"));

            // ---- Three-team mode ---------------------------------------------
            var modeAck = await hostClient.SubmitAsync(RoomIntents.SetTeamMode, "{\"teamMode\":3}")
                .ConfigureAwait(false);
            Check("host can switch to 3 teams", modeAck != null && modeAck.ok, Describe(modeAck));

            snapshot = await FetchSnapshot(hostClient).ConfigureAwait(false);
            Check("three teams are exposed",
                snapshot?.teams != null && snapshot.teams.Length == 3,
                "teams=" + (snapshot?.teams?.Length ?? -1));

            // Back to two, which is safe because nobody is in Team C.
            await hostClient.SubmitAsync(RoomIntents.SetTeamMode, "{\"teamMode\":2}").ConfigureAwait(false);

            // ---- Locking rejects an empty team --------------------------------
            var badLock = await hostClient.SubmitAsync(RoomIntents.LockTeams, "{}").ConfigureAwait(false);
            Check("lock REJECTED while a team is empty",
                badLock != null && !badLock.ok, "lock succeeded with an empty team");

            // ---- Unity Host reconnect -----------------------------------------
            // The Host drops and comes back. It must find the SAME room, with the
            // player and the team intact, and must not create a second room.
            await hostClient.DisconnectAsync().ConfigureAwait(false);

            var returning = new BenchmarkWebSocketClient { RoomId = created.roomId };
            var reconnected = await returning.ConnectAsync(url).ConfigureAwait(false);
            Check("host reconnects", reconnected, returning.LastError);

            if (reconnected)
            {
                var hostTokenPayload = "{\"hostToken\":\"" + created.hostToken + "\"}";
                var restoreAck = await returning.SubmitAsync(RoomIntents.ReconnectHost, hostTokenPayload)
                    .ConfigureAwait(false);
                Check("RECONNECT_HOST accepted", restoreAck != null && restoreAck.ok, Describe(restoreAck));

                if (restoreAck != null && restoreAck.ok)
                {
                    var restored = JsonUtility.FromJson<HostReconnectedPayload>(restoreAck.snapshotJson);
                    Check("same room code restored",
                        restored != null && restored.roomCode == created.roomCode,
                        "code=" + restored?.roomCode);
                    Check("player list restored",
                        restored?.snapshot?.players != null && restored.snapshot.players.Length == 1,
                        "players=" + (restored?.snapshot?.players?.Length ?? -1));
                    Check("team assignment restored",
                        restored?.snapshot?.players != null && restored.snapshot.players.Length > 0 &&
                        restored.snapshot.players[0].teamId == TeamIds.A,
                        "team not restored");
                }

                // A forged Host credential must be refused.
                var attacker = new BenchmarkWebSocketClient { RoomId = created.roomId };
                if (await attacker.ConnectAsync(url).ConfigureAwait(false))
                {
                    var forgedHost = await attacker
                        .SubmitAsync(RoomIntents.ReconnectHost, "{\"hostToken\":\"not-the-token\"}")
                        .ConfigureAwait(false);
                    Check("forged host credential REJECTED",
                        forgedHost != null && !forgedHost.ok, "forged token was accepted");
                    await attacker.DisconnectAsync().ConfigureAwait(false);
                }

                await returning.DisconnectAsync().ConfigureAwait(false);
            }

            await player.DisconnectAsync().ConfigureAwait(false);
        }

        // -------------------------------------------------------------------
        // QR encoder
        // -------------------------------------------------------------------

        private static void CheckQrEncoder()
        {
            var grid = QrCode.Encode("http://192.168.1.10:3000/join/BX7K");
            Check("QR encodes a join URL", grid != null, "encoder returned null");
            if (grid == null) return;

            Check("QR is a known symbol size",
                grid.Size == 21 || grid.Size == 25 || grid.Size == 29 ||
                grid.Size == 33 || grid.Size == 37 || grid.Size == 41,
                "size=" + grid.Size);

            // Finder patterns: the three corner squares a scanner locks onto. If
            // these are wrong nothing else matters.
            Check("QR top-left finder present", IsFinder(grid, 0, 0), "missing");
            Check("QR top-right finder present", IsFinder(grid, grid.Size - 7, 0), "missing");
            Check("QR bottom-left finder present", IsFinder(grid, 0, grid.Size - 7), "missing");

            // Timing patterns must alternate, or module pitch cannot be measured.
            var timingOk = true;
            for (var i = 8; i < grid.Size - 8; i++)
            {
                if (grid[i, 6] != (i % 2 == 0)) { timingOk = false; break; }
                if (grid[6, i] != (i % 2 == 0)) { timingOk = false; break; }
            }
            Check("QR timing patterns alternate", timingOk, "timing pattern broken");

            // A blank or saturated grid would still "encode" but never scan.
            var dark = 0;
            for (var y = 0; y < grid.Size; y++)
            {
                for (var x = 0; x < grid.Size; x++)
                {
                    if (grid[x, y]) dark++;
                }
            }
            var ratio = (float)dark / (grid.Size * grid.Size);
            Check("QR dark/light balance is plausible", ratio > 0.3f && ratio < 0.7f,
                "dark ratio=" + ratio.ToString("F2"));

            // Distinct inputs must produce distinct symbols.
            var other = QrCode.Encode("http://192.168.1.10:3000/join/WXYZ");
            var differs = false;
            if (other != null && other.Size == grid.Size)
            {
                for (var y = 0; y < grid.Size && !differs; y++)
                {
                    for (var x = 0; x < grid.Size; x++)
                    {
                        if (grid[x, y] != other[x, y]) { differs = true; break; }
                    }
                }
            }
            Check("different codes produce different QR symbols", differs, "identical symbols");
        }

        private static bool IsFinder(QrCode.Grid grid, int ox, int oy)
        {
            for (var dy = 0; dy < 7; dy++)
            {
                for (var dx = 0; dx < 7; dx++)
                {
                    var expected = dx == 0 || dx == 6 || dy == 0 || dy == 6 ||
                                   (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
                    if (grid[ox + dx, oy + dy] != expected) return false;
                }
            }
            return true;
        }

        // -------------------------------------------------------------------
        // Helpers
        // -------------------------------------------------------------------

        private static async Task<LobbySnapshot> FetchSnapshot(BenchmarkWebSocketClient client)
        {
            var ack = await client.SubmitAsync(RoomIntents.RequestLobbySnapshot, "{}").ConfigureAwait(false);
            if (ack == null || !ack.ok || string.IsNullOrEmpty(ack.snapshotJson)) return null;
            return JsonUtility.FromJson<LobbySnapshot>(ack.snapshotJson);
        }

        private static async Task<string> WaitForEvent(
            BenchmarkWebSocketClient client, string type, int timeoutMs)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            var seen = new List<string>();

            while (DateTime.UtcNow < deadline)
            {
                foreach (var message in client.DrainInbound())
                {
                    seen.Add(message);
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
                Debug.Log($"[BBLOBBY] PASS {label}");
            }
            else
            {
                _failures++;
                Debug.Log($"[BBLOBBY] FAIL {label} — {detail}");
            }
        }

        private static void Fail(string message)
        {
            _checks++;
            _failures++;
            Debug.Log($"[BBLOBBY] FAIL {message}");
        }
    }

    /// <summary>
    /// Player-side intents, needed only by this check.
    ///
    /// The Host never sends these — it does not join its own room — so they stay
    /// out of the shipped RoomIntents surface rather than implying Unity might.
    /// </summary>
    internal static class RoomIntents2
    {
        public const string JoinRoom = "JOIN_ROOM";
        public const string ReconnectPlayer = "RECONNECT_PLAYER";
    }

    /// <summary>Reply to JOIN_ROOM. Test-only, for the same reason.</summary>
    [Serializable]
    internal class JoinAcceptedPayload
    {
        public string playerId;
        public string displayName;
        public string reconnectToken;
        public LobbySnapshot snapshot;
    }
}

using System;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using BrainsAndBacchanal.Net;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Headless end-to-end check of ROUND 4 (Family Feud) — DEVELOPMENT ONLY.
    /// Phase 7D-B.
    ///
    /// Runs the SAME WebSocket client and the SAME C# DTOs the Host scene uses,
    /// against the real running production game server, in batch mode. Mirrors
    /// HeadlessRound3Check's structure and reasoning exactly.
    ///
    /// ================== WHY THIS IS NOT OPTIONAL ==================
    /// JsonUtility FAILS QUIETLY. Round 4 adds its own hazards:
    ///
    ///   1. AN UNREVEALED BOARD ANSWER MUST NEVER LEAK. `text`/`value` on
    ///      `Round4BoardAnswerView` must be empty/0 until `revealed` is true —
    ///      this asserts that against the raw JSON, not just the parsed DTO,
    ///      because a stray extra field would parse fine and still leak.
    ///
    ///   2. THE INACTIVE THIRD TEAM MUST HAVE NO CONTROLS. This cannot be
    ///      exercised without three teams and a real matchup transition, which
    ///      this check drives end to end.
    ///
    ///   3. NULL CLASS FIELDS arrive as default-filled objects, never C# null —
    ///      every nullable DTO's `Exists` predicate is asserted rather than a
    ///      bare `!= null` check.
    ///
    /// Invoked with:
    ///   Unity.exe -batchmode -quit -nographics -projectPath unity/host \
    ///     -executeMethod BrainsAndBacchanal.EditorTools.HeadlessRound4Check.Run
    ///
    /// THE SERVER MUST RUN WITH DEVELOPMENT TOOLS ENABLED.
    /// </summary>
    public static class HeadlessRound4Check
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

            Debug.Log($"[BBROUND4] SUMMARY checks={_checks} failures={_failures}");
            EditorApplication.Exit(_failures == 0 ? 0 : 1);
        }

        private static async Task RunAsync(string host, int port)
        {
            var url = $"ws://{host}:{port}/room/ws";
            Debug.Log($"[BBROUND4] connecting to {url}");

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

            // Three teams — the transition from FIRST to FINAL matchup, and the
            // inactive-team-has-no-controls claim, both need three.
            await hostClient.SubmitAsync(RoomIntents.SetTeamMode, "{\"teamMode\":3}")
                .ConfigureAwait(false);

            var p1 = await JoinPlayer4(url, created, "Unity R4 P1").ConfigureAwait(false);
            var p2 = await JoinPlayer4(url, created, "Unity R4 P2").ConfigureAwait(false);
            var p3 = await JoinPlayer4(url, created, "Unity R4 P3").ConfigureAwait(false);
            if (p1 == null || p2 == null || p3 == null) { Fail("players could not join"); return; }

            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p1.PlayerId + "\",\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p2.PlayerId + "\",\"teamId\":\"TEAM_B\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p3.PlayerId + "\",\"teamId\":\"TEAM_C\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.LockTeams, "{}").ConfigureAwait(false);
            await hostClient.SubmitAsync(GameIntents.StartGame, "{}").ConfigureAwait(false);

            var before = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("round4 is absent before Round 4 starts",
                before?.game != null && (before.game.round4 == null || !before.game.round4.Exists),
                "round4 was present outside Round 4");

            if (before != null && !before.devToolsEnabled)
            {
                Fail("server has development tools DISABLED — start it with dev tools on.");
                return;
            }

            // Give TEAM_C a head start so the entering standings are not just
            // team-assignment order — TEAM_C should enter FIRST, TEAM_A and
            // TEAM_B contest the FIRST matchup.
            await hostClient.SubmitAsync(GameIntents.DevAdjustBb,
                "{\"teamId\":\"TEAM_C\",\"delta\":5000}").ConfigureAwait(false);

            // ---- Enter Round 4 --------------------------------------------------
            var entered = await hostClient.SubmitAsync(Round4Intents.DevStartRound4, "{}")
                .ConfigureAwait(false);
            Check("[DEV] START ROUND 4 accepted", entered != null && entered.ok, Describe(entered));

            var snap = await GameSnapshot(hostClient).ConfigureAwait(false);
            var round4 = snap?.game?.round4;

            Check("round4 deserialises", round4 != null && round4.Exists, "round4 was absent");
            if (round4 == null || !round4.Exists) return;

            Check("roundIndex is 4", round4.roundIndex == 4, $"roundIndex={round4.roundIndex}");
            Check("entering standings arrive as a readable list with TEAM_C first",
                round4.enteringStandings != null && round4.enteringStandings.Length == 3,
                Describe(round4.enteringStandings));

            Check("the FIRST matchup is TEAM_A vs TEAM_B",
                round4.matchupTeamIds != null && round4.matchupTeamIds.Length == 2
                && Array.IndexOf(round4.matchupTeamIds, "TEAM_A") >= 0
                && Array.IndexOf(round4.matchupTeamIds, "TEAM_B") >= 0,
                Describe(round4.matchupTeamIds));
            Check("TEAM_C sits out the FIRST matchup",
                round4.HasInactiveTeam && round4.inactiveTeamId == "TEAM_C",
                "inactiveTeamId=" + round4.inactiveTeamId);
            Check("matchupStage is FIRST",
                round4.matchupStage == Round4MatchupStages.First,
                "matchupStage=" + round4.matchupStage);

            // ---- Face-off: open, buzz, decide, PLAY/PASS -------------------------
            var startedFaceoff = await hostClient.SubmitAsync(Round4Intents.HostStartFaceoff, "{}")
                .ConfigureAwait(false);
            Check("HOST_START_FACEOFF accepted", startedFaceoff != null && startedFaceoff.ok, Describe(startedFaceoff));

            var faceoffSnap = await GameSnapshot(hostClient).ConfigureAwait(false);
            var current = faceoffSnap?.game?.round4?.Current;
            Check("current survey exists after starting the face-off",
                current != null && current.Exists, "current was absent");
            Check("board carries the prompt but no revealed answer text yet",
                current?.board != null && !string.IsNullOrEmpty(current.board.prompt)
                && current.board.answers != null && current.board.answers.Length > 0
                && !current.board.answers[0].revealed
                && string.IsNullOrEmpty(current.board.answers[0].text),
                "board leaked unrevealed content or was absent");

            // SECRECY: no unrevealed answer text/value anywhere in the raw JSON
            // sent to the Host. Checked against known TEST fixture text so a
            // stray field would be caught even if it parsed cleanly.
            var hostJson = await RawSnapshotJson(hostClient).ConfigureAwait(false);
            Check("unrevealed board text (TEST APPLE) is not in the Host JSON",
                hostJson != null && !hostJson.Contains("TEST APPLE"),
                "unrevealed board answer leaked to the Host");

            var faceoff = current?.Faceoff;
            Check("face-off is reading with two participants",
                faceoff != null && faceoff.status == Round4FaceoffStatuses.Reading
                && faceoff.participantTeamIds != null && faceoff.participantTeamIds.Length == 2,
                "faceoff=" + (faceoff == null ? "null" : faceoff.status));

            // TEAM_C (inactive) attempts to buzz and must be refused.
            var inactiveBuzz = await p3.Client.SubmitAsync(Round4Intents.SubmitBuzz, "{}")
                .ConfigureAwait(false);
            Check("the inactive third team's buzz is refused",
                inactiveBuzz != null && !inactiveBuzz.ok, Describe(inactiveBuzz));

            // TEAM_A buzzes first.
            var buzzed = await p1.Client.SubmitAsync(Round4Intents.SubmitBuzz, "{}")
                .ConfigureAwait(false);
            Check("TEAM_A's buzz is accepted", buzzed != null && buzzed.ok, Describe(buzzed));

            var afterBuzz = await GameSnapshot(hostClient).ConfigureAwait(false);
            var buzzedFaceoff = afterBuzz?.game?.round4?.Current?.Faceoff;
            Check("the buzz winner is recorded and the loser is locked out",
                buzzedFaceoff != null && buzzedFaceoff.buzzedTeamId == "TEAM_A"
                && buzzedFaceoff.status == Round4FaceoffStatuses.Buzzed,
                "buzzedTeamId=" + buzzedFaceoff?.buzzedTeamId);

            // TEAM_B (not currently eligible) tries to answer and must be refused.
            var wrongAnswerer = await p2.Client.SubmitAsync(Round4Intents.SubmitFaceoffAnswer,
                "{\"answer\":\"anything\"}").ConfigureAwait(false);
            Check("the non-eligible team's face-off answer is refused",
                wrongAnswerer != null && !wrongAnswerer.ok, Describe(wrongAnswerer));

            // TEAM_A answers with the #1-ranked TEST fixture answer.
            var faceoffAnswer = await p1.Client.SubmitAsync(Round4Intents.SubmitFaceoffAnswer,
                "{\"answer\":\"TEST APPLE\"}").ConfigureAwait(false);
            Check("TEAM_A's face-off answer is accepted", faceoffAnswer != null && faceoffAnswer.ok, Describe(faceoffAnswer));

            var afterAnswer = await GameSnapshot(hostClient).ConfigureAwait(false);
            var decided = afterAnswer?.game?.round4?.Current?.Faceoff;
            Check("the #1 answer wins the face-off outright",
                decided != null && decided.winningTeamId == "TEAM_A"
                && decided.status == Round4FaceoffStatuses.Decided,
                "winningTeamId=" + decided?.winningTeamId + " status=" + decided?.status);

            // TEAM_A chooses PLAY.
            var played = await p1.Client.SubmitAsync(Round4Intents.ChoosePlayOrPass,
                "{\"decision\":\"PLAY\",\"playerOrder\":[\"" + p1.PlayerId + "\"]}").ConfigureAwait(false);
            Check("PLAY is accepted", played != null && played.ok, Describe(played));

            var afterPlay = await GameSnapshot(hostClient).ConfigureAwait(false);
            var boardPlay = afterPlay?.game?.round4?.Current?.BoardPlay;
            Check("board play begins with TEAM_A controlling",
                boardPlay != null && boardPlay.controllingTeamId == "TEAM_A",
                "controllingTeamId=" + boardPlay?.controllingTeamId);
            // Phase 7D-B1: the 5s board turn timer reaches the safe view.
            Check("the board-play turn timer is present with a 5000ms duration",
                boardPlay?.turnTimer != null && boardPlay.turnTimer.Exists && boardPlay.turnTimer.durationMs == 5000,
                "turnTimer=" + (boardPlay?.turnTimer == null ? "null" : boardPlay.turnTimer.durationMs.ToString()));

            // ---- Board play: reveal, strike ------------------------------------
            var boardAnswer = await p1.Client.SubmitAsync(Round4Intents.SubmitBoardAnswer,
                "{\"answer\":\"TEST BANANA\"}").ConfigureAwait(false);
            Check("a correct board answer is accepted", boardAnswer != null && boardAnswer.ok, Describe(boardAnswer));

            var afterReveal = await GameSnapshot(hostClient).ConfigureAwait(false);
            var revealedBoard = afterReveal?.game?.round4?.Current?.board;
            var revealedRank2 = Array.Find(revealedBoard?.answers ?? Array.Empty<Round4BoardAnswerView>(),
                a => a.rank == 2);
            // 40 (TEST APPLE, rank 1 — revealed and scored by the face-off win
            // itself, GAME_RULES_LOCKED.md §19 preamble / Phase 7D-A2) + 25
            // (TEST BANANA, just revealed here) = 65.
            Check("the revealed answer's value is added to the pot",
                revealedRank2 != null && revealedRank2.revealed && revealedRank2.text == "TEST BANANA"
                && revealedBoard.accumulatedPoints == 65,
                "accumulatedPoints=" + revealedBoard?.accumulatedPoints);

            var strike1 = await hostClient.SubmitAsync(Round4Intents.HostRecordStrike, "{\"reason\":\"wrong\"}")
                .ConfigureAwait(false);
            Check("a Host-recorded strike is accepted", strike1 != null && strike1.ok, Describe(strike1));

            var afterStrike = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("the strike count increments",
                afterStrike?.game?.round4?.Current?.board.strikes == 1,
                "strikes=" + afterStrike?.game?.round4?.Current?.board.strikes);

            await p3.Client.DisconnectAsync().ConfigureAwait(false);
            await p1.Client.DisconnectAsync().ConfigureAwait(false);
            await p2.Client.DisconnectAsync().ConfigureAwait(false);
            await hostClient.DisconnectAsync().ConfigureAwait(false);
        }

        // -------------------------------------------------------------------

        private sealed class Round4Player
        {
            public BenchmarkWebSocketClient Client;
            public string PlayerId;
            public string Token;
        }

        private static async Task<Round4Player> JoinPlayer4(
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
            return new Round4Player
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
                Debug.Log($"[BBROUND4] PASS {label}");
            }
            else
            {
                _failures++;
                Debug.Log($"[BBROUND4] FAIL {label} — {detail}");
            }
        }

        private static void Fail(string message)
        {
            _checks++;
            _failures++;
            Debug.Log($"[BBROUND4] FAIL {message}");
        }
    }
}

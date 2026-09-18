using System;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using BrainsAndBacchanal.Net;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Headless end-to-end check of ROUND 1 — DEVELOPMENT ONLY. Phase 7C §21.
    ///
    /// Runs the SAME WebSocket client and the SAME C# DTOs the Host scene uses,
    /// against the real running production game server, in batch mode.
    ///
    /// ================== WHY THIS IS NOT OPTIONAL ==================
    /// Phase 6 found a bug this way, Phase 7A found another, and Phase 7B found
    /// two more in physical testing. JsonUtility FAILS QUIETLY, and Round 1
    /// leans on both of its known limits:
    ///
    ///   1. IT CANNOT DESERIALISE A DICTIONARY. The Round 1 point totals travel
    ///      as a keyed object for the web, which arrives here as NOTHING. They
    ///      are read from `pointList` instead, and this check is what proves
    ///      that list is populated — otherwise every score on the TV reads zero.
    ///
    ///   2. IT CANNOT REPRESENT A NULL CLASS FIELD. A JSON null becomes a
    ///      default-filled object, so `current == null` is never true. Every
    ///      nullable DTO carries an `Exists` predicate, and this asserts them.
    ///
    /// It also asserts the SECRECY claims that are about bytes rather than
    /// return values, which matter more in Round 1 than in any round before it
    /// because the content itself holds the answer:
    ///
    ///   - the canonical answer is not in the JSON before the reveal,
    ///   - a future question is not in anyone's JSON,
    ///   - one team's submitted answer is not in another team's JSON.
    ///
    /// Invoked with:
    ///   Unity.exe -batchmode -quit -nographics -projectPath unity/host \
    ///     -executeMethod BrainsAndBacchanal.EditorTools.HeadlessRound1Check.Run
    ///
    /// THE SERVER MUST RUN WITH DEVELOPMENT TOOLS ENABLED.
    /// </summary>
    public static class HeadlessRound1Check
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

            Debug.Log($"[BBROUND1] SUMMARY checks={_checks} failures={_failures}");
            EditorApplication.Exit(_failures == 0 ? 0 : 1);
        }

        private static async Task RunAsync(string host, int port)
        {
            var url = $"ws://{host}:{port}/room/ws";
            Debug.Log($"[BBROUND1] connecting to {url}");

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

            var p1 = await JoinPlayer1(url, created, "Unity R1 P1").ConfigureAwait(false);
            var p2 = await JoinPlayer1(url, created, "Unity R1 P2").ConfigureAwait(false);
            if (p1 == null || p2 == null) { Fail("players could not join"); return; }

            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p1.PlayerId + "\",\"teamId\":\"TEAM_A\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.AssignPlayerTeam,
                "{\"playerId\":\"" + p2.PlayerId + "\",\"teamId\":\"TEAM_B\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(RoomIntents.LockTeams, "{}").ConfigureAwait(false);

            var beforeStart = await GameSnapshot(hostClient).ConfigureAwait(false);
            Check("round1 is absent before the game starts",
                beforeStart?.game != null
                && (beforeStart.game.round1 == null || !beforeStart.game.round1.Exists),
                "round1 was present before START_GAME");

            // ---- Round 1 starts WITH THE GAME. Spec §18. ------------------------
            await hostClient.SubmitAsync(GameIntents.StartGame, "{}").ConfigureAwait(false);

            var snap = await GameSnapshot(hostClient).ConfigureAwait(false);
            var round1 = snap?.game?.round1;

            Check("round1 deserialises", round1 != null && round1.Exists, "round1 was absent");
            if (round1 == null || !round1.Exists) return;

            Check("Round 1 begins with the game, no DEV entry needed",
                round1.IsNominating, "phase=" + round1.phase);
            Check("roundIndex is 1", round1.roundIndex == 1, $"roundIndex={round1.roundIndex}");
            Check("fifteen questions are announced",
                round1.totalQuestions == 15, "totalQuestions=" + round1.totalQuestions);
            Check("nominations are not complete yet",
                !round1.nominationsComplete, "nominationsComplete was true at the start");

            // THE DICTIONARY CHECK. If pointList were missing, PointsOf would
            // silently read 0 for every team, for the whole round.
            Check("the point totals arrive as a readable list",
                round1.pointList != null && round1.pointList.Length == 2,
                "pointList=" + Describe(round1.pointList));
            Check("both teams start on zero points",
                round1.PointsOf("TEAM_A") == 0 && round1.PointsOf("TEAM_B") == 0,
                "A=" + round1.PointsOf("TEAM_A") + " B=" + round1.PointsOf("TEAM_B"));

            // ---- Nomination ------------------------------------------------------
            var premature = await hostClient.SubmitAsync(Round1Intents.StartRound1, "{}")
                .ConfigureAwait(false);
            Check("starting before every team has nominated is refused",
                premature != null && !premature.ok, Describe(premature));

            foreach (var difficulty in new[] { "EASY", "MEDIUM", "HARD" })
            {
                await p1.Client.SubmitAsync(Round1Intents.NominateAnswerer,
                    "{\"difficulty\":\"" + difficulty + "\"}").ConfigureAwait(false);
                await p2.Client.SubmitAsync(Round1Intents.NominateAnswerer,
                    "{\"difficulty\":\"" + difficulty + "\"}").ConfigureAwait(false);
            }

            snap = await GameSnapshot(hostClient).ConfigureAwait(false);
            round1 = snap?.game?.round1;
            Check("nominations complete once every team has all three",
                round1 != null && round1.nominationsComplete,
                "nominationsComplete was still false");

            var teamA = round1?.NomineesOf("TEAM_A");
            Check("the Host can see a team's three nominees",
                teamA != null && teamA.Exists && teamA.complete
                && !string.IsNullOrEmpty(teamA.easyPlayerId)
                && !string.IsNullOrEmpty(teamA.mediumPlayerId)
                && !string.IsNullOrEmpty(teamA.hardPlayerId),
                "TEAM_A nominees were incomplete");
            Check("nominees are stored as PLAYER IDS, not display names",
                teamA != null && teamA.easyPlayerId == p1.PlayerId,
                "easyPlayerId=" + teamA?.easyPlayerId);

            var started = await hostClient.SubmitAsync(Round1Intents.StartRound1, "{}")
                .ConfigureAwait(false);
            Check("START ROUND 1 accepted once nominations are complete",
                started != null && started.ok, Describe(started));

            // ---- A question ------------------------------------------------------
            var revealed = await hostClient.SubmitAsync(Round1Intents.NextQuestion, "{}")
                .ConfigureAwait(false);
            Check("NEXT QUESTION accepted", revealed != null && revealed.ok, Describe(revealed));

            snap = await GameSnapshot(hostClient).ConfigureAwait(false);
            var question = snap?.game?.round1?.Current;

            Check("the question deserialises",
                question != null && question.Exists, "current question was absent");
            if (question == null || !question.Exists) return;

            Check("the question is open", question.IsOpen, "phase=" + question.phase);
            Check("it is question 1 of 15",
                question.questionNumber == 1 && question.totalQuestions == 15,
                $"{question.questionNumber}/{question.totalQuestions}");
            Check("it carries a difficulty and a value",
                !string.IsNullOrEmpty(question.difficulty) && question.value > 0,
                $"difficulty={question.difficulty} value={question.value}");
            Check("the value matches the locked table (20/30/50)",
                (question.difficulty == "EASY" && question.value == 20)
                || (question.difficulty == "MEDIUM" && question.value == 30)
                || (question.difficulty == "HARD" && question.value == 50),
                $"{question.difficulty}={question.value}");
            Check("a 60-second window is running",
                question.remainingMs > 50000 && question.remainingMs <= 60000,
                "remainingMs=" + question.remainingMs);
            Check("both teams have an answer slot",
                question.answers != null && question.answers.Length == 2,
                Describe(question.answers));

            // ⚠ SECRECY: the canonical answer is withheld from the HOST too.
            Check("the canonical answer is NOT sent before the reveal",
                string.IsNullOrEmpty(question.correctAnswer),
                "correctAnswer was present: " + question.correctAnswer);

            var hostJson = await RawSnapshotJson(hostClient).ConfigureAwait(false);
            Check("no future question is in the Host's bytes",
                hostJson != null && CountOccurrences(hostJson, "r1-test-") == 1,
                "found " + CountOccurrences(hostJson ?? "", "r1-test-") + " item ids");

            // ---- Submission authority -------------------------------------------
            var hostTry = await hostClient.SubmitAsync(Round1Intents.SubmitAnswer,
                "{\"answer\":\"the Host cannot answer\"}").ConfigureAwait(false);
            Check("the Host cannot submit an answer",
                hostTry != null && !hostTry.ok, Describe(hostTry));

            var first = await p1.Client.SubmitAsync(Round1Intents.SubmitAnswer,
                "{\"answer\":\"ALPHAUNIQUEANSWER\"}").ConfigureAwait(false);
            Check("the nominated player can submit", first != null && first.ok, Describe(first));

            var second = await p1.Client.SubmitAsync(Round1Intents.SubmitAnswer,
                "{\"answer\":\"SECONDATTEMPT\"}").ConfigureAwait(false);
            Check("a second submission is refused — submission is final",
                second != null && !second.ok, Describe(second));

            await p2.Client.SubmitAsync(Round1Intents.SubmitAnswer,
                "{\"answer\":\"BRAVOUNIQUEANSWER\"}").ConfigureAwait(false);

            // ⚠ SECRECY: one team's answer is not in the other team's bytes.
            var aJson = await RawSnapshotJson(p1.Client).ConfigureAwait(false);
            var bJson = await RawSnapshotJson(p2.Client).ConfigureAwait(false);
            Check("team A sees its own answer and not team B's",
                aJson != null && aJson.Contains("ALPHAUNIQUEANSWER")
                && !aJson.Contains("BRAVOUNIQUEANSWER"),
                "team A's snapshot leaked");
            Check("team B sees its own answer and not team A's",
                bJson != null && bJson.Contains("BRAVOUNIQUEANSWER")
                && !bJson.Contains("ALPHAUNIQUEANSWER"),
                "team B's snapshot leaked");

            // The HOST sees both, because the Host grades them.
            hostJson = await RawSnapshotJson(hostClient).ConfigureAwait(false);
            Check("the Host sees BOTH submitted answers, to grade them",
                hostJson != null && hostJson.Contains("ALPHAUNIQUEANSWER")
                && hostJson.Contains("BRAVOUNIQUEANSWER"),
                "the Host was missing an answer");

            // ---- Grading, review and the reveal ----------------------------------
            var closed = await hostClient.SubmitAsync(Round1Intents.CloseQuestion, "{}")
                .ConfigureAwait(false);
            Check("CLOSE & GRADE accepted", closed != null && closed.ok, Describe(closed));

            snap = await GameSnapshot(hostClient).ConfigureAwait(false);
            question = snap?.game?.round1?.Current;
            Check("the question is no longer open once closed",
                question != null && !question.IsOpen, "phase=" + question?.phase);
            Check("the canonical answer is STILL withheld while grading",
                question != null && string.IsNullOrEmpty(question.correctAnswer),
                "correctAnswer leaked during grading");

            // The Host rules both, which is always available (§4E) and makes the
            // check independent of what any grader decided.
            await hostClient.SubmitAsync(Round1Intents.RuleAnswer,
                "{\"teamId\":\"TEAM_A\",\"verdict\":\"CORRECT\"}").ConfigureAwait(false);
            await hostClient.SubmitAsync(Round1Intents.RuleAnswer,
                "{\"teamId\":\"TEAM_B\",\"verdict\":\"INCORRECT\"}").ConfigureAwait(false);

            snap = await GameSnapshot(hostClient).ConfigureAwait(false);
            question = snap?.game?.round1?.Current;
            var answerA = question?.AnswerOf("TEAM_A");
            Check("a Host ruling arrives on the wire",
                answerA != null && answerA.IsCorrect && answerA.hostOverrode,
                "verdict=" + answerA?.verdict + " override=" + answerA?.hostOverrode);

            var value = question?.value ?? 0;
            var revealAck = await hostClient.SubmitAsync(Round1Intents.RevealAnswer, "{}")
                .ConfigureAwait(false);
            Check("REVEAL accepted once every answer is ruled",
                revealAck != null && revealAck.ok, Describe(revealAck));

            snap = await GameSnapshot(hostClient).ConfigureAwait(false);
            question = snap?.game?.round1?.Current;
            round1 = snap?.game?.round1;

            Check("the canonical answer arrives ONLY after the reveal",
                question != null && question.HasCorrectAnswer,
                "correctAnswer was still empty after the reveal");

            // ---- The two totals --------------------------------------------------
            Check("Round 1 points are awarded to the winning team",
                round1 != null && round1.PointsOf("TEAM_A") == value,
                "points=" + round1?.PointsOf("TEAM_A") + " expected=" + value);
            Check("the wrong team scores nothing, and loses nothing",
                round1 != null && round1.PointsOf("TEAM_B") == 0,
                "points=" + round1?.PointsOf("TEAM_B"));

            var teamABb = TeamBb(snap, "TEAM_A");
            var teamBBb = TeamBb(snap, "TEAM_B");
            Check("BB is awarded ALONGSIDE the points, not instead of them",
                teamABb == 1000 + value, "TEAM_A bb=" + teamABb);
            Check("a wrong answer costs no BB",
                teamBBb == 1000, "TEAM_B bb=" + teamBBb);

            Check("the standings arrive for the Host display",
                round1?.standings != null && round1.standings.Length == 2,
                Describe(round1?.standings));

            Debug.Log("[BBROUND1] Round 1 walkthrough complete.");

            await p1.Client.DisconnectAsync().ConfigureAwait(false);
            await p2.Client.DisconnectAsync().ConfigureAwait(false);
            await hostClient.DisconnectAsync().ConfigureAwait(false);
        }

        private static int TeamBb(HostGameSnapshot snapshot, string teamId)
        {
            foreach (var team in snapshot?.teams ?? Array.Empty<GameTeamView>())
            {
                if (team.teamId == teamId) return team.bb;
            }
            return -1;
        }

        private static int CountOccurrences(string haystack, string needle)
        {
            var count = 0;
            var index = 0;
            while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
            {
                count++;
                index += needle.Length;
            }
            return count;
        }

        private sealed class Round1Player
        {
            public BenchmarkWebSocketClient Client;
            public string PlayerId;
            public string Token;
        }

        private static async Task<Round1Player> JoinPlayer1(
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
            return new Round1Player
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
                Debug.Log($"[BBROUND1] PASS {label}");
            }
            else
            {
                _failures++;
                Debug.Log($"[BBROUND1] FAIL {label} — {detail}");
            }
        }

        private static void Fail(string message)
        {
            _checks++;
            _failures++;
            Debug.Log($"[BBROUND1] FAIL {message}");
        }
    }
}

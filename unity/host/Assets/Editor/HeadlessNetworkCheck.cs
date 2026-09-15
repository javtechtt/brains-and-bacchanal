using System;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using BrainsAndBacchanal.Net;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal.EditorTools
{
    /// <summary>
    /// Headless end-to-end check of the Unity WebSocket client — DEVELOPMENT ONLY.
    ///
    /// Runs the SAME BenchmarkWebSocketClient and the SAME protocol DTOs the
    /// NetworkingTest scene uses, against the real running benchmark server, in
    /// batch mode. This exists because "the C# compiled" proves almost nothing
    /// about whether the wire protocol actually round-trips — the framing, the
    /// long-vs-int timestamps, the snapshot parsing and the ack correlation all
    /// have to be verified against the real server, not assumed.
    ///
    /// Invoked with:
    ///   Unity.exe -batchmode -quit -nographics -noUpm -projectPath ... \
    ///     -executeMethod BrainsAndBacchanal.EditorTools.HeadlessNetworkCheck.Run
    ///
    /// Server host/port come from BB_BENCH_HOST / BB_BENCH_PORT so the same check
    /// can target localhost or a LAN address without editing code.
    /// </summary>
    public static class HeadlessNetworkCheck
    {
        private static int _checks;
        private static int _failures;

        public static void Run()
        {
            var host = Environment.GetEnvironmentVariable("BB_BENCH_HOST");
            if (string.IsNullOrEmpty(host)) host = "127.0.0.1";

            var portText = Environment.GetEnvironmentVariable("BB_BENCH_PORT");
            if (!int.TryParse(portText, out var port)) port = 4500;

            try
            {
                // Task.Run, not a direct GetResult() on the calling thread.
                //
                // Unity installs a synchronization context on its main thread.
                // Blocking that thread while awaiting work whose continuations
                // want to return to it is a deadlock — which is exactly what
                // happened on the first attempt: the check connected, printed
                // nothing further, and hung until killed. Running the whole
                // sequence on a thread-pool thread (combined with
                // ConfigureAwait(false) throughout the client) removes the
                // dependency on the main thread entirely.
                Task.Run(() => RunAsync(host, port)).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                Fail("unhandled exception: " + ex.Message);
            }

            Debug.Log($"[BBCHECK] SUMMARY checks={_checks} failures={_failures}");
            EditorApplication.Exit(_failures == 0 ? 0 : 1);
        }

        private static async Task RunAsync(string host, int port)
        {
            var url = $"ws://{host}:{port}/benchmark/ws";
            var identity = "unity-headless-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            var client = new BenchmarkWebSocketClient();

            Debug.Log($"[BBCHECK] connecting to {url}");

            // 1. Connect
            var connected = await client.ConnectAsync(url).ConfigureAwait(false);
            Check("connect", connected, client.LastError);
            if (!connected) return;

            // 2. Identify, and confirm the server acknowledges
            var helloPayload = JsonUtility.ToJson(new BenchmarkHelloPayload
            {
                benchmarkClientId = identity,
                isHost = true,
                label = "unity-headless",
            });
            var helloAck = await client.SubmitAsync(BenchmarkIntents.Hello, helloPayload).ConfigureAwait(false);
            Check("hello acknowledged", helloAck.ok, Describe(helloAck));

            // 3. Receive the CLIENT_JOINED event carrying a snapshot
            var joinedFrame = await WaitForEvent(client, BenchmarkEvents.ClientJoined, 5000).ConfigureAwait(false);
            Check("received CLIENT_JOINED event", joinedFrame != null, "no event within 5s");

            BenchmarkSnapshot snapshot = null;
            if (joinedFrame != null)
            {
                var envelope = WireFraming.ParseEvent(joinedFrame);
                Check("event envelope parsed", envelope != null, "ParseEvent returned null");

                if (envelope != null)
                {
                    Check("protocol version matches",
                        ProtocolVersion.IsSupported(envelope.protocolVersion),
                        $"server={envelope.protocolVersion} unity={ProtocolVersion.Current}");

                    // Sequence numbers and timestamps must survive deserialisation —
                    // epoch ms overflows Int32, so this is a real correctness check.
                    Check("sequence number deserialised", envelope.seq > 0,
                        "seq=" + envelope.seq);
                    Check("server timestamp deserialised (ms precision)",
                        envelope.serverTime > 1_600_000_000_000L,
                        "serverTime=" + envelope.serverTime);
                    Check("actor present", envelope.actor != null, "actor was null");
                }

                var payloadJson = WireFraming.ExtractEventPayload(joinedFrame);
                Check("event payload extracted", payloadJson != null, "ExtractEventPayload null");

                if (payloadJson != null)
                {
                    var joined = JsonUtility.FromJson<BenchmarkClientJoinedPayload>(payloadJson);
                    snapshot = joined?.snapshot;
                    Check("snapshot present in CLIENT_JOINED", snapshot != null, "snapshot null");
                }
            }

            // 4. Explicit snapshot request
            var snapAck = await client.SubmitAsync(BenchmarkIntents.RequestSnapshot, "{}").ConfigureAwait(false);
            Check("snapshot request acknowledged", snapAck.ok, Describe(snapAck));

            // The snapshot arrives in the ACK, not as an event: a read must not
            // consume a sequence number or broadcast to other clients.
            Check("snapshot returned in the acknowledgement",
                !string.IsNullOrEmpty(snapAck.snapshotJson), "no snapshot on ack");

            if (!string.IsNullOrEmpty(snapAck.snapshotJson))
            {
                var parsed = JsonUtility.FromJson<BenchmarkSnapshot>(snapAck.snapshotJson);
                if (parsed != null) snapshot = parsed;
            }

            // A read must not advance the sequence number. Two reads in a row
            // should report the same seq, because nothing changed.
            var seqBefore = snapshot?.seq ?? -1;
            var secondRead = await client.SubmitAsync(BenchmarkIntents.RequestSnapshot, "{}")
                .ConfigureAwait(false);
            var secondSnap = string.IsNullOrEmpty(secondRead.snapshotJson)
                ? null
                : JsonUtility.FromJson<BenchmarkSnapshot>(secondRead.snapshotJson);
            Check("reads do not consume sequence numbers",
                secondSnap != null && secondSnap.seq == seqBefore,
                $"seq went {seqBefore} -> {secondSnap?.seq}");

            if (snapshot != null)
            {
                Check("snapshot protocol version", snapshot.protocolVersion == ProtocolVersion.Current,
                    "got " + snapshot.protocolVersion);
                Check("snapshot has phase", !string.IsNullOrEmpty(snapshot.phase), "phase empty");
                Check("snapshot timer parsed", snapshot.timer != null, "timer null");
                Check("snapshot clients array parsed", snapshot.clients != null, "clients null");
                Check("snapshot transports parsed", snapshot.transports != null, "transports null");

                var sawSelf = false;
                if (snapshot.clients != null)
                {
                    foreach (var c in snapshot.clients)
                    {
                        if (c.benchmarkClientId == identity) sawSelf = true;
                    }
                }
                Check("server reports this Unity client as connected", sawSelf,
                    "identity " + identity + " not in clients[]");

                Debug.Log($"[BBCHECK] snapshot: seq={snapshot.seq} phase={snapshot.phase} "
                        + $"paused={snapshot.paused} clients={snapshot.clients?.Length ?? 0} "
                        + $"timerActive={snapshot.timer?.active} "
                        + $"transports(ws={snapshot.transports?.websocket},sio={snapshot.transports?.socketio})");
            }

            // 5. A rejected intent must come back as a structured rejection, not a
            //    silent failure or an exception.
            var badAck = await client.SubmitAsync("TOTALLY_NOT_A_REAL_INTENT", "{}").ConfigureAwait(false);
            Check("unknown intent rejected", !badAck.ok, "unexpectedly accepted");
            Check("rejection carries a code",
                badAck.error != null && !string.IsNullOrEmpty(badAck.error.code),
                "no code on rejection");

            // 6. Duplicate intent id must be rejected as DUPLICATE_INTENT
            var sharedId = Guid.NewGuid().ToString("N");
            var first = await client.SubmitAsync(BenchmarkIntents.Ping,
                "{\"pingId\":\"dup\",\"clientSentAt\":0}", sharedId).ConfigureAwait(false);
            var second = await client.SubmitAsync(BenchmarkIntents.Ping,
                "{\"pingId\":\"dup\",\"clientSentAt\":0}", sharedId).ConfigureAwait(false);
            Check("first of duplicate pair accepted", first.ok, Describe(first));
            Check("duplicate intent rejected", !second.ok && second.error?.code == "DUPLICATE_INTENT",
                Describe(second));

            // 7. Clean disconnect
            await client.DisconnectAsync().ConfigureAwait(false);
            Check("disconnected cleanly",
                client.State == BenchmarkWebSocketClient.ConnectionState.Disconnected,
                "state=" + client.State);

            // 8. Reconnect with the SAME identity — no duplicate must be created
            await Task.Delay(400).ConfigureAwait(false);
            var reconnected = await client.ConnectAsync(url).ConfigureAwait(false);
            Check("reconnect", reconnected, client.LastError);

            if (reconnected)
            {
                var reAck = await client.SubmitAsync(BenchmarkIntents.Hello, helloPayload).ConfigureAwait(false);
                Check("hello after reconnect acknowledged", reAck.ok, Describe(reAck));

                var reFrame = await WaitForEvent(client, BenchmarkEvents.ClientJoined, 5000).ConfigureAwait(false);
                Check("fresh state received after reconnect", reFrame != null, "no event");

                if (reFrame != null)
                {
                    var payloadJson = WireFraming.ExtractEventPayload(reFrame);
                    var joined = payloadJson == null
                        ? null
                        : JsonUtility.FromJson<BenchmarkClientJoinedPayload>(payloadJson);

                    Check("server flagged this as a reconnect", joined != null && joined.reconnected,
                        "reconnected flag was false");

                    var matches = 0;
                    if (joined?.snapshot?.clients != null)
                    {
                        foreach (var c in joined.snapshot.clients)
                        {
                            if (c.benchmarkClientId == identity) matches++;
                        }
                    }
                    Check("no duplicate Unity identity created", matches == 1,
                        "found " + matches + " entries for " + identity);
                }

                await client.DisconnectAsync().ConfigureAwait(false);
            }
        }

        /// <summary>Wait for a specific event type, draining frames as they arrive.</summary>
        private static async Task<string> WaitForEvent(
            BenchmarkWebSocketClient client, string eventType, int timeoutMs)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                foreach (var frame in client.DrainInbound())
                {
                    var envelope = WireFraming.ParseEvent(frame);
                    if (envelope != null && envelope.type == eventType) return frame;
                }
                await Task.Delay(50).ConfigureAwait(false);
            }
            return null;
        }

        private static string Describe(IntentAck ack)
        {
            if (ack == null) return "null ack";
            return ack.ok ? $"ok seq={ack.seq}" : $"{ack.error?.code}: {ack.error?.message}";
        }

        private static void Check(string label, bool passed, string detail)
        {
            _checks++;
            if (passed)
            {
                Debug.Log($"[BBCHECK] PASS  {label}");
            }
            else
            {
                _failures++;
                Debug.Log($"[BBCHECK] FAIL  {label}  ({detail})");
            }
        }

        private static void Fail(string message)
        {
            _checks++;
            _failures++;
            Debug.Log($"[BBCHECK] FAIL  {message}");
        }
    }
}

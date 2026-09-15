using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using BrainsAndBacchanal.Net;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal
{
    /// <summary>
    /// Phase 3 Unity networking test — DEVELOPMENT ONLY, DELIBERATELY UGLY.
    ///
    /// This proves Unity works as the future Host client. It is NOT the game
    /// presentation: no Family Feud board, no Bacchanal animation, no Market, no
    /// artwork. Phase 8 builds all of that, after the game logic works.
    ///
    /// UNITY IS A CLIENT, NOT AN AUTHORITY (CLAUDE.md, ARCHITECTURE.md §1):
    /// every value on screen is rendered from server state. This script does not
    /// decide a buzzer winner, whether a timer expired, a pause state, a BB value
    /// or event ordering. Host button presses are submitted as INTENTS; the server
    /// decides and the result comes back as an authoritative event.
    ///
    /// Rendered with IMGUI (OnGUI) on purpose — it needs no scene assets, no
    /// prefabs, no Canvas wiring, and therefore no UI work that Phase 8 would only
    /// throw away.
    /// </summary>
    public class NetworkingTest : MonoBehaviour
    {
        [Header("Benchmark server")]
        [Tooltip("Host/IP of the Phase 3 benchmark server.")]
        public string serverHost = "127.0.0.1";

        [Tooltip("Benchmark server port (see pnpm benchmark:server).")]
        public int serverPort = 4500;

        private readonly BenchmarkWebSocketClient _client = new BenchmarkWebSocketClient();

        /// <summary>
        /// Stable across reconnects, so the server recognises a returning Unity
        /// Host as the SAME identity rather than creating a duplicate.
        /// </summary>
        private string _identity;

        private BenchmarkSnapshot _snapshot;
        private readonly List<string> _recentEvents = new List<string>();
        private string _lastAck = "—";
        private string _reconnectStatus = "never connected";
        private int _reconnectCount;
        private Vector2 _scroll;

        /// <summary>
        /// Unscaled time when <see cref="_snapshot"/> arrived.
        ///
        /// Used ONLY to interpolate the displayed countdown between snapshots —
        /// see DisplayedRemainingMs. Unscaled so a paused/!focused Editor or a
        /// changed Time.timeScale cannot distort the display.
        /// </summary>
        private float _snapshotReceivedAt = -1f;

        /// <summary>Seconds between authoritative state refreshes while connected.</summary>
        private const float StateRefreshSeconds = 0.5f;
        private float _nextStateRefreshAt;

        private const string RoomId = "benchmark";
        private const int MaxRecentEvents = 12;

        private void Awake()
        {
            // Let a standalone build target a different server without rebuilding:
            //   BrainsAndBacchanalHost.exe --bb-host 192.168.50.62 --bb-port 4500
            // or via the BB_BENCH_HOST / BB_BENCH_PORT environment variables.
            ApplyServerOverrides();

            // Persisted so a domain reload or a restart reclaims the same identity,
            // which is what makes the "no duplicate Unity Host" check meaningful.
            _identity = PlayerPrefs.GetString("bb-unity-host-id", string.Empty);
            if (string.IsNullOrEmpty(_identity))
            {
                _identity = "unity-host-" + Guid.NewGuid().ToString("N").Substring(0, 8);
                PlayerPrefs.SetString("bb-unity-host-id", _identity);
                PlayerPrefs.Save();
            }
        }

        /// <summary>
        /// Read server host/port from command line or environment.
        ///
        /// A standalone build has no Inspector, so without this the .exe would be
        /// pinned to whatever was serialised into the scene — which makes testing
        /// it against a LAN address impossible without a rebuild.
        /// </summary>
        private void ApplyServerOverrides()
        {
            var args = Environment.GetCommandLineArgs();
            for (var i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "--bb-host") serverHost = args[i + 1];
                else if (args[i] == "--bb-port" && int.TryParse(args[i + 1], out var cliPort))
                {
                    serverPort = cliPort;
                }
            }

            var envHost = Environment.GetEnvironmentVariable("BB_BENCH_HOST");
            if (!string.IsNullOrEmpty(envHost)) serverHost = envHost;

            var envPort = Environment.GetEnvironmentVariable("BB_BENCH_PORT");
            if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out var port))
            {
                serverPort = port;
            }
        }

        private void Update()
        {
            // Drain on the main thread: the receive loop runs off-thread and must
            // not touch Unity APIs itself.
            foreach (var frame in _client.DrainInbound()) HandleEventFrame(frame);

            // Refresh authoritative state on a timer.
            //
            // Without this the panel only updated when an EVENT happened, so a
            // running countdown sat frozen at whatever the last snapshot said —
            // exactly what real-device testing found. The server does not push
            // a per-second tick (it has no reason to), so a client that wants a
            // live countdown has to ask. The browser pages already poll every
            // 400-500ms; this is Unity's equivalent.
            if (_client.State == BenchmarkWebSocketClient.ConnectionState.Connected
                && Time.unscaledTime >= _nextStateRefreshAt)
            {
                _nextStateRefreshAt = Time.unscaledTime + StateRefreshSeconds;
                _ = RequestSnapshot(isBackgroundPoll: true);
            }
        }

        /// <summary>
        /// Remaining milliseconds to DISPLAY, smoothed between snapshots.
        ///
        /// ================== DISPLAY ONLY — NOT AUTHORITY ==================
        ///
        /// The server owns the timer. `_snapshot.timer.remainingMs` is the truth,
        /// and it is re-read twice a second above. This method only fills the gap
        /// BETWEEN those refreshes so the countdown ticks smoothly instead of
        /// stepping every 500ms.
        ///
        /// Nothing here decides anything: expiry, deadline acceptance and buzzer
        /// outcomes are all server-side facts (ARCHITECTURE.md §6, CLAUDE.md
        /// "Unity should render server state"). Every refresh snaps the display
        /// back to the server's value, so local drift cannot accumulate, and the
        /// result is floored at 0 rather than being allowed to imply expiry the
        /// server has not declared.
        ///
        /// A frozen (paused) timer is never interpolated — GAME_RULES_LOCKED.md
        /// §20 requires paused time not to consume the remaining time, so the
        /// display must hold still exactly as the server's value does.
        /// ==================================================================
        /// </summary>
        private long DisplayedRemainingMs()
        {
            var timer = _snapshot?.timer;
            if (timer == null) return 0;
            if (timer.paused || !timer.active || _snapshotReceivedAt < 0f) return timer.remainingMs;

            var elapsedMs = (long)((Time.unscaledTime - _snapshotReceivedAt) * 1000f);
            return Math.Max(0, timer.remainingMs - elapsedMs);
        }

        private async void OnApplicationQuit()
        {
            await _client.DisconnectAsync();
        }

        // ------------------------------------------------------------------
        // Networking
        // ------------------------------------------------------------------

        private async void Connect()
        {
            _reconnectStatus = "connecting...";
            var url = $"ws://{serverHost}:{serverPort}/benchmark/ws";

            var connected = await _client.ConnectAsync(url);
            if (!connected)
            {
                _reconnectStatus = "connect failed: " + _client.LastError;
                return;
            }

            // Identify, and capture the snapshot the server returns with it.
            var payload = JsonUtility.ToJson(new BenchmarkHelloPayload
            {
                benchmarkClientId = _identity,
                isHost = true,
                label = "unity-host",
            });

            var ack = await _client.SubmitAsync(BenchmarkIntents.Hello, payload);
            _lastAck = Describe(ack);

            if (ack.ok)
            {
                _reconnectCount++;
                _reconnectStatus = _reconnectCount > 1
                    ? $"reconnected (x{_reconnectCount - 1}) as {_identity}"
                    : "connected as " + _identity;

                // Ask for authoritative state immediately, rather than waiting for
                // the next broadcast — a freshly connected client must not render
                // stale or empty state.
                await RequestSnapshot();
            }
            else
            {
                _reconnectStatus = "hello rejected: " + (ack.error?.code ?? "unknown");
            }
        }

        private async void Disconnect()
        {
            await _client.DisconnectAsync();
            _reconnectStatus = "disconnected by user";
        }

        private async void Reconnect()
        {
            await _client.DisconnectAsync();
            Connect();
        }

        /// <summary>
        /// Ask the server for current authoritative state.
        /// </summary>
        /// <param name="isBackgroundPoll">
        /// True for the twice-a-second refresh that keeps the countdown live.
        /// A background poll must not overwrite "Last acknowledgement" on
        /// success, or it would erase the result of whatever button the operator
        /// just pressed before they could read it. A FAILED poll still reports,
        /// because a silently dead refresh loop is exactly the kind of thing
        /// that should be visible.
        /// </param>
        private async System.Threading.Tasks.Task RequestSnapshot(bool isBackgroundPoll = false)
        {
            var ack = await _client.SubmitAsync(BenchmarkIntents.RequestSnapshot, "{}");
            if (!isBackgroundPoll || !ack.ok) _lastAck = Describe(ack);

            // The snapshot comes back in the acknowledgement, not as an event —
            // a read must not consume a sequence number or disturb other
            // clients. See BenchmarkSession#snapshotAck.
            if (ack.ok && !string.IsNullOrEmpty(ack.snapshotJson))
            {
                var snap = SafeParse<BenchmarkSnapshot>(ack.snapshotJson);
                if (snap != null) ApplySnapshot(snap);
            }
        }

        private async void SendTestIntent()
        {
            var payload = "{\"pingId\":\"unity-" + DateTime.UtcNow.Ticks + "\",\"clientSentAt\":0}";
            var ack = await _client.SubmitAsync(BenchmarkIntents.Ping, payload);
            _lastAck = Describe(ack);
        }

        private async void HostResume()
        {
            // A Host action is an INTENT. The server decides whether it is allowed
            // (only the Host may resume — GAME_RULES_LOCKED.md §20) and Unity
            // renders whatever it decides, including a rejection.
            var ack = await _client.SubmitAsync(BenchmarkIntents.Resume, "{}");
            _lastAck = Describe(ack);
        }

        private async void RequestSnapshotButton()
        {
            await RequestSnapshot();
        }

        private static string Describe(IntentAck ack)
        {
            if (ack == null) return "no acknowledgement";
            return ack.ok
                ? $"ACCEPTED (seq {ack.seq})"
                : $"REJECTED {ack.error?.code}: {ack.error?.message}";
        }

        // ------------------------------------------------------------------
        // Server events
        // ------------------------------------------------------------------

        private void HandleEventFrame(string frame)
        {
            var envelope = WireFraming.ParseEvent(frame);
            if (envelope == null) return;

            // Protocol version is asserted on every event, not just at connect:
            // an incompatible server must be visible, not silently mis-rendered.
            if (!ProtocolVersion.IsSupported(envelope.protocolVersion))
            {
                Record($"PROTOCOL MISMATCH server={envelope.protocolVersion} unity={ProtocolVersion.Current}");
                return;
            }

            Record($"#{envelope.seq} {envelope.type}");

            var payloadJson = WireFraming.ExtractEventPayload(frame);
            if (payloadJson == null) return;

            // Several event types embed a full authoritative snapshot; take it
            // wherever it appears rather than maintaining local derived state.
            switch (envelope.type)
            {
                case BenchmarkEvents.ClientJoined:
                {
                    var joined = SafeParse<BenchmarkClientJoinedPayload>(payloadJson);
                    if (joined?.snapshot != null) ApplySnapshot(joined.snapshot);
                    break;
                }

                default:
                    // Any other event may have changed state this client does not
                    // model locally, so re-read authoritative state rather than
                    // guessing at the delta. Unity never derives state it was not
                    // told.
                    _ = RequestSnapshot();
                    break;
            }
        }

        /// <summary>
        /// Adopt a new authoritative snapshot.
        ///
        /// Stamping the arrival time here — in the ONE place snapshots are
        /// accepted — is what lets the countdown interpolate correctly, and what
        /// guarantees every refresh snaps the display back to the server's value
        /// instead of drifting.
        /// </summary>
        private void ApplySnapshot(BenchmarkSnapshot snapshot)
        {
            _snapshot = snapshot;
            _snapshotReceivedAt = Time.unscaledTime;
        }

        private static T SafeParse<T>(string json) where T : class
        {
            try
            {
                return JsonUtility.FromJson<T>(json);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private void Record(string line)
        {
            _recentEvents.Insert(0, line);
            if (_recentEvents.Count > MaxRecentEvents) _recentEvents.RemoveAt(_recentEvents.Count - 1);
        }

        // ------------------------------------------------------------------
        // UI — intentionally plain
        // ------------------------------------------------------------------

        private void OnGUI()
        {
            GUILayout.BeginArea(new Rect(12, 12, 620, Screen.height - 24));
            _scroll = GUILayout.BeginScrollView(_scroll);

            GUILayout.Label("BRAINS & BACCHANAL — Unity Host networking test (Phase 3)");
            GUILayout.Label("Development only. Not the game presentation.");
            GUILayout.Space(8);

            DrawConnectionPanel();
            GUILayout.Space(8);
            DrawServerStatePanel();
            GUILayout.Space(8);
            DrawPlayersPanel();
            GUILayout.Space(8);
            DrawEventsPanel();

            GUILayout.EndScrollView();
            GUILayout.EndArea();
        }

        private void DrawConnectionPanel()
        {
            GUILayout.Box("CONNECTION", GUILayout.ExpandWidth(true));

            Row("Connection", _client.State == BenchmarkWebSocketClient.ConnectionState.Connected
                ? "CONNECTED"
                : _client.State.ToString().ToUpperInvariant());
            Row("Transport", "raw WebSocket (System.Net.WebSockets)");
            Row("Server", $"ws://{serverHost}:{serverPort}/benchmark/ws");
            Row("Protocol version (Unity)", ProtocolVersion.Current.ToString());
            Row("Protocol version (server)", _snapshot != null ? _snapshot.protocolVersion.ToString() : "—");
            Row("Unity Host identity", _identity);
            Row("Reconnect status", _reconnectStatus);
            Row("Last acknowledgement", _lastAck);
            if (!string.IsNullOrEmpty(_client.LastError)) Row("Last error", _client.LastError);

            GUILayout.BeginHorizontal();
            if (GUILayout.Button("Connect")) Connect();
            if (GUILayout.Button("Disconnect")) Disconnect();
            if (GUILayout.Button("Reconnect")) Reconnect();
            GUILayout.EndHorizontal();

            GUILayout.BeginHorizontal();
            if (GUILayout.Button("Send Test Intent")) SendTestIntent();
            if (GUILayout.Button("Request Snapshot")) RequestSnapshotButton();
            if (GUILayout.Button("Host Resume")) HostResume();
            GUILayout.EndHorizontal();

            serverHost = GUILayout.TextField(serverHost);
        }

        private void DrawServerStatePanel()
        {
            GUILayout.Box("SERVER STATE (authoritative)", GUILayout.ExpandWidth(true));

            if (_snapshot == null)
            {
                GUILayout.Label("No snapshot yet. Connect, or press Request Snapshot.");
                return;
            }

            Row("Latest sequence number", _snapshot.seq.ToString());
            Row("Server time", _snapshot.serverTime.ToString());
            Row("Session state", _snapshot.phase ?? "—");

            var pausedText = _snapshot.paused
                ? (_snapshot.pauseReason == "player_disconnect"
                    ? $"PAUSED — player disconnected ({_snapshot.pausedByClientId ?? "unknown"})"
                    : "PAUSED — Host requested")
                : "ACTIVE";
            Row("Paused", pausedText);

            if (_snapshot.timer != null)
            {
                // Interpolated between refreshes for a smooth countdown; the
                // server's own value is shown underneath so the two can be
                // compared at a glance during testing.
                var displayedMs = DisplayedRemainingMs();

                var timerText = _snapshot.timer.active
                    ? $"{Mathf.CeilToInt(displayedMs / 1000f)}s remaining"
                      + (_snapshot.timer.paused ? " (FROZEN)" : "")
                    : "inactive";
                Row("Timer", timerText);
                Row("Timer remaining (ms, displayed)", displayedMs.ToString());
                Row("Timer remaining (ms, server)", _snapshot.timer.remainingMs.ToString());
            }

            Row("Buzzer", _snapshot.buzzerOpen ? $"OPEN (round {_snapshot.buzzerRound})" : "closed");

            // Displayed, never computed. The server decided this on receive order.
            Row("Benchmark buzzer winner", _snapshot.acceptedBuzz != null
                ? $"{_snapshot.acceptedBuzz.benchmarkClientId} (+{_snapshot.acceptedBuzz.elapsedSinceOpenMs}ms)"
                : "—");

            if (_snapshot.transports != null)
            {
                Row("Transports",
                    $"socketio={_snapshot.transports.socketio} websocket={_snapshot.transports.websocket}"
                    + (_snapshot.transports.mixed ? "  [MIXED]" : ""));
            }
        }

        private void DrawPlayersPanel()
        {
            var count = _snapshot?.clients?.Length ?? 0;
            GUILayout.Box($"CONNECTED BENCHMARK CLIENTS ({count})", GUILayout.ExpandWidth(true));

            if (_snapshot?.clients == null || _snapshot.clients.Length == 0)
            {
                GUILayout.Label("None reported.");
                return;
            }

            foreach (var client in _snapshot.clients)
            {
                var role = client.isHost ? "HOST  " : "PLAYER";
                var state = client.connected ? "online " : "offline";
                GUILayout.Label($"  [{state}] {role}  {client.label}  ({client.transport ?? "—"})");
            }
        }

        private void DrawEventsPanel()
        {
            GUILayout.Box("RECENT SERVER EVENTS", GUILayout.ExpandWidth(true));

            if (_recentEvents.Count == 0)
            {
                GUILayout.Label("None yet.");
                return;
            }

            var sb = new StringBuilder();
            foreach (var line in _recentEvents) sb.AppendLine("  " + line);
            GUILayout.Label(sb.ToString());
        }

        private static void Row(string label, string value)
        {
            GUILayout.BeginHorizontal();
            GUILayout.Label(label, GUILayout.Width(210));
            GUILayout.Label(value);
            GUILayout.EndHorizontal();
        }
    }
}

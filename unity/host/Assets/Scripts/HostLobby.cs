using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;
using BrainsAndBacchanal.Net;
using BrainsAndBacchanal.Protocol;
// Aliased, not imported wholesale: System.Diagnostics.Debug would collide with
// UnityEngine.Debug the moment anything in this file logs.
using Stopwatch = System.Diagnostics.Stopwatch;
using BrainsAndBacchanal.Util;

namespace BrainsAndBacchanal
{
    /// <summary>
    /// The functional Unity Host screen — Phases 4 and 5.
    ///
    /// It creates a room, shows the code and a scannable QR, lists players as
    /// they join, lets the Host build teams, locks them, and starts the game.
    ///
    /// The Phase 5 ENGINE TEST PANEL lives in HostEnginePanel.cs — a separate
    /// partial so that development-only tooling is obvious at a glance and can
    /// be deleted later without touching the lobby.
    ///
    /// DELIBERATELY UNSTYLED. IMGUI, no artwork, no animation, no sound. Phase 8
    /// owns presentation; building it now would mean rebuilding it then.
    ///
    /// UNITY DECIDES NOTHING. Every button sends an intent and waits for the
    /// server's answer. The panel renders the snapshot it is given — it never
    /// predicts the outcome locally, so a rejected action simply leaves the
    /// display showing the truth.
    /// </summary>
    public partial class HostLobby : MonoBehaviour
    {
        [Header("Server")]
        [Tooltip("Game server host. The player web app is assumed on port 3000 of the same machine.")]
        public string serverHost = "127.0.0.1";

        public int serverPort = 4000;

        /// <summary>
        /// Connect over wss:// instead of ws://, with no explicit port.
        ///
        /// For a tunnel (Cloudflare Tunnel, ngrok, or a real deployment behind
        /// TLS): the tunnel terminates TLS on 443 and there is no separate port
        /// to name, so `serverPort` would be meaningless there. Off by default —
        /// D-014's raw-WebSocket decision and every LAN party test to date used
        /// plain ws://, and this field must not change that default behaviour.
        /// </summary>
        [Tooltip("Connect over wss:// with no port — for a tunnel or a TLS deployment. Leave off for a LAN party.")]
        public bool serverUseTls;

        private readonly BenchmarkWebSocketClient _client = new BenchmarkWebSocketClient();

        private LobbySnapshot _snapshot;

        /// <summary>
        /// Authoritative game state, once a game is running.
        ///
        /// Replaced wholesale from a server snapshot rather than patched from
        /// individual event payloads — a patched view drifts the moment one
        /// event is missed, and nothing here is entitled to compute game state
        /// of its own.
        /// </summary>
        private HostGameSnapshot _game;

        /// <summary>
        /// When the current game snapshot arrived.
        ///
        /// A running timer emits no events, so the Host interpolates its
        /// countdown from this instant rather than showing a value that only
        /// changes when something else happens. See DisplayRemainingMs.
        ///
        /// Uses Stopwatch, NOT Time.realtimeSinceStartup: this is stamped inside
        /// an async continuation that runs on a thread-pool thread (the whole
        /// client is ConfigureAwait(false)), and Unity's Time API may only be
        /// read on the main thread. Stopwatch is monotonic and thread-safe, and
        /// unlike DateTime it cannot jump if the system clock is adjusted
        /// mid-game.
        /// </summary>
        private long _gameSnapshotAtTicks;

        private string _roomCode = "";
        private string _hostToken = "";
        private string _joinUrl = "";
        private string _status = "Not connected.";
        private string _lastError = "";

        /// <summary>Most recent gameplay event type, for the test display.</summary>
        private string _lastEvent = "";

        private Texture2D _qrTexture;
        private string _qrEncodedUrl = "";

        /// <summary>Player currently selected for a team action.</summary>
        private string _selectedPlayerId = "";


        private Vector2 _playerScroll;
        private bool _busy;

        /// <summary>
        /// UI-state writes deferred from a background thread to Update().
        ///
        /// THE BUG THIS EXISTS TO FIX: every async method in this file awaits the
        /// network client with ConfigureAwait(false) — deliberately, per
        /// `_gameSnapshotAtTicks`'s comment, because touching Unity's Time API off
        /// the main thread is illegal and Stopwatch is the safe alternative. The
        /// cost of that choice is that everything AFTER an awaited call —
        /// including `_game = snapshot`, `_status = "..."`, `_busy = false` —
        /// resumes on a thread-pool thread, not Unity's main thread.
        ///
        /// OnGUI captures `_game`/`_snapshot` into a local ONCE per invocation
        /// specifically so Layout and Repaint see identical data within one call
        /// — but Unity calls OnGUI MORE THAN ONCE per visual frame, and nothing
        /// stopped a background-thread write from landing between those two
        /// separate calls. When it did — e.g. `_game` flipping from "not running"
        /// to "running" between Layout and Repaint — IMGUI throws
        /// "Getting control N's position in a group with only N controls",
        /// because the two passes drew a different number of controls.
        ///
        /// The fix follows the SAME pattern `BenchmarkWebSocketClient` already
        /// uses for inbound messages: background threads enqueue an action rather
        /// than mutating shared state directly, and Update() — main thread only —
        /// drains and applies them once per frame, before OnGUI runs at all.
        /// </summary>
        private readonly ConcurrentQueue<Action> _pendingMainThreadActions = new ConcurrentQueue<Action>();

        /// <summary>
        /// Queue a UI-state write to run on the main thread.
        ///
        /// Every assignment to `_snapshot`, `_game`, `_status`, `_lastError` or
        /// `_busy` from inside an async continuation MUST go through this rather
        /// than assigning directly — see `_pendingMainThreadActions`'s comment.
        /// </summary>
        private void RunOnMainThread(Action action) => _pendingMainThreadActions.Enqueue(action);

        // -------------------------------------------------------------------
        // Lifecycle
        // -------------------------------------------------------------------

        private void Update()
        {
            // Apply queued UI-state writes BEFORE draining messages: a message
            // handled below may itself queue a follow-up write (RefreshSnapshotAsync
            // etc.), and applying this frame's backlog first keeps that ordering
            // predictable rather than interleaved.
            while (_pendingMainThreadActions.TryDequeue(out var action))
            {
                action();
            }

            // Drain on the main thread: the socket's continuations run on thread
            // pool threads and Unity API calls must not.
            foreach (var message in _client.DrainInbound())
            {
                HandleMessage(message);
            }
        }

        private void OnDestroy()
        {
            if (_qrTexture != null) Destroy(_qrTexture);
            _ = _client.DisconnectAsync();
        }

        private void HandleMessage(string message)
        {
            var kind = WireFraming.ReadFrameKind(message);
            if (kind != "event") return;

            var envelope = WireFraming.ParseEvent(message);
            if (envelope == null) return;

            // Any room event may have changed the roster or the teams. Rather
            // than patch state from each payload — which drifts the moment one
            // event is missed — ask for the authoritative snapshot.
            switch (envelope.type)
            {
                case RoomEvents.PlayerJoined:
                case RoomEvents.PlayerReconnected:
                case RoomEvents.PlayerDisconnected:
                case RoomEvents.PlayerLeft:
                case RoomEvents.PlayerRemoved:
                case RoomEvents.TeamModeChanged:
                case RoomEvents.TeamAssignmentChanged:
                case RoomEvents.TeamsLocked:
                case RoomEvents.TeamsUnlocked:
                case RoomEvents.HostConnectionChanged:
                    _ = RefreshSnapshotAsync();
                    break;

                // A closed room is terminal — no reconnects, no reopening. A
                // refreshed snapshot would come back with status "CLOSED" and
                // leave the panel showing a dead room forever, since nothing
                // else in this class transitions away from it. Reset to the
                // create-room screen instead of merely reflecting the closed
                // state.
                case RoomEvents.RoomClosed:
                    ResetToSetupScreen("This room was closed.");
                    break;

                case RoomEvents.ConnectionSuperseded:
                    _status = "Another window took over this Host.";
                    break;

                // Every gameplay event resolves to "the game changed". The Host
                // re-reads the authoritative snapshot rather than interpreting
                // each payload, which is what keeps game rules out of Unity.
                case GameEvents.GameStarted:
                case GameEvents.PhaseChanged:
                case GameEvents.BbChanged:
                case GameEvents.ChallengePrepared:
                case GameEvents.ChallengeStarted:
                case GameEvents.ChallengeResolved:
                case GameEvents.TurnChanged:
                case GameEvents.ActivePlayersChanged:
                case GameEvents.TimerStarted:
                case GameEvents.TimerCancelled:
                case GameEvents.TimerExpired:
                case GameEvents.HostRulingRecorded:
                case GameEvents.ReviewRequested:
                case GameEvents.GamePaused:
                case GameEvents.GameResumed:
                // Phase 6 shared-systems events. THIS LIST WAS MISSING ENTIRELY
                // until reported: a player action — most noticeably locking a
                // wager — never reached the Host's screen until some OTHER,
                // Phase-5 event happened to trigger a refresh afterward. Same
                // root cause as the identical bug on the web player's side
                // (GAME_EVENT_PREFIXES in apps/web), just unfixed here because
                // Unity has its own separate event switch rather than a shared
                // prefix list.
                case SharedEvents.BacchanalCardsDealt:
                case SharedEvents.CardWindowOpened:
                case SharedEvents.CardWindowClosed:
                case SharedEvents.BacchanalCardPlayed:
                case SharedEvents.ClashOpened:
                case SharedEvents.ClashResponseReceived:
                case SharedEvents.ClashResolved:
                case SharedEvents.PartDatFight:
                case SharedEvents.CardEffectApplied:
                case SharedEvents.BacchanalImmunityTriggered:
                case SharedEvents.MarketOpened:
                case SharedEvents.MarketPurchaseRecorded:
                case SharedEvents.MarketPurchaseWithdrawn:
                case SharedEvents.MarketClosed:
                case SharedEvents.MarketItemsExpired:
                case SharedEvents.MacoMailDrawn:
                case SharedEvents.MacoMailResolved:
                case SharedEvents.AdvantageGranted:
                case SharedEvents.AdvantageUsed:
                case SharedEvents.AdvantageExpired:
                case SharedEvents.HeldEffectPlaced:
                case SharedEvents.HeldEffectConsumed:
                case SharedEvents.HostDealOffered:
                case SharedEvents.HostDealResolved:
                case SharedEvents.WagerLocked:
                case SharedEvents.WagerResolved:
                // Phase 7A — Round 2. ROUND2_CHALLENGE_RESOLVED carries the new
                // balances, so without these the awarded BB did not reach the
                // screen until some LATER event forced a refresh — and on the
                // fourth challenge there is no later event, so the last award
                // never appeared at all until Round 3 would have begun.
                case Round2Events.RoundStarted:
                case Round2Events.ChallengePrepared:
                case Round2Events.WinnerSelected:
                case Round2Events.ChallengeResolved:
                case Round2Events.RoundCompleted:
                    _lastEvent = envelope.type;
                    _ = RefreshGameSnapshotAsync();
                    break;

                // EVERY OTHER GAMEPLAY EVENT, by prefix.
                //
                // This exact gap has now bitten three times: Phase 6's events
                // were missing from this switch entirely, Phase 7A's Round 2
                // events were missing again, and the identical bug appeared on
                // the web player's side both times. The pattern is obvious in
                // hindsight — an exhaustive list of event names is a list
                // someone must remember to extend, and nobody does.
                //
                // So anything that looks like a gameplay event refreshes the
                // snapshot even if it is not named above. The cases are kept
                // for documentation and for the compiler's benefit; this is the
                // safety net, so a Round 3 event cannot silently fail to reach
                // the Host's screen the way Round 2's did.
                //
                // Refreshing on an unknown event is cheap and always correct:
                // the Host re-reads the authoritative snapshot rather than
                // interpreting any payload, so a spurious refresh costs one
                // round trip and changes nothing.
                default:
                    if (IsGameplayEvent(envelope.type))
                    {
                        _lastEvent = envelope.type;
                        _ = RefreshGameSnapshotAsync();
                    }
                    break;
            }
        }

        /// <summary>
        /// Whether an event type is gameplay, and so warrants a snapshot refresh.
        ///
        /// Prefix-matched deliberately — see the `default` case above. Room
        /// events are excluded because they are handled by name earlier in the
        /// switch and refresh the LOBBY snapshot instead, which is a different
        /// call.
        /// </summary>
        private static bool IsGameplayEvent(string type)
        {
            if (string.IsNullOrEmpty(type)) return false;

            foreach (var prefix in GameplayEventPrefixes)
            {
                if (type.StartsWith(prefix, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        /// <summary>
        /// Prefixes covering every gameplay event family.
        ///
        /// 'ROUND' covers ROUND2_*, a future ROUND3_* and ROUND_COMPLETE alike,
        /// so the next round does not have to remember this list either.
        /// </summary>
        private static readonly string[] GameplayEventPrefixes =
        {
            "GAME_", "BB_", "CHALLENGE_", "TURN_", "TIMER_", "ACTIVE_PLAYERS_",
            "HOST_RULING", "PHASE_", "REVIEW_", "BACCHANAL_", "CARD_", "CLASH_",
            "PART_DAT_FIGHT", "MARKET_", "MACO_MAIL_", "ADVANTAGE_",
            "HELD_EFFECT_", "HOST_DEAL_", "WAGER_", "ROUND",
        };

        // -------------------------------------------------------------------
        // Server actions
        // -------------------------------------------------------------------

        /// <summary>
        /// Builds ws://host:port/room/ws for a LAN party (the default and
        /// unchanged behaviour), or wss://host/room/ws with no port for a
        /// tunnel/TLS deployment when <see cref="serverUseTls"/> is set.
        /// </summary>
        private string SocketUrl => serverUseTls
            ? $"wss://{serverHost}/room/ws"
            : $"ws://{serverHost}:{serverPort}/room/ws";

        private async Task EnsureConnectedAsync()
        {
            if (_client.State == BenchmarkWebSocketClient.ConnectionState.Connected) return;

            RunOnMainThread(() => _status = "Connecting…");
            var ok = await _client.ConnectAsync(SocketUrl).ConfigureAwait(false);
            var status = ok ? "Connected." : $"Could not connect: {_client.LastError}";
            RunOnMainThread(() => _status = status);
        }

        private async Task CreateRoomAsync()
        {
            RunOnMainThread(() => _busy = true);
            try
            {
                await EnsureConnectedAsync().ConfigureAwait(false);
                if (_client.State != BenchmarkWebSocketClient.ConnectionState.Connected) return;

                // No room exists yet, so the envelope carries the agreed
                // placeholder (see NO_ROOM_ID in packages/protocol/src/room.ts).
                // RoomId lives on the client, not on an IMGUI-drawn field, so it
                // is not subject to the Layout/Repaint race and is set directly.
                _client.RoomId = "pending";

                var ack = await _client.SubmitAsync(RoomIntents.CreateRoom, "{}").ConfigureAwait(false);
                if (ack == null || !ack.ok)
                {
                    var message = ack?.error?.message ?? "Could not create a room.";
                    RunOnMainThread(() => _lastError = message);
                    return;
                }

                var payload = JsonUtility.FromJson<RoomCreatedPayload>(ack.snapshotJson);
                if (payload == null)
                {
                    RunOnMainThread(() => _lastError = "Server sent an unreadable room.");
                    return;
                }

                _client.RoomId = payload.roomId;
                RunOnMainThread(() =>
                {
                    _roomCode = payload.roomCode;
                    _hostToken = payload.hostToken;
                    _joinUrl = payload.joinUrl;
                    _snapshot = payload.snapshot;
                    _lastError = "";
                    _status = "Room open.";
                });
            }
            finally
            {
                RunOnMainThread(() => _busy = false);
            }
        }

        /// <summary>
        /// Reattach to the existing room after a Unity restart or a dropped
        /// socket. Must NOT create a second room (Phase 4 spec §28).
        /// </summary>
        private async Task ReconnectHostAsync()
        {
            if (string.IsNullOrEmpty(_hostToken))
            {
                RunOnMainThread(() => _lastError = "No Host credential to reconnect with.");
                return;
            }

            RunOnMainThread(() => _busy = true);
            try
            {
                await EnsureConnectedAsync().ConfigureAwait(false);
                if (_client.State != BenchmarkWebSocketClient.ConnectionState.Connected) return;

                var payloadJson = "{\"hostToken\":" + Quote(_hostToken) + "}";
                var ack = await _client.SubmitAsync(RoomIntents.ReconnectHost, payloadJson)
                    .ConfigureAwait(false);

                if (ack == null || !ack.ok)
                {
                    var message = ack?.error?.message ?? "Could not restore the room.";
                    RunOnMainThread(() => _lastError = message);
                    return;
                }

                var payload = JsonUtility.FromJson<HostReconnectedPayload>(ack.snapshotJson);
                if (payload == null) return;

                RunOnMainThread(() =>
                {
                    _roomCode = payload.roomCode;
                    _snapshot = payload.snapshot;
                    _lastError = "";
                    _status = "Room restored.";
                });
            }
            finally
            {
                RunOnMainThread(() => _busy = false);
            }
        }

        /// <summary>
        /// Drop all state for the room that just closed and return to the
        /// create-room screen.
        ///
        /// Closing is terminal (docs/LOBBY.md — CLOSED accepts no joins and no
        /// reconnects), so there is nothing left to reflect about this room.
        /// `_client.RoomId` is left as-is deliberately: CreateRoomAsync always
        /// overwrites it with the NO_ROOM_ID placeholder before the next
        /// CREATE_ROOM, and the socket itself stays open and reusable — a
        /// closed room does not mean a closed connection.
        /// </summary>
        /// <summary>
        /// Main-thread only: calls Destroy() on a Unity object. Every existing
        /// call site reaches this from HandleMessage, which Update() already
        /// calls on the main thread — do not call this from an async
        /// continuation without wrapping it in RunOnMainThread first.
        /// </summary>
        private void ResetToSetupScreen(string statusMessage)
        {
            _snapshot = null;
            _game = null;
            _lastEvent = "";
            _roomCode = "";
            _hostToken = "";
            _joinUrl = "";
            _selectedPlayerId = "";
            _lastError = "";
            _status = statusMessage;

            if (_qrTexture != null)
            {
                Destroy(_qrTexture);
                _qrTexture = null;
            }
            _qrEncodedUrl = "";
        }

        private async Task RefreshSnapshotAsync()
        {
            var ack = await _client.SubmitAsync(RoomIntents.RequestLobbySnapshot, "{}")
                .ConfigureAwait(false);
            if (ack == null || !ack.ok || string.IsNullOrEmpty(ack.snapshotJson)) return;

            var snapshot = JsonUtility.FromJson<LobbySnapshot>(ack.snapshotJson);
            // Deserialised on this (thread-pool) thread, which is fine — only the
            // FIELD ASSIGNMENT below needs to land on the main thread, since that
            // is what OnGUI reads.
            if (snapshot != null) RunOnMainThread(() => _snapshot = snapshot);
        }

        /// <summary>
        /// Re-read the authoritative game state.
        ///
        /// A read: it emits no event and consumes no sequence number, so calling
        /// it freely cannot inflate the room's sequence (a real Phase 3 bug).
        /// </summary>
        private async Task RefreshGameSnapshotAsync()
        {
            var ack = await _client.SubmitAsync(GameIntents.RequestGameSnapshot, "{}")
                .ConfigureAwait(false);
            if (ack == null || !ack.ok || string.IsNullOrEmpty(ack.snapshotJson)) return;

            var snapshot = JsonUtility.FromJson<HostGameSnapshot>(ack.snapshotJson);
            if (snapshot == null) return;

            // Stopwatch.GetTimestamp() is thread-safe and may be read here, off
            // the main thread — Unity's Time API could not be. But the two writes
            // below are read by OnGUI's IMGUI control-count logic, so — THE FIX
            // FOR THE CRASH THIS COMMENT SET OUT TO PREVENT — they must land on
            // the main thread together, or `_game` and `_gameSnapshotAtTicks`
            // could be read as a torn pair by two separate OnGUI invocations
            // (Layout, then Repaint) of the same visual frame.
            var capturedAtTicks = Stopwatch.GetTimestamp();
            RunOnMainThread(() =>
            {
                _game = snapshot;
                _gameSnapshotAtTicks = capturedAtTicks;
            });
        }

        /// <summary>
        /// Send a gameplay intent, then re-read both snapshots.
        ///
        /// Re-reading rather than assuming success is the same discipline as the
        /// lobby's: the server may have rejected this, and only the snapshot
        /// knows what is actually true.
        /// </summary>
        private async Task SubmitGameIntentAsync(string type, string payloadJson)
        {
            RunOnMainThread(() => _busy = true);
            try
            {
                var ack = await _client.SubmitAsync(type, payloadJson).ConfigureAwait(false);
                var message = ack != null && !ack.ok ? ack.error?.message ?? "Rejected." : "";
                RunOnMainThread(() => _lastError = message);

                await RefreshGameSnapshotAsync().ConfigureAwait(false);
                await RefreshSnapshotAsync().ConfigureAwait(false);
            }
            finally
            {
                RunOnMainThread(() => _busy = false);
            }
        }

        private async Task SubmitHostIntentAsync(string type, string payloadJson)
        {
            RunOnMainThread(() => _busy = true);
            try
            {
                var ack = await _client.SubmitAsync(type, payloadJson).ConfigureAwait(false);
                var message = ack != null && !ack.ok ? ack.error?.message ?? "Rejected." : "";
                RunOnMainThread(() => _lastError = message);

                if (ack != null && ack.ok && type == RoomIntents.CloseRoom)
                {
                    // No point re-reading a snapshot of a room that no longer
                    // accepts anything: HandleMessage's ROOM_CLOSED case already
                    // resets to the create-room screen once the server's own
                    // broadcast confirms the close.
                    return;
                }

                // Re-read rather than assume: the server may have rejected this,
                // and the snapshot is the only thing that knows.
                await RefreshSnapshotAsync().ConfigureAwait(false);
            }
            finally
            {
                RunOnMainThread(() => _busy = false);
            }
        }

        // -------------------------------------------------------------------
        // QR
        // -------------------------------------------------------------------

        /// <summary>
        /// Render the join URL as a QR texture, regenerating only when the URL
        /// changes — encoding every frame would be wasteful and pointless.
        /// </summary>
        private Texture2D GetQrTexture(string url)
        {
            if (_qrTexture != null && _qrEncodedUrl == url) return _qrTexture;

            var grid = QrCode.Encode(url);
            if (grid == null) return null;

            const int scale = 6;
            const int quiet = 4; // modules; the spec requires a quiet zone
            var dimension = (grid.Size + quiet * 2) * scale;

            var texture = new Texture2D(dimension, dimension, TextureFormat.RGB24, false)
            {
                // Nearest-neighbour: a smoothed QR code is a blurred QR code,
                // and blurred edges are what make a scan fail.
                filterMode = FilterMode.Point,
            };

            var pixels = new Color32[dimension * dimension];
            var white = new Color32(255, 255, 255, 255);
            var black = new Color32(0, 0, 0, 255);

            for (var y = 0; y < dimension; y++)
            {
                for (var x = 0; x < dimension; x++)
                {
                    var moduleX = x / scale - quiet;
                    // Texture rows run bottom-up; QR rows run top-down.
                    var moduleY = (dimension - 1 - y) / scale - quiet;

                    var dark = moduleX >= 0 && moduleY >= 0 &&
                               moduleX < grid.Size && moduleY < grid.Size &&
                               grid[moduleX, moduleY];

                    pixels[y * dimension + x] = dark ? black : white;
                }
            }

            texture.SetPixels32(pixels);
            texture.Apply();

            if (_qrTexture != null) Destroy(_qrTexture);
            _qrTexture = texture;
            _qrEncodedUrl = url;
            return texture;
        }

        // -------------------------------------------------------------------
        // UI
        // -------------------------------------------------------------------

        private void OnGUI()
        {
            // Unity calls OnGUI at least twice per displayed frame — a Layout
            // pass, then a Repaint pass — and an IMGUI group like
            // BeginHorizontal/EndHorizontal remembers how many controls it saw
            // during Layout so it can reuse that geometry during Repaint. If the
            // number of controls differs between the two passes, Unity throws
            // exactly the "position in a group with only N controls" exception
            // seen here.
            //
            // _snapshot is reassigned from network callbacks running through
            // Update(), NOT from inside OnGUI. Reading the mutable field
            // separately in each draw method (once for "is there a snapshot at
            // all", again for "how many teams are there") meant a snapshot
            // arriving BETWEEN the Layout and Repaint passes of one OnGUI call
            // could change which branch ran, or how many buttons a loop drew,
            // between those two passes of the very group that just threw.
            //
            // The fix: capture ONE reference at the top of OnGUI and pass it
            // through explicitly, so every draw call in this pass — Layout and
            // Repaint alike — sees the identical value.
            //
            // _game is captured for exactly the same reason, and matters MORE:
            // it changes far more often than the lobby roster (every BB award,
            // every turn, every timer event), so an uncaptured read would hit
            // the Layout/Repaint mismatch routinely rather than rarely.
            var snapshot = _snapshot;
            var game = _game;

            GUILayout.BeginArea(new Rect(16, 16, Screen.width - 32, Screen.height - 32));

            GUILayout.Label("BRAINS & BACCHANAL — HOST", HeaderStyle);
            GUILayout.Label($"{_status}   {(_busy ? "working…" : "")}");
            if (!string.IsNullOrEmpty(_lastError))
            {
                var previous = GUI.color;
                GUI.color = Color.red;
                GUILayout.Label(_lastError);
                GUI.color = previous;
            }

            GUILayout.Space(8);

            if (snapshot == null)
            {
                DrawSetup();
            }
            else
            {
                GUILayout.BeginHorizontal();
                DrawRoomPanel(snapshot, game);
                GUILayout.Space(24);
                DrawPlayersPanel(snapshot, game);
                GUILayout.Space(24);
                DrawEnginePanel(snapshot, game);
                GUILayout.Space(24);
                // Phase 6 test instrument. Separate panel and separate file, so
                // deleting it when Phase 8 builds the real presentation touches
                // nothing else.
                DrawSharedPanel(snapshot, game);
                GUILayout.Space(24);
                // Phase 7A — the first REAL round presentation, as opposed to
                // the two test instruments beside it. Still functional rather
                // than finished; Phase 8 does the theatre.
                DrawRound2Panel(snapshot, game);
                GUILayout.EndHorizontal();
            }

            GUILayout.EndArea();
        }

        private void DrawSetup()
        {
            GUILayout.BeginHorizontal();
            GUILayout.Label("Server", GUILayout.Width(50));
            serverHost = GUILayout.TextField(serverHost, GUILayout.Width(140));
            var portText = GUILayout.TextField(serverPort.ToString(), GUILayout.Width(60));
            if (int.TryParse(portText, out var parsedPort)) serverPort = parsedPort;
            GUILayout.EndHorizontal();

            GUILayout.Space(8);

            GUI.enabled = !_busy;
            if (GUILayout.Button("Create Room", GUILayout.Height(40), GUILayout.Width(220)))
            {
                _ = CreateRoomAsync();
            }

            if (!string.IsNullOrEmpty(_hostToken) &&
                GUILayout.Button("Reconnect to existing room", GUILayout.Width(220)))
            {
                _ = ReconnectHostAsync();
            }
            GUI.enabled = true;
        }

        private void DrawRoomPanel(LobbySnapshot snapshot, HostGameSnapshot game)
        {
            GUILayout.BeginVertical(GUILayout.Width(330));

            GUILayout.Label("ROOM", HeaderStyle);
            GUILayout.Label(_roomCode, CodeStyle);

            var qr = string.IsNullOrEmpty(_joinUrl) ? null : GetQrTexture(_joinUrl);
            if (qr != null)
            {
                var rect = GUILayoutUtility.GetRect(240, 240, GUILayout.ExpandWidth(false));
                GUI.DrawTexture(rect, qr, ScaleMode.ScaleToFit);
            }

            GUILayout.Label(_joinUrl, GUILayout.Width(320));

            GUILayout.Space(8);

            var room = snapshot.room;
            GUILayout.Label($"Status: {room.status}");
            GUILayout.Label($"Teams: {(room.teamsLocked ? "LOCKED" : "unlocked")}");

            GUILayout.Space(8);
            GUILayout.Label("Team mode");
            GUILayout.BeginHorizontal();
            GUI.enabled = !_busy && !room.teamsLocked;
            if (GUILayout.Toggle(room.teamMode == 2, " 2 Teams", GUILayout.Width(90)) && room.teamMode != 2)
            {
                _ = SubmitHostIntentAsync(RoomIntents.SetTeamMode, "{\"teamMode\":2}");
            }
            if (GUILayout.Toggle(room.teamMode == 3, " 3 Teams", GUILayout.Width(90)) && room.teamMode != 3)
            {
                _ = SubmitHostIntentAsync(RoomIntents.SetTeamMode, "{\"teamMode\":3}");
            }
            GUI.enabled = true;
            GUILayout.EndHorizontal();

            GUILayout.Space(12);

            GUI.enabled = !_busy;
            if (!room.teamsLocked)
            {
                if (GUILayout.Button("LOCK TEAMS", GUILayout.Height(36)))
                {
                    _ = SubmitHostIntentAsync(RoomIntents.LockTeams, "{}");
                }
            }
            else if (GUILayout.Button("Unlock teams", GUILayout.Height(28)))
            {
                _ = SubmitHostIntentAsync(RoomIntents.UnlockTeams, "{}");
            }

            GUILayout.Space(8);

            // START GAME. Enabled only once teams are locked and no game is
            // running — the server enforces both regardless, but a disabled
            // button is a better explanation than a rejection.
            var gameRunning = game != null && game.GameRunning;
            GUI.enabled = !_busy && room.teamsLocked && !gameRunning;
            if (GUILayout.Button(gameRunning ? "GAME RUNNING" : "START GAME", GUILayout.Height(40)))
            {
                _ = SubmitGameIntentAsync(GameIntents.StartGame, "{}");
            }
            GUI.enabled = true;

            GUILayout.Space(4);
            GUI.enabled = !_busy;
            if (GUILayout.Button("Close Room"))
            {
                _ = SubmitHostIntentAsync(RoomIntents.CloseRoom, "{}");
            }
            GUI.enabled = true;

            GUILayout.EndVertical();
        }

        private void DrawPlayersPanel(LobbySnapshot snapshot, HostGameSnapshot game)
        {
            GUILayout.BeginVertical();

            var players = snapshot.players ?? Array.Empty<LobbyPlayer>();
            GUILayout.Label($"PLAYERS ({players.Length})", HeaderStyle);

            // Whose disconnect will stop the game (D-011/D-021). Materialised
            // once from the captured snapshot so the Layout and Repaint passes
            // of this OnGUI call agree — the same discipline as everything else
            // drawn from mutable state here.
            var activeIds = game?.game?.challenge?.activePlayerIds ?? Array.Empty<string>();

            if (players.Length == 0)
            {
                GUILayout.Label("Waiting for players to scan the code…");
            }

            _playerScroll = GUILayout.BeginScrollView(_playerScroll, GUILayout.Height(320));

            foreach (var player in players)
            {
                GUILayout.BeginHorizontal(GUILayout.Height(26));

                var selected = _selectedPlayerId == player.playerId;
                if (GUILayout.Toggle(selected, "", GUILayout.Width(20)) != selected)
                {
                    _selectedPlayerId = selected ? "" : player.playerId;
                }

                GUILayout.Label(player.displayName, GUILayout.Width(160));

                var previous = GUI.color;
                GUI.color = player.IsConnected ? Color.green : Color.gray;
                GUILayout.Label(player.IsConnected ? "Connected" : "Disconnected", GUILayout.Width(100));
                GUI.color = previous;

                GUILayout.Label(TeamIds.Label(player.teamId), GUILayout.Width(100));

                // ACTIVE is the single most consequential fact about a player
                // during a game: theirs is the disconnect that stops play
                // (D-011/D-021). It was missing from this list, so the Host
                // could mark someone active, forget, and then be surprised when
                // locking "the other phone" paused the game. Always drawn, so
                // the control count does not change between passes.
                GUI.color = Array.IndexOf(activeIds, player.playerId) >= 0
                    ? Color.yellow
                    : new Color(1f, 1f, 1f, 0.25f);
                GUILayout.Label(
                    Array.IndexOf(activeIds, player.playerId) >= 0 ? "ACTIVE" : "—",
                    GUILayout.Width(60));
                GUI.color = previous;

                GUILayout.EndHorizontal();
            }

            GUILayout.EndScrollView();

            GUILayout.Space(8);
            DrawTeamControls(snapshot);

            GUILayout.EndVertical();
        }

        private void DrawTeamControls(LobbySnapshot snapshot)
        {
            var hasSelection = !string.IsNullOrEmpty(_selectedPlayerId);
            var locked = snapshot.room.teamsLocked;

            GUILayout.Label(hasSelection ? "Assign selected player to:" : "Select a player above.");

            GUILayout.BeginHorizontal();
            GUI.enabled = !_busy && hasSelection && !locked;

            // Materialised once, into a fixed list, rather than iterated
            // straight off TeamsInPlay(snapshot). This same `teams` value is
            // used below to size GUI.enabled state consistently, but the real
            // point is that both the Layout and Repaint pass of THIS OnGUI call
            // now iterate one list built from the one captured `snapshot` — not
            // two separate live reads of a field that Update() can change
            // between those passes.
            var teams = TeamsInPlay(snapshot);
            foreach (var teamId in teams)
            {
                if (GUILayout.Button(TeamIds.Label(teamId), GUILayout.Width(90), GUILayout.Height(30)))
                {
                    var payload = "{\"playerId\":" + Quote(_selectedPlayerId) +
                                  ",\"teamId\":" + Quote(teamId) + "}";
                    _ = SubmitHostIntentAsync(RoomIntents.AssignPlayerTeam, payload);
                }
            }

            if (GUILayout.Button("Unassign", GUILayout.Width(90), GUILayout.Height(30)))
            {
                var payload = "{\"playerId\":" + Quote(_selectedPlayerId) + "}";
                _ = SubmitHostIntentAsync(RoomIntents.UnassignPlayer, payload);
            }

            GUI.enabled = !_busy && hasSelection;
            if (GUILayout.Button("Remove", GUILayout.Width(90), GUILayout.Height(30)))
            {
                var payload = "{\"playerId\":" + Quote(_selectedPlayerId) + "}";
                _ = SubmitHostIntentAsync(RoomIntents.RemovePlayer, payload);
                _selectedPlayerId = "";
            }
            GUI.enabled = true;

            GUILayout.EndHorizontal();
        }

        /// <summary>
        /// Team ids currently in play.
        ///
        /// Takes the snapshot as a parameter and returns a materialised list
        /// rather than reading the mutable `_snapshot` field or yielding
        /// lazily. A caller must get the SAME list back if called twice within
        /// one OnGUI invocation (Layout pass, then Repaint pass) — see the
        /// comment in OnGUI. A lazy `yield return` sequence re-evaluates
        /// `_snapshot.room.teamMode` at enumeration time, which is exactly what
        /// let Update() swap in a room with a different team mode between the
        /// two passes of the same GUILayout.BeginHorizontal group.
        /// </summary>
        private static List<string> TeamsInPlay(LobbySnapshot snapshot)
        {
            var teams = new List<string> { TeamIds.A, TeamIds.B };
            if (snapshot.room.teamMode == 3) teams.Add(TeamIds.C);
            return teams;
        }

        // -------------------------------------------------------------------
        // Helpers
        // -------------------------------------------------------------------

        /// <summary>
        /// JSON-quote a string. Small and hand-rolled for the same reason as
        /// WireFraming: no third-party JSON dependency in the Host.
        /// </summary>
        private static string Quote(string value)
        {
            if (value == null) return "null";
            var builder = new StringBuilder(value.Length + 2);
            builder.Append('"');
            foreach (var c in value)
            {
                switch (c)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (c < 0x20) builder.Append("\\u").Append(((int)c).ToString("x4"));
                        else builder.Append(c);
                        break;
                }
            }
            builder.Append('"');
            return builder.ToString();
        }

        private static GUIStyle _headerStyle;
        private static GUIStyle HeaderStyle => _headerStyle ??= new GUIStyle(GUI.skin.label)
        {
            fontSize = 18,
            fontStyle = FontStyle.Bold,
        };

        private static GUIStyle _codeStyle;
        private static GUIStyle CodeStyle => _codeStyle ??= new GUIStyle(GUI.skin.label)
        {
            fontSize = 48,
            fontStyle = FontStyle.Bold,
        };
    }
}

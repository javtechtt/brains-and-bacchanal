using System;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;
using BrainsAndBacchanal.Net;
using BrainsAndBacchanal.Protocol;
using BrainsAndBacchanal.Util;

namespace BrainsAndBacchanal
{
    /// <summary>
    /// The Phase 4 Unity Host lobby — the first FUNCTIONAL Host screen.
    ///
    /// It creates a room, shows the code and a scannable QR, lists players as
    /// they join, lets the Host build teams, and locks them.
    ///
    /// DELIBERATELY UNSTYLED. IMGUI, no artwork, no animation, no sound. Phase 8
    /// owns presentation; building it now would mean rebuilding it then.
    ///
    /// UNITY DECIDES NOTHING. Every button sends an intent and waits for the
    /// server's answer. The panel renders the snapshot it is given — it never
    /// predicts the outcome locally, so a rejected action simply leaves the
    /// display showing the truth.
    /// </summary>
    public class HostLobby : MonoBehaviour
    {
        [Header("Server")]
        [Tooltip("Game server host. The player web app is assumed on port 3000 of the same machine.")]
        public string serverHost = "127.0.0.1";

        public int serverPort = 4000;

        private readonly BenchmarkWebSocketClient _client = new BenchmarkWebSocketClient();

        private LobbySnapshot _snapshot;
        private string _roomCode = "";
        private string _hostToken = "";
        private string _joinUrl = "";
        private string _status = "Not connected.";
        private string _lastError = "";

        private Texture2D _qrTexture;
        private string _qrEncodedUrl = "";

        /// <summary>Player currently selected for a team action.</summary>
        private string _selectedPlayerId = "";

        private Vector2 _playerScroll;
        private bool _busy;

        // -------------------------------------------------------------------
        // Lifecycle
        // -------------------------------------------------------------------

        private void Update()
        {
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
                case RoomEvents.RoomClosed:
                case RoomEvents.HostConnectionChanged:
                    _ = RefreshSnapshotAsync();
                    break;

                case RoomEvents.ConnectionSuperseded:
                    _status = "Another window took over this Host.";
                    break;
            }
        }

        // -------------------------------------------------------------------
        // Server actions
        // -------------------------------------------------------------------

        private string SocketUrl => $"ws://{serverHost}:{serverPort}/room/ws";

        private async Task EnsureConnectedAsync()
        {
            if (_client.State == BenchmarkWebSocketClient.ConnectionState.Connected) return;

            _status = "Connecting…";
            var ok = await _client.ConnectAsync(SocketUrl).ConfigureAwait(false);
            _status = ok ? "Connected." : $"Could not connect: {_client.LastError}";
        }

        private async Task CreateRoomAsync()
        {
            _busy = true;
            try
            {
                await EnsureConnectedAsync().ConfigureAwait(false);
                if (_client.State != BenchmarkWebSocketClient.ConnectionState.Connected) return;

                // No room exists yet, so the envelope carries the agreed
                // placeholder (see NO_ROOM_ID in packages/protocol/src/room.ts).
                _client.RoomId = "pending";

                var ack = await _client.SubmitAsync(RoomIntents.CreateRoom, "{}").ConfigureAwait(false);
                if (ack == null || !ack.ok)
                {
                    _lastError = ack?.error?.message ?? "Could not create a room.";
                    return;
                }

                var payload = JsonUtility.FromJson<RoomCreatedPayload>(ack.snapshotJson);
                if (payload == null)
                {
                    _lastError = "Server sent an unreadable room.";
                    return;
                }

                _roomCode = payload.roomCode;
                _hostToken = payload.hostToken;
                _joinUrl = payload.joinUrl;
                _client.RoomId = payload.roomId;
                _snapshot = payload.snapshot;
                _lastError = "";
                _status = "Room open.";
            }
            finally
            {
                _busy = false;
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
                _lastError = "No Host credential to reconnect with.";
                return;
            }

            _busy = true;
            try
            {
                await EnsureConnectedAsync().ConfigureAwait(false);
                if (_client.State != BenchmarkWebSocketClient.ConnectionState.Connected) return;

                var payloadJson = "{\"hostToken\":" + Quote(_hostToken) + "}";
                var ack = await _client.SubmitAsync(RoomIntents.ReconnectHost, payloadJson)
                    .ConfigureAwait(false);

                if (ack == null || !ack.ok)
                {
                    _lastError = ack?.error?.message ?? "Could not restore the room.";
                    return;
                }

                var payload = JsonUtility.FromJson<HostReconnectedPayload>(ack.snapshotJson);
                if (payload == null) return;

                _roomCode = payload.roomCode;
                _snapshot = payload.snapshot;
                _lastError = "";
                _status = "Room restored.";
            }
            finally
            {
                _busy = false;
            }
        }

        private async Task RefreshSnapshotAsync()
        {
            var ack = await _client.SubmitAsync(RoomIntents.RequestLobbySnapshot, "{}")
                .ConfigureAwait(false);
            if (ack == null || !ack.ok || string.IsNullOrEmpty(ack.snapshotJson)) return;

            var snapshot = JsonUtility.FromJson<LobbySnapshot>(ack.snapshotJson);
            if (snapshot != null) _snapshot = snapshot;
        }

        private async Task SubmitHostIntentAsync(string type, string payloadJson)
        {
            _busy = true;
            try
            {
                var ack = await _client.SubmitAsync(type, payloadJson).ConfigureAwait(false);
                _lastError = ack != null && !ack.ok ? ack.error?.message ?? "Rejected." : "";

                // Re-read rather than assume: the server may have rejected this,
                // and the snapshot is the only thing that knows.
                await RefreshSnapshotAsync().ConfigureAwait(false);
            }
            finally
            {
                _busy = false;
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

            if (_snapshot == null)
            {
                DrawSetup();
            }
            else
            {
                GUILayout.BeginHorizontal();
                DrawRoomPanel();
                GUILayout.Space(24);
                DrawPlayersPanel();
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

        private void DrawRoomPanel()
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

            var room = _snapshot.room;
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

            GUILayout.Space(4);
            if (GUILayout.Button("Close Room"))
            {
                _ = SubmitHostIntentAsync(RoomIntents.CloseRoom, "{}");
            }
            GUI.enabled = true;

            GUILayout.EndVertical();
        }

        private void DrawPlayersPanel()
        {
            GUILayout.BeginVertical();

            var players = _snapshot.players ?? Array.Empty<LobbyPlayer>();
            GUILayout.Label($"PLAYERS ({players.Length})", HeaderStyle);

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

                GUILayout.EndHorizontal();
            }

            GUILayout.EndScrollView();

            GUILayout.Space(8);
            DrawTeamControls();

            GUILayout.EndVertical();
        }

        private void DrawTeamControls()
        {
            var hasSelection = !string.IsNullOrEmpty(_selectedPlayerId);
            var locked = _snapshot.room.teamsLocked;

            GUILayout.Label(hasSelection ? "Assign selected player to:" : "Select a player above.");

            GUILayout.BeginHorizontal();
            GUI.enabled = !_busy && hasSelection && !locked;

            foreach (var teamId in TeamsInPlay())
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

        private IEnumerable<string> TeamsInPlay()
        {
            yield return TeamIds.A;
            yield return TeamIds.B;
            if (_snapshot.room.teamMode == 3) yield return TeamIds.C;
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

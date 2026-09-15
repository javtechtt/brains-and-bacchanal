using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal.Net
{
    /// <summary>
    /// Raw WebSocket client for the Phase 3 benchmark server.
    ///
    /// Uses System.Net.WebSockets.ClientWebSocket — the standard .NET API that
    /// ships with Unity. NO THIRD-PARTY PACKAGE. docs/NETWORK_BENCHMARK.md flagged
    /// that ClientWebSocket works in the Editor and in desktop standalone builds
    /// but NOT in WebGL; the Host Display is a desktop app (ARCHITECTURE.md §1),
    /// so that limitation does not apply here. It would matter if the Host ever
    /// needed to run in a browser.
    ///
    /// THREADING: ClientWebSocket is async and its continuations do not run on
    /// Unity's main thread, but Unity API calls must. So this class touches no
    /// Unity API at all — it queues received frames and the MonoBehaviour drains
    /// that queue in Update(). That is why the queue is a ConcurrentQueue and why
    /// nothing here logs via UnityEngine.Debug.
    ///
    /// UNITY IS A CLIENT. This class sends intents and surfaces server events. It
    /// decides no outcome.
    /// </summary>
    public class BenchmarkWebSocketClient
    {
        public enum ConnectionState { Disconnected, Connecting, Connected }

        private ClientWebSocket _socket;
        private CancellationTokenSource _cancellation;
        private Task _receiveLoop;

        /// <summary>Frames received from the server, drained on Unity's main thread.</summary>
        private readonly ConcurrentQueue<string> _inbound = new ConcurrentQueue<string>();

        /// <summary>
        /// Pending intent acknowledgements, keyed by requestId.
        ///
        /// This dictionary is the hand-rolled replacement for Socket.IO's ack
        /// callback — the same cost the server-side adapter and the browser client
        /// each pay. Counted as evidence for the transport decision.
        /// </summary>
        private readonly ConcurrentDictionary<string, TaskCompletionSource<IntentAck>> _pending =
            new ConcurrentDictionary<string, TaskCompletionSource<IntentAck>>();

        public ConnectionState State { get; private set; } = ConnectionState.Disconnected;

        /// <summary>Last transport-level failure, for display. Null when healthy.</summary>
        public string LastError { get; private set; }

        public string Url { get; private set; }

        public async Task<bool> ConnectAsync(string url)
        {
            await DisconnectAsync().ConfigureAwait(false);

            Url = url;
            State = ConnectionState.Connecting;
            LastError = null;

            try
            {
                _socket = new ClientWebSocket();
                _cancellation = new CancellationTokenSource();
                await _socket.ConnectAsync(new Uri(url), _cancellation.Token).ConfigureAwait(false);

                State = ConnectionState.Connected;
                _receiveLoop = Task.Run(ReceiveLoopAsync);
                return true;
            }
            catch (Exception ex)
            {
                LastError = ex.Message;
                State = ConnectionState.Disconnected;
                _socket = null;
                return false;
            }
        }

        public async Task DisconnectAsync()
        {
            var socket = _socket;
            var cancellation = _cancellation;
            _socket = null;
            _cancellation = null;

            // Fail every in-flight request rather than leaving callers awaiting
            // forever on a socket that is going away.
            foreach (var entry in _pending)
            {
                entry.Value.TrySetResult(new IntentAck
                {
                    ok = false,
                    error = new Rejection { code = "DISCONNECTED", message = "Socket closed." },
                });
            }
            _pending.Clear();

            if (socket != null)
            {
                try
                {
                    if (socket.State == WebSocketState.Open)
                    {
                        await socket.CloseAsync(
                            WebSocketCloseStatus.NormalClosure, "client closing", CancellationToken.None)
                            .ConfigureAwait(false);
                    }
                }
                catch (Exception)
                {
                    // A close that fails still ends with the socket unusable, which
                    // is the desired outcome. Nothing to recover.
                }
                finally
                {
                    socket.Dispose();
                }
            }

            cancellation?.Cancel();
            cancellation?.Dispose();

            State = ConnectionState.Disconnected;
        }

        /// <summary>
        /// Submit an intent and await the server's acknowledgement.
        ///
        /// Every intent gets exactly one ack, so the caller never has to guess
        /// whether the action applied — which is what makes idempotency usable: a
        /// retry whose ack was lost comes back DUPLICATE_INTENT rather than
        /// silently reapplying.
        /// </summary>
        public async Task<IntentAck> SubmitAsync(
            string type, string payloadJson, string intentId = null, int timeoutMs = 10000)
        {
            var socket = _socket;
            if (socket == null || socket.State != WebSocketState.Open)
            {
                return new IntentAck
                {
                    ok = false,
                    error = new Rejection { code = "DISCONNECTED", message = "Not connected." },
                };
            }

            var requestId = Guid.NewGuid().ToString("N");
            var completion = new TaskCompletionSource<IntentAck>();
            _pending[requestId] = completion;

            var frame = WireFraming.BuildIntentFrame(
                requestId,
                intentId ?? Guid.NewGuid().ToString("N"),
                "benchmark",
                type,
                payloadJson);

            try
            {
                var bytes = Encoding.UTF8.GetBytes(frame);
                await socket.SendAsync(
                    new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _pending.TryRemove(requestId, out _);
                return new IntentAck
                {
                    ok = false,
                    error = new Rejection { code = "SEND_FAILED", message = ex.Message },
                };
            }

            var completed = await Task.WhenAny(completion.Task, Task.Delay(timeoutMs)).ConfigureAwait(false);
            if (completed != completion.Task)
            {
                _pending.TryRemove(requestId, out _);
                return new IntentAck
                {
                    ok = false,
                    error = new Rejection { code = "ACK_TIMEOUT", message = "No acknowledgement." },
                };
            }

            return completion.Task.Result;
        }

        /// <summary>
        /// Drain frames received since the last call.
        ///
        /// Called from Update() so all downstream handling happens on Unity's main
        /// thread, where Unity API calls are legal.
        /// </summary>
        public List<string> DrainInbound()
        {
            var drained = new List<string>();
            while (_inbound.TryDequeue(out var frame)) drained.Add(frame);
            return drained;
        }

        private async Task ReceiveLoopAsync()
        {
            var buffer = new byte[16 * 1024];
            var builder = new StringBuilder();

            try
            {
                while (_socket != null && _socket.State == WebSocketState.Open)
                {
                    var result = await _socket.ReceiveAsync(
                        new ArraySegment<byte>(buffer), _cancellation.Token).ConfigureAwait(false);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        State = ConnectionState.Disconnected;
                        break;
                    }

                    builder.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));

                    // A message can arrive across several frames; only dispatch once
                    // EndOfMessage says it is complete.
                    if (!result.EndOfMessage) continue;

                    var message = builder.ToString();
                    builder.Clear();
                    Dispatch(message);
                }
            }
            catch (OperationCanceledException)
            {
                // Expected on a deliberate disconnect.
            }
            catch (Exception ex)
            {
                LastError = ex.Message;
            }
            finally
            {
                State = ConnectionState.Disconnected;
            }
        }

        private void Dispatch(string message)
        {
            var kind = WireFraming.ReadFrameKind(message);

            if (kind == WireFraming.FrameAck)
            {
                var requestId = WireFraming.ReadRequestId(message);
                if (requestId != null && _pending.TryRemove(requestId, out var completion))
                {
                    var ack = WireFraming.ParseAck(message)
                              ?? new IntentAck
                              {
                                  ok = false,
                                  error = new Rejection
                                  {
                                      code = "MALFORMED_ACK",
                                      message = "Could not parse acknowledgement.",
                                  },
                              };
                    completion.TrySetResult(ack);
                }
                return;
            }

            if (kind == WireFraming.FrameEvent)
            {
                // Queued rather than handled here: this runs off Unity's main thread.
                _inbound.Enqueue(message);
            }
        }
    }
}

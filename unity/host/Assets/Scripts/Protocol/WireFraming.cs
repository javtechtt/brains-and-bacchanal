using System;
using UnityEngine;

namespace BrainsAndBacchanal.Protocol
{
    /// <summary>
    /// The raw-WebSocket framing layer, mirroring
    /// apps/game-server/src/transport/websocket.ts.
    ///
    /// Raw WebSockets have no built-in request/response, so the server's adapter
    /// defines its own framing: every message carries a `kind`, an intent carries
    /// a `requestId` the server echoes on the reply.
    ///
    /// THIS FILE IS EVIDENCE FOR THE PHASE 3 TRANSPORT DECISION. Everything in it
    /// exists purely to replace the acknowledgement callback Socket.IO provides
    /// for free. The server-side adapter notes the same cost (~40 lines there);
    /// this is that cost appearing again in a third client, exactly as predicted
    /// in docs/NETWORK_BENCHMARK.md.
    ///
    /// JSON NOTE: Unity's JsonUtility cannot represent an arbitrary `payload`
    /// (there is no `unknown`/`object` support, and it silently drops unknown
    /// fields rather than erroring). So payload extraction here is done by
    /// locating the payload substring and handing that raw JSON to JsonUtility
    /// for the one concrete type the caller expects. That is the price of
    /// avoiding a third-party JSON dependency; it is contained to this file.
    /// </summary>
    public static class WireFraming
    {
        public const string FrameIntent = "intent";
        public const string FrameAck = "ack";
        public const string FrameEvent = "event";

        /// <summary>
        /// Build an intent frame.
        ///
        /// Hand-assembled rather than JsonUtility-serialised because `payload` is
        /// per-intent-type JSON that JsonUtility cannot nest generically, and
        /// because a null sessionId must be OMITTED rather than emitted as null
        /// (the server's isIntentEnvelope rejects a non-string sessionId if
        /// present; absent is the correct representation for "no session yet").
        /// </summary>
        public static string BuildIntentFrame(
            string requestId,
            string intentId,
            string roomId,
            string type,
            string payloadJson,
            string sessionId = null)
        {
            var session = string.IsNullOrEmpty(sessionId)
                ? string.Empty
                : ",\"sessionId\":" + Quote(sessionId);

            var payload = string.IsNullOrEmpty(payloadJson) ? "{}" : payloadJson;

            return "{\"kind\":\"" + FrameIntent + "\""
                 + ",\"requestId\":" + Quote(requestId)
                 + ",\"intent\":{"
                 + "\"protocolVersion\":" + ProtocolVersion.Current
                 + ",\"intentId\":" + Quote(intentId)
                 + ",\"roomId\":" + Quote(roomId)
                 + session
                 + ",\"type\":" + Quote(type)
                 + ",\"payload\":" + payload
                 + "}}";
        }

        /// <summary>The `kind` of an incoming frame, or null if unrecognisable.</summary>
        public static string ReadFrameKind(string json)
        {
            return ReadStringField(json, "kind");
        }

        public static string ReadRequestId(string json)
        {
            return ReadStringField(json, "requestId");
        }

        /// <summary>
        /// Extract the `ack` object from an ack frame and parse it.
        ///
        /// Returns null when the frame is malformed — the caller treats that as a
        /// failed request rather than crashing, since anything arriving from a
        /// network is untrusted.
        /// </summary>
        public static IntentAck ParseAck(string json)
        {
            var inner = ExtractObject(json, "ack");
            if (inner == null) return null;
            try
            {
                return JsonUtility.FromJson<IntentAck>(inner);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>Extract and parse the `event` object from an event frame.</summary>
        public static EventEnvelope ParseEvent(string json)
        {
            var inner = ExtractObject(json, "event");
            if (inner == null) return null;
            try
            {
                return JsonUtility.FromJson<EventEnvelope>(inner);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Raw JSON of an event's `payload`, for the caller to parse into whichever
        /// concrete payload type that event type implies.
        /// </summary>
        public static string ExtractEventPayload(string frameJson)
        {
            var eventJson = ExtractObject(frameJson, "event");
            return eventJson == null ? null : ExtractObject(eventJson, "payload");
        }

        /// <summary>
        /// Extract the raw JSON of a named object/array-valued field by brace
        /// matching, respecting string literals and escapes.
        ///
        /// Deliberately a small hand-rolled scanner rather than a JSON library: the
        /// project has no third-party JSON dependency (§7 — avoid third-party
        /// packages unless genuinely necessary), and the only thing needed is
        /// "give me this one sub-object verbatim".
        /// </summary>
        public static string ExtractObject(string json, string fieldName)
        {
            if (string.IsNullOrEmpty(json)) return null;

            var key = "\"" + fieldName + "\"";
            var keyIndex = json.IndexOf(key, StringComparison.Ordinal);
            if (keyIndex < 0) return null;

            var i = keyIndex + key.Length;
            while (i < json.Length && (json[i] == ' ' || json[i] == ':')) i++;
            if (i >= json.Length) return null;

            var open = json[i];
            if (open != '{' && open != '[')
            {
                // Scalar (or null) rather than an object — not what this is for.
                return null;
            }

            var close = open == '{' ? '}' : ']';
            var depth = 0;
            var inString = false;
            var escaped = false;

            for (var j = i; j < json.Length; j++)
            {
                var c = json[j];

                if (escaped) { escaped = false; continue; }
                if (c == '\\' && inString) { escaped = true; continue; }
                if (c == '"') { inString = !inString; continue; }
                if (inString) continue;

                if (c == open) depth++;
                else if (c == close)
                {
                    depth--;
                    if (depth == 0) return json.Substring(i, j - i + 1);
                }
            }

            return null;
        }

        /// <summary>Read a top-level string field. Returns null when absent.</summary>
        public static string ReadStringField(string json, string fieldName)
        {
            if (string.IsNullOrEmpty(json)) return null;

            var key = "\"" + fieldName + "\"";
            var keyIndex = json.IndexOf(key, StringComparison.Ordinal);
            if (keyIndex < 0) return null;

            var i = keyIndex + key.Length;
            while (i < json.Length && (json[i] == ' ' || json[i] == ':')) i++;
            if (i >= json.Length || json[i] != '"') return null;

            i++;
            var sb = new System.Text.StringBuilder();
            var escaped = false;

            for (; i < json.Length; i++)
            {
                var c = json[i];
                if (escaped)
                {
                    sb.Append(c == 'n' ? '\n' : c == 't' ? '\t' : c);
                    escaped = false;
                    continue;
                }
                if (c == '\\') { escaped = true; continue; }
                if (c == '"') break;
                sb.Append(c);
            }

            return sb.ToString();
        }

        private static string Quote(string value)
        {
            if (value == null) return "null";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
    }
}

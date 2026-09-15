using System;

namespace BrainsAndBacchanal.Protocol
{
    /// <summary>
    /// C# mirror of packages/protocol — the shared contract with the game server.
    ///
    /// ARCHITECTURE.md §3 defines the chain: schema -> TypeScript types -> C# DTOs.
    /// These are hand-written to match packages/protocol exactly; the TypeScript
    /// side is the source of truth and must NOT be reshaped to make C# easier.
    ///
    /// Everything here is [Serializable] and uses only fields (no properties) and
    /// plain types, because Unity's JsonUtility — the built-in serializer, chosen
    /// so this project needs no third-party JSON dependency — only handles that
    /// shape.
    ///
    /// UNITY IS A CLIENT, NOT AN AUTHORITY. CLAUDE.md: "Unity should render server
    /// state; it should not duplicate game logic." Nothing in this namespace
    /// decides a buzzer winner, a timer expiry, a BB value or a pause state. These
    /// types only carry what the server already decided.
    /// </summary>
    public static class ProtocolVersion
    {
        /// <summary>
        /// Must match PROTOCOL_VERSION in packages/protocol/src/version.ts.
        ///
        /// Compatibility is exact-match only (docs/PROTOCOL.md): a mismatch is
        /// rejected with UNSUPPORTED_PROTOCOL_VERSION rather than negotiated.
        /// </summary>
        public const int Current = 1;

        public static bool IsSupported(int version) => version == Current;
    }

    /// <summary>
    /// Who caused an event. Mirrors the Actor union in
    /// packages/protocol/src/envelope.ts.
    ///
    /// A union of four shapes in TypeScript becomes one class with a discriminant
    /// here, because JsonUtility cannot express unions. `kind` is the discriminant;
    /// the other fields are populated only for the kinds that carry them.
    ///
    /// Note `admin` is NOT `host` — docs/PROTOCOL.md is explicit that admin does
    /// not pass a Host-authority check.
    /// </summary>
    [Serializable]
    public class Actor
    {
        public string kind;
        public string sessionId;
        public string playerId;

        public bool IsHost => kind == "host";
        public bool IsServer => kind == "server";
    }

    /// <summary>
    /// Client -> server. A request, never an outcome.
    ///
    /// ARCHITECTURE.md §4: "Clients send intents. Server validates and emits
    /// resulting events." There is deliberately NO client timestamp field —
    /// ARCHITECTURE.md §6 says a client's claimed time is never the deciding time,
    /// so the protocol offers nowhere to put one. Do not add one here.
    ///
    /// `payload` is a raw JSON string rather than a typed object: payload shape is
    /// per-intent-type, and JsonUtility has no equivalent of `unknown`. The
    /// serializer writes it verbatim (see IntentSerializer).
    /// </summary>
    [Serializable]
    public class IntentEnvelope
    {
        public int protocolVersion = ProtocolVersion.Current;

        /// <summary>Idempotency key. A retried intent reusing this must not apply twice.</summary>
        public string intentId;

        public string roomId;

        /// <summary>Absent on a first join. Null is omitted by IntentSerializer.</summary>
        public string sessionId;

        public string type;
    }

    /// <summary>
    /// Server -> clients. An authoritative statement of fact.
    ///
    /// By the time Unity sees one of these, the server has already committed the
    /// change. Unity renders it; it never re-decides it.
    /// </summary>
    [Serializable]
    public class EventEnvelope
    {
        public int protocolVersion;

        /// <summary>
        /// Monotonic per room, starting at 1. A gap means this client missed an
        /// event and should request a fresh snapshot (docs/PROTOCOL.md).
        /// </summary>
        public long seq;

        /// <summary>
        /// Authoritative server epoch milliseconds. Never compared against a local
        /// clock to decide anything.
        ///
        /// long, not int: epoch milliseconds overflow Int32 (they passed 2^31 ms in
        /// 1970 + ~25 days). This is exactly the kind of detail a hand-written DTO
        /// layer has to get right.
        /// </summary>
        public long serverTime;

        public string roomId;
        public Actor actor;
        public string type;

        /// <summary>The intent that produced this event, when client-initiated.</summary>
        public string causedBy;
    }

    /// <summary>
    /// Structured rejection. Mirrors packages/protocol/src/errors.ts.
    ///
    /// docs/PROTOCOL.md: the UI must be able to react without parsing prose, so
    /// `code` carries the meaning and `message` is for humans and logs.
    /// </summary>
    [Serializable]
    public class Rejection
    {
        public string code;
        public string message;
    }

    /// <summary>
    /// Reply to a submitted intent. Mirrors IntentAck in
    /// packages/protocol/src/transport.ts.
    ///
    /// The TypeScript type is a discriminated union on `ok`; here both branches'
    /// fields coexist and `ok` selects which are meaningful.
    /// </summary>
    [Serializable]
    public class IntentAck
    {
        public bool ok;
        public long seq;
        public Rejection error;

        /// <summary>
        /// Raw JSON of the `snapshot` field, for READ-ONLY intents that return
        /// state directly in the acknowledgement.
        ///
        /// A read must not consume a sequence number or broadcast an event, so
        /// BENCHMARK_REQUEST_SNAPSHOT answers in the ack rather than emitting a
        /// BENCHMARK_SNAPSHOT event. Kept as raw JSON (not a typed field)
        /// because JsonUtility cannot nest an arbitrary object — the caller
        /// parses it into the concrete type it expects.
        /// </summary>
        [NonSerialized] public string snapshotJson;
    }
}

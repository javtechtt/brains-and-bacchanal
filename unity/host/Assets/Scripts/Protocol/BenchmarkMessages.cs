using System;

namespace BrainsAndBacchanal.Protocol
{
    /// <summary>
    /// Benchmark-only message vocabulary — C# mirror of
    /// packages/protocol/src/benchmark.ts.
    ///
    /// ================== THIS IS NOT GAME CODE ==================
    ///
    /// CLAUDE.md: "There is no digital buzzer before Family Feud." BENCHMARK_BUZZ
    /// is a NETWORK MEASUREMENT PRIMITIVE standing in for the kind of
    /// timing-sensitive interaction Family Feud and Sudden Death will later need.
    ///
    /// Nothing here may be reused by the real buzzer. Family Feud's rules —
    /// face-off, control, strikes, steal, the steal wager — are Phase 7, and
    /// several remain open in docs/OPEN_RULES.md.
    /// ===========================================================
    /// </summary>
    public static class BenchmarkIntents
    {
        public const string Hello = "BENCHMARK_HELLO";
        public const string Ping = "BENCHMARK_PING";
        public const string Buzz = "BENCHMARK_BUZZ";
        public const string OpenBuzzer = "BENCHMARK_OPEN_BUZZER";
        public const string ResetBuzzer = "BENCHMARK_RESET_BUZZER";
        public const string StartTimer = "BENCHMARK_START_TIMER";
        public const string Pause = "BENCHMARK_PAUSE";
        public const string Resume = "BENCHMARK_RESUME";
        public const string ClearStats = "BENCHMARK_CLEAR_STATS";
        public const string RequestSnapshot = "BENCHMARK_REQUEST_SNAPSHOT";
    }

    public static class BenchmarkEvents
    {
        public const string Welcome = "BENCHMARK_WELCOME";
        public const string Snapshot = "BENCHMARK_SNAPSHOT";
        public const string BuzzerOpened = "BENCHMARK_BUZZER_OPENED";
        public const string BuzzAccepted = "BENCHMARK_BUZZ_ACCEPTED";
        public const string BuzzerReset = "BENCHMARK_BUZZER_RESET";
        public const string TimerStarted = "BENCHMARK_TIMER_STARTED";
        public const string Paused = "BENCHMARK_PAUSED";
        public const string Resumed = "BENCHMARK_RESUMED";
        public const string ClientJoined = "BENCHMARK_CLIENT_JOINED";
        public const string ClientLeft = "BENCHMARK_CLIENT_LEFT";
        public const string StatsCleared = "BENCHMARK_STATS_CLEARED";
    }

    /// <summary>
    /// Identity for a benchmark connection.
    ///
    /// NOT the production player system. Phase 4 builds real room codes, QR
    /// joining, names, teams and reconnect tokens. This is the minimum needed to
    /// prove a reconnecting socket reclaims the same identity.
    /// </summary>
    [Serializable]
    public class BenchmarkHelloPayload
    {
        public string benchmarkClientId;
        public bool isHost;
        public string label;
    }

    /// <summary>One connected benchmark client, as the server sees it.</summary>
    [Serializable]
    public class BenchmarkClientInfo
    {
        public string benchmarkClientId;
        public bool connected;
        public bool isHost;
        public string label;

        /// <summary>
        /// "socketio" | "websocket" | null. Tracked per client because both
        /// adapters feed one session, so a mixed-transport session is possible
        /// (and is a real, intentional property — see docs/NETWORK_BENCHMARK.md).
        /// </summary>
        public string transport;
    }

    /// <summary>Per-transport connection counts and whether the session is mixed.</summary>
    [Serializable]
    public class BenchmarkTransportSummary
    {
        public int socketio;
        public int websocket;
        public bool mixed;
    }

    /// <summary>
    /// Server-authoritative timer state.
    ///
    /// Unity RENDERS remainingMs; it never decides expiry. GAME_RULES_LOCKED.md
    /// §20 — paused time must not consume the remaining time, and that arithmetic
    /// belongs to the server's Deadline, not to this client.
    /// </summary>
    [Serializable]
    public class BenchmarkTimerInfo
    {
        public bool active;
        public long durationMs;
        public long remainingMs;
        public bool paused;
    }

    /// <summary>
    /// The accepted buzz, as decided by the server on receive order alone.
    ///
    /// Unity displays this winner. It must never compute one locally — CLAUDE.md
    /// forbids client code deciding "who buzzed first".
    /// </summary>
    [Serializable]
    public class BenchmarkBuzzAccepted
    {
        public string benchmarkClientId;
        public string connectionId;
        public long serverTime;
        public long elapsedSinceOpenMs;
        public int round;
    }

    /// <summary>
    /// Full authoritative state, as served by GET /benchmark/state and carried in
    /// BENCHMARK_SNAPSHOT / BENCHMARK_CLIENT_JOINED payloads.
    ///
    /// CONTENT SAFETY: carries no question text, accepted answers or board labels.
    /// </summary>
    [Serializable]
    public class BenchmarkSnapshot
    {
        public int protocolVersion;
        public long seq;
        public long serverTime;
        public string phase;
        public bool paused;

        /// <summary>"host_requested" | "player_disconnect" | null.</summary>
        public string pauseReason;
        public string pausedByClientId;

        public bool buzzerOpen;
        public int buzzerRound;
        public BenchmarkBuzzAccepted acceptedBuzz;
        public BenchmarkTimerInfo timer;
        public BenchmarkTransportSummary transports;
        public BenchmarkClientInfo[] clients;
    }

    /// <summary>Payload of BENCHMARK_CLIENT_JOINED, which embeds a full snapshot.</summary>
    [Serializable]
    public class BenchmarkClientJoinedPayload
    {
        public string benchmarkClientId;
        public bool reconnected;
        public BenchmarkSnapshot snapshot;
    }

    /// <summary>Payload of BENCHMARK_TIMER_STARTED.</summary>
    [Serializable]
    public class BenchmarkTimerStartedPayload
    {
        public long startedAt;
        public long durationMs;
    }

    /// <summary>Payload of BENCHMARK_PAUSED.</summary>
    [Serializable]
    public class BenchmarkPausedPayload
    {
        public string reason;
        public string disconnectedClientId;
    }
}

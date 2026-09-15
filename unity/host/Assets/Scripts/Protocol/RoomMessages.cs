using System;

namespace BrainsAndBacchanal.Protocol
{
    /// <summary>
    /// C# mirror of the Phase 4 production room protocol
    /// (packages/protocol/src/room.ts).
    ///
    /// The TypeScript side is the source of truth. Nothing here decides anything:
    /// Unity displays the room the server describes, and asks for changes by
    /// sending intents. Host authority lives on the server, proved by a
    /// credential, never by a flag Unity sets.
    ///
    /// All types are [Serializable] with plain public fields, because Unity's
    /// JsonUtility handles nothing else.
    /// </summary>
    public static class RoomIntents
    {
        public const string CreateRoom = "CREATE_ROOM";
        public const string ReconnectHost = "RECONNECT_HOST";
        public const string RequestLobbySnapshot = "REQUEST_LOBBY_SNAPSHOT";

        public const string SetTeamMode = "HOST_SET_TEAM_MODE";
        public const string AssignPlayerTeam = "HOST_ASSIGN_PLAYER_TEAM";
        public const string UnassignPlayer = "HOST_UNASSIGN_PLAYER";
        public const string RemovePlayer = "HOST_REMOVE_PLAYER";
        public const string LockTeams = "HOST_LOCK_TEAMS";
        public const string UnlockTeams = "HOST_UNLOCK_TEAMS";
        public const string CloseRoom = "HOST_CLOSE_ROOM";
    }

    public static class RoomEvents
    {
        public const string RoomCreated = "ROOM_CREATED";
        public const string PlayerJoined = "PLAYER_JOINED";
        public const string PlayerReconnected = "PLAYER_RECONNECTED";
        public const string PlayerDisconnected = "PLAYER_DISCONNECTED";
        public const string PlayerLeft = "PLAYER_LEFT";
        public const string PlayerRemoved = "PLAYER_REMOVED";
        public const string TeamModeChanged = "TEAM_MODE_CHANGED";
        public const string TeamAssignmentChanged = "TEAM_ASSIGNMENT_CHANGED";
        public const string TeamsLocked = "TEAMS_LOCKED";
        public const string TeamsUnlocked = "TEAMS_UNLOCKED";
        public const string RoomClosed = "ROOM_CLOSED";
        public const string HostConnectionChanged = "HOST_CONNECTION_CHANGED";
        public const string ConnectionSuperseded = "CONNECTION_SUPERSEDED";
    }

    /// <summary>Stable team identifiers. Labels are presentation only.</summary>
    public static class TeamIds
    {
        public const string A = "TEAM_A";
        public const string B = "TEAM_B";
        public const string C = "TEAM_C";

        public static string Label(string teamId)
        {
            switch (teamId)
            {
                case A: return "Team A";
                case B: return "Team B";
                case C: return "Team C";
                default: return string.IsNullOrEmpty(teamId) ? "Unassigned" : teamId;
            }
        }
    }

    /// <summary>
    /// One player in the lobby.
    ///
    /// Note what is NOT here: a reconnect credential. The server never sends one
    /// player's credential to anyone else, so there is nowhere to put it —
    /// the absence is the protection.
    /// </summary>
    [Serializable]
    public class LobbyPlayer
    {
        public string playerId;
        public string displayName;

        /// <summary>Empty or null when unassigned. JsonUtility cannot express null strings distinctly.</summary>
        public string teamId;

        /// <summary>"connected" or "disconnected".</summary>
        public string connection;

        public long joinedAt;
        public long disconnectedAt;

        public bool IsConnected => connection == "connected";
        public bool HasTeam => !string.IsNullOrEmpty(teamId);
    }

    /// <summary>Public room state.</summary>
    [Serializable]
    public class LobbyRoom
    {
        public string roomId;
        public string roomCode;
        public string mode;

        /// <summary>"OPEN", "LOCKED" or "CLOSED".</summary>
        public string status;

        public int teamMode;
        public bool teamsLocked;
        public long createdAt;
        public long updatedAt;
        public long seq;
        public bool hostConnected;
    }

    [Serializable]
    public class LobbyTeam
    {
        public string teamId;
        public string displayName;
        public string[] memberIds;
    }

    /// <summary>
    /// Authoritative lobby state. Unity replaces its whole view with this rather
    /// than patching, so a missed event cannot leave the display wrong.
    /// </summary>
    [Serializable]
    public class LobbySnapshot
    {
        public int protocolVersion;
        public long seq;
        public long takenAt;
        public LobbyRoom room;
        public LobbyPlayer[] players;
        public LobbyTeam[] teams;
        public string you;
        public bool isHost;
    }

    /// <summary>
    /// Reply to CREATE_ROOM. Carries the Host credential, and is therefore sent
    /// ONLY to the creating connection — never broadcast.
    /// </summary>
    [Serializable]
    public class RoomCreatedPayload
    {
        public string roomId;
        public string roomCode;
        public string hostToken;
        public string joinUrl;
        public LobbySnapshot snapshot;
    }

    /// <summary>Reply to RECONNECT_HOST.</summary>
    [Serializable]
    public class HostReconnectedPayload
    {
        public string roomId;
        public string roomCode;
        public LobbySnapshot snapshot;
    }
}

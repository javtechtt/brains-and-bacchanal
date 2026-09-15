import type { EventEnvelope, IntentEnvelope } from './envelope.js';
import type { Rejection } from './errors.js';
import type { SequenceNumber } from './ids.js';

/**
 * Realtime transport seam.
 *
 * CLAUDE.md — "Transport-specific code must sit behind an adapter/interface."
 * ARCHITECTURE.md §7 — the Socket.IO vs raw WebSocket choice must follow
 * measurement, not preference.
 *
 * This file describes WHAT a transport must do, never HOW. It contains no
 * Socket.IO type, no `ws` type, no browser WebSocket type — and no game rules.
 * There is no BB here, no card, no Market, no round and no Family Feud logic.
 * A transport moves envelopes; it never decides an outcome.
 *
 * The interface is deliberately the smallest thing that supports the Phase 3
 * scenarios: connect, disconnect, receive an intent, reply to it, send to one
 * client, broadcast to all.
 */

/**
 * A transport-assigned connection identity.
 *
 * This is NOT a player identity and NOT a session token. It identifies one
 * physical socket and dies with it. A reconnecting client gets a new
 * ConnectionId while keeping its own higher-level identity.
 */
export type ConnectionId = string;

/** Which transport implementation is in use. Used for labelling measurements. */
export type TransportKind = 'socketio' | 'websocket';

/**
 * Reply to a submitted intent.
 *
 * Every intent gets exactly one of these, so a client never has to guess
 * whether its action was applied. That matters for idempotency: a client whose
 * acknowledgement was lost can retry and be told DUPLICATE_INTENT rather than
 * being left uncertain.
 */
export type IntentAck =
  | { readonly ok: true; readonly seq: SequenceNumber }
  | { readonly ok: false; readonly error: Rejection };

/** Called when a client submits an intent. Returns the reply to send back. */
export type IntentHandler = (
  connectionId: ConnectionId,
  intent: IntentEnvelope,
) => Promise<IntentAck> | IntentAck;

/** Called when a connection opens or closes. */
export type ConnectionHandler = (connectionId: ConnectionId) => void;

/**
 * What every transport adapter must provide.
 *
 * Both the Socket.IO and raw WebSocket adapters implement exactly this, so the
 * benchmark drives them through one code path and any measured difference is a
 * property of the transport rather than of two different implementations.
 */
export interface RealtimeTransport {
  readonly kind: TransportKind;

  /** Begin accepting connections. */
  start(): Promise<void>;

  /** Close all connections and stop accepting new ones. */
  stop(): Promise<void>;

  /** Deliver an event to one connection. */
  send(connectionId: ConnectionId, event: EventEnvelope): void;

  /** Deliver an event to every open connection. */
  broadcast(event: EventEnvelope): void;

  /** Register the handler invoked when a client submits an intent. */
  onIntent(handler: IntentHandler): void;

  /** Register the handler invoked when a connection opens. */
  onConnect(handler: ConnectionHandler): void;

  /**
   * Register the handler invoked when a connection closes.
   *
   * The transport reports the raw fact of disconnection only. Whether that
   * should pause the game is a rule decision (GAME_RULES_LOCKED.md §20) and
   * belongs to the server, not here.
   */
  onDisconnect(handler: ConnectionHandler): void;

  /** Currently open connections. */
  connections(): readonly ConnectionId[];
}

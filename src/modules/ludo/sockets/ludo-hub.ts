import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { LudoServerEvent, LudoServerEventType } from "../schemas/ludo.schema.js";

const MAX_BUFFERED_BYTES = 1024 * 1024;

export interface LudoSocketSession {
  userId: string;
  socket: WebSocket;
  /** Tic-tac-toe/legacy realtime route. Kept for backwards compatibility. */
  gameId: string | null;
  /** Ludo has an independent route so another realtime game cannot steal it. */
  ludoGameId?: string | null;
  authenticatedAt: number;
  lastSeenAt: number;
}

export class LudoRealtimeHub {
  private readonly sessions = new Map<string, LudoSocketSession>();
  private socketErrors = 0;

  event<T>(
    type: LudoServerEventType,
    payload: T,
    gameId: string | null = null,
    stateVersion: number | null = null,
  ): LudoServerEvent<T> {
    return {
      type,
      eventId: randomUUID(),
      gameId,
      stateVersion,
      serverTimestamp: new Date().toISOString(),
      payload,
    };
  }

  register(session: LudoSocketSession): void {
    const previous = this.sessions.get(session.userId);
    if (previous && previous.socket !== session.socket) {
      this.write(previous.socket, this.event("socket.session_replaced", {}));
      previous.socket.close(4001, "A newer session connected");
    }
    session.ludoGameId ??= null;
    this.sessions.set(session.userId, session);
  }

  unregister(userId: string, socket: WebSocket): void {
    if (this.sessions.get(userId)?.socket === socket) this.sessions.delete(userId);
  }

  session(userId: string): LudoSocketSession | undefined {
    return this.sessions.get(userId);
  }

  setGame(userId: string, gameId: string | null): void {
    const session = this.sessions.get(userId);
    if (session) session.gameId = gameId;
  }

  setLudoGame(userId: string, gameId: string | null): void {
    const session = this.sessions.get(userId);
    if (session) session.ludoGameId = gameId;
  }

  touch(userId: string): void {
    const session = this.sessions.get(userId);
    if (session) session.lastSeenAt = Date.now();
  }

  send(userId: string, event: LudoServerEvent): boolean {
    const session = this.sessions.get(userId);
    return session ? this.write(session.socket, event) : false;
  }

  broadcastRoom(
    gameId: string,
    event: LudoServerEvent,
    options: { excludeUserIds?: readonly string[] } = {},
  ): void {
    const excluded = new Set(options.excludeUserIds ?? []);
    for (const session of this.sessions.values()) {
      if (session.gameId === gameId && !excluded.has(session.userId)) {
        this.write(session.socket, event);
      }
    }
  }

  broadcastLudoRoom(
    gameId: string,
    event: LudoServerEvent,
    options: { excludeUserIds?: readonly string[] } = {},
  ): void {
    const excluded = new Set(options.excludeUserIds ?? []);
    for (const session of this.sessions.values()) {
      if (session.ludoGameId === gameId && !excluded.has(session.userId)) {
        this.write(session.socket, event);
      }
    }
  }

  onlineUserIds(): string[] {
    return [...this.sessions.keys()];
  }

  closeStale(cutoffMs: number): string[] {
    const stale: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.lastSeenAt < cutoffMs) {
        stale.push(session.userId);
        session.socket.close(4000, "Heartbeat timeout");
      }
    }
    return stale;
  }

  recordError(): void {
    this.socketErrors += 1;
  }

  metrics(): { connections: number; authenticated: number; errors: number } {
    return {
      connections: this.sessions.size,
      authenticated: this.sessions.size,
      errors: this.socketErrors,
    };
  }

  private write(socket: WebSocket, event: LudoServerEvent): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.socketErrors += 1;
      socket.close(1013, "Realtime client is too slow");
      return false;
    }
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      this.socketErrors += 1;
      return false;
    }
  }
}

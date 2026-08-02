import type { FastifyInstance, FastifyRequest } from "fastify";
import type WebSocket from "ws";
import { AppError, BadRequestError, UnauthorizedError } from "../../../common/errors.js";
import { clientEventSchema, type LudoClientEvent } from "../schemas/ludo.schema.js";

const gameIdOf = (event: { gameId?: string | null }): string => {
  if (!event.gameId) throw new BadRequestError("gameId is required");
  return event.gameId;
};

const versionOf = (event: { expectedStateVersion?: number | null }): number => {
  if (event.expectedStateVersion === undefined || event.expectedStateVersion === null) {
    throw new BadRequestError("expectedStateVersion is required");
  }
  return event.expectedStateVersion;
};

export const registerLudoSocketGateway = (app: FastifyInstance): void => {
  const hub = app.di.ludoHub;
  const ludo = app.di.ludoService;
  const ttt = app.di.gameService;

  app.get(
    "/socket",
    {
      websocket: true,
      config: { rateLimit: false },
      schema: { tags: ["ludo"], summary: "Authenticated authoritative Ludo WebSocket" },
    },
    (socket: WebSocket, request: FastifyRequest) => {
      let userId: string | null = null;
      let authenticated = false;
      let chain = Promise.resolve();

      const send = (event: ReturnType<typeof hub.event>): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      };
      const fail = (error: unknown, event?: Partial<LudoClientEvent>): void => {
        hub.recordError();
        const appError =
          error instanceof AppError
            ? error
            : new AppError("Realtime request failed", 500, "INTERNAL_ERROR");
        request.log.warn(
          {
            userId,
            gameId: event?.gameId ?? null,
            actionId: event && "actionId" in event ? event.actionId : undefined,
            eventType: event?.type,
            errorCode: appError.code,
          },
          "ludo socket command rejected",
        );
        send(
          hub.event(
            "game.error",
            {
              code: appError.code,
              message: appError.message,
              details: appError.details,
              actionId: event && "actionId" in event ? event.actionId : undefined,
            },
            event?.gameId ?? null,
            null,
          ),
        );
      };

      const authenticationTimer = setTimeout(() => {
        if (!authenticated) socket.close(4003, "Authentication timeout");
      }, 8_000);
      authenticationTimer.unref();

      const dispatch = async (event: LudoClientEvent): Promise<void> => {
        if (event.type === "socket.authenticate") {
          if (authenticated) throw new BadRequestError("Socket is already authenticated");
          let claims: { sub?: string; email?: string; role?: string };
          try {
            claims = await app.jwt.verify(event.payload.accessToken);
          } catch {
            throw new UnauthorizedError("Invalid access token");
          }
          if (!claims.sub) throw new UnauthorizedError("Invalid access token subject");
          await ludo.assertSocketUser(claims.sub);
          userId = claims.sub;
          authenticated = true;
          clearTimeout(authenticationTimer);
          hub.register({
            userId,
            socket,
            gameId: null,
            authenticatedAt: Date.now(),
            lastSeenAt: Date.now(),
          });
          const resumed = await ludo.resumeActive(
            userId,
            event.payload.resumeToken,
            event.payload.lastAcknowledgedStateVersion,
          );
          send(
            hub.event("socket.authenticated", {
              userId,
              activeGameId: resumed?.gameId ?? null,
              resumeToken: resumed?.resumeToken ?? null,
            }),
          );
          if (resumed) send(resumed.event);
          request.log.info(
            { userId, activeGameId: resumed?.gameId ?? null },
            "ludo socket authenticated",
          );
          return;
        }
        if (!authenticated || !userId) throw new UnauthorizedError("Authenticate the socket first");
        hub.touch(userId);
        switch (event.type) {
          case "socket.ping":
            send(
              hub.event("socket.pong", {
                clientTimestamp: event.payload.clientTimestamp ?? event.timestamp,
              }),
            );
            return;
          case "matchmaking.join":
            await ludo.joinMatchmaking(userId, event.payload);
            return;
          case "matchmaking.leave":
            await ludo.leaveMatchmaking(userId);
            return;
          case "match.accept":
            await ludo.acceptMatch(userId, gameIdOf(event), event.actionId, versionOf(event));
            return;
          case "room.ready":
            await ludo.readyRoom(userId, gameIdOf(event), event.actionId, versionOf(event));
            return;
          case "game.state.request": {
            const gameId = gameIdOf(event);
            await ludo.acknowledgeVersion(
              userId,
              gameId,
              event.payload.lastAcknowledgedStateVersion,
            );
            send(
              hub.event(
                "game.state",
                { snapshot: await ludo.getSnapshot(userId, gameId) },
                gameId,
                null,
              ),
            );
            return;
          }
          case "dice.roll.request":
            await ludo.rollDice(userId, gameIdOf(event), event.actionId, versionOf(event));
            return;
          case "pawn.move.request":
            await ludo.movePawn(
              userId,
              gameIdOf(event),
              event.actionId,
              versionOf(event),
              event.payload.pawnIndex,
            );
            return;
          case "chat.quick.send":
            await ludo.sendQuickChat(
              userId,
              gameIdOf(event),
              event.actionId,
              event.payload.message,
            );
            return;
          case "chat.text.send":
            await ludo.sendTextChat(userId, gameIdOf(event), event.actionId, event.payload.message);
            return;
          case "typing.start":
          case "typing.stop":
            await ludo.publishTyping(userId, gameIdOf(event), event.type === "typing.start");
            return;
          case "voice.session.join":
            await ludo.joinVoice(userId, gameIdOf(event));
            return;
          case "voice.session.leave":
            await ludo.leaveVoice(userId, gameIdOf(event));
            return;
          case "voice.offer":
          case "voice.answer":
          case "voice.ice_candidate":
            await ludo.relayVoice(userId, gameIdOf(event), event.type, event.payload);
            return;
          case "player.report": {
            const ack = await ludo.reportPlayer(userId, gameIdOf(event), event.payload);
            send(ack);
            return;
          }
          case "player.block":
            await ludo.setBlock(userId, event.payload.targetUserId, event.payload.blocked);
            send(
              hub.event("game.state", {
                blockUpdated: true,
                targetUserId: event.payload.targetUserId,
              }),
            );
            return;
          case "player.mute":
            await ludo.setMute(
              userId,
              gameIdOf(event),
              event.payload.targetUserId,
              event.payload.muted,
            );
            send(
              hub.event(
                "game.state",
                { muteUpdated: true, targetUserId: event.payload.targetUserId },
                gameIdOf(event),
                null,
              ),
            );
            return;
          case "room.leave":
            await ludo.forfeit(
              userId,
              gameIdOf(event),
              event.actionId,
              versionOf(event),
              event.payload.reason ?? "PLAYER_LEFT",
            );
            return;
          case "ttt.matchmaking.join":
            await ttt.joinOnlineMatchmaking(userId);
            return;
          case "ttt.matchmaking.leave":
            await ttt.leaveOnlineMatchmaking(userId);
            return;
          case "ttt.state.request":
            await ttt.sendOnlineState(userId, gameIdOf(event));
            return;
          case "ttt.move":
            await ttt.onlineMove(userId, gameIdOf(event), event.payload.cell);
            return;
          case "ttt.match.leave":
            await ttt.leaveOnlineMatch(userId, gameIdOf(event));
            return;
          case "ttt.chat.quick.send":
            await ttt.sendOnlineChat(userId, gameIdOf(event), event.payload.message, false);
            return;
          case "ttt.chat.text.send":
            await ttt.sendOnlineChat(userId, gameIdOf(event), event.payload.message, true);
            return;
          case "ttt.voice.session.join":
            await ttt.joinOnlineVoice(userId, gameIdOf(event));
            return;
          case "ttt.voice.session.leave":
            await ttt.leaveOnlineVoice(userId, gameIdOf(event));
            return;
          case "ttt.voice.offer":
          case "ttt.voice.answer":
          case "ttt.voice.ice_candidate":
            await ttt.relayOnlineVoice(userId, gameIdOf(event), event.type, event.payload);
            return;
        }
      };

      socket.on("message", (data) => {
        const messageText = data.toString();
        if (Buffer.byteLength(messageText, "utf8") > 64 * 1024) {
          socket.close(1009, "Message too large");
          return;
        }
        chain = chain
          .then(async () => {
            let value: unknown;
            try {
              value = JSON.parse(messageText);
            } catch {
              throw new BadRequestError("WebSocket message must be valid JSON");
            }
            const parsed = clientEventSchema.safeParse(value);
            if (!parsed.success) {
              throw new BadRequestError("Invalid WebSocket event", parsed.error.flatten());
            }
            await dispatch(parsed.data);
          })
          .catch((error) => fail(error));
      });
      socket.on("error", (error) => {
        hub.recordError();
        request.log.warn({ err: error, userId }, "ludo websocket error");
      });
      socket.on("close", () => {
        clearTimeout(authenticationTimer);
        if (!userId) return;
        const ownsSession = hub.session(userId)?.socket === socket;
        hub.unregister(userId, socket);
        if (ownsSession) {
          void ludo.markDisconnected(userId);
          void ttt.disconnectOnline(userId);
        }
      });
    },
  );
};

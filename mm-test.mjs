// End-to-end matchmaking probe against a deployed backend.
// Creates two throwaway users, drives two real WebSocket clients through
// TTT online matchmaking, then deletes everything it created.
import "dotenv/config";
import jwt from "jsonwebtoken";
import { WebSocket } from "ws";
import { PrismaClient } from "@prisma/client";

const HOST = process.env.TARGET_HOST ?? "prithivi-backend.onrender.com";
const WS_URL = `wss://${HOST}/api/v1/ludo/socket`;
const HTTP_URL = `https://${HOST}/api/v1`;

const prisma = new PrismaClient();
const EMAILS = ["qa-mm-a@prithvi.test", "qa-mm-b@prithvi.test"];

const sign = (userId, email) =>
  jwt.sign({ sub: userId, email, role: "USER" }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
    expiresIn: "15m",
  });

const client = (name, token) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    const events = [];
    const waiters = [];
    const push = (event) => {
      events.push(event);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(event)) waiters.splice(i, 1)[0].resolve(event);
      }
    };
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "socket.authenticate",
          timestamp: new Date().toISOString(),
          payload: { accessToken: token },
        }),
      );
    });
    socket.on("message", (raw) => push(JSON.parse(raw.toString())));
    socket.on("error", reject);
    socket.on("close", (code, why) =>
      push({ type: "socket.closed", payload: { code, why: why.toString() } }),
    );
    const waitFor = (match, ms = 25_000) =>
      new Promise((res, rej) => {
        const hit = events.find(match);
        if (hit) return res(hit);
        const waiter = { match, resolve: res };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          rej(new Error(`${name}: timed out waiting; saw [${events.map((e) => e.type).join(", ")}]`));
        }, ms);
      });
    const send = (type, payload = {}) =>
      socket.send(
        JSON.stringify({
          type,
          actionId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          payload,
        }),
      );
    resolve({ name, socket, events, waitFor, send });
  });

const main = async () => {
  const users = [];
  for (const email of EMAILS) {
    users.push(
      await prisma.user.upsert({
        where: { email },
        update: { isActive: true },
        create: { email, name: `QA ${email[6].toUpperCase()}`, isActive: true, role: "USER" },
      }),
    );
  }
  console.log(`users ready: ${users.map((u) => u.id).join(", ")}`);

  const tokens = users.map((u) => sign(u.id, u.email));

  // 1. JWT/secret sanity — proves this script's tokens are accepted by prod.
  const me = await fetch(`${HTTP_URL}/users/me`, {
    headers: { authorization: `Bearer ${tokens[0]}` },
  });
  console.log(`GET /users/me -> ${me.status}`);
  if (me.status !== 200) throw new Error("token rejected by deployment; secrets differ");

  // 2. Two live sockets through TTT matchmaking.
  const a = await client("A", tokens[0]);
  const b = await client("B", tokens[1]);
  await a.waitFor((e) => e.type === "socket.authenticated");
  await b.waitFor((e) => e.type === "socket.authenticated");
  console.log("both sockets authenticated");

  if (process.env.MODE === "ludo") {
    a.send("matchmaking.join", { mode: "TWO_PLAYER" });
    await a.waitFor((e) => e.type === "matchmaking.joined" || e.type === "match.found");
    console.log("A queued for ludo");
    const t0 = Date.now();
    b.send("matchmaking.join", { mode: "TWO_PLAYER" });
    const [lA, lB] = await Promise.all([
      a.waitFor((e) => e.type === "match.found", 30_000),
      b.waitFor((e) => e.type === "match.found", 30_000),
    ]);
    console.log(`ludo match.found on BOTH clients in ${Date.now() - t0}ms`);
    console.log("gameId:", lA.payload.gameId, "/", lB.payload.gameId);
    a.socket.close();
    b.socket.close();
    console.log("\nPASS: ludo matchmaking pairs both users");
    return users.map((u) => u.id);
  }

  a.send("ttt.matchmaking.join");
  await a.waitFor((e) => e.type === "ttt.matchmaking.joined" || e.type === "ttt.match.found");
  console.log("A queued");

  // Duplicate join — the exact case that used to wedge the queue.
  a.send("ttt.matchmaking.join");
  await new Promise((r) => setTimeout(r, 500));

  b.send("ttt.matchmaking.join");
  const [foundA, foundB] = await Promise.all([
    a.waitFor((e) => e.type === "ttt.match.found"),
    b.waitFor((e) => e.type === "ttt.match.found"),
  ]);
  const started = Date.now();
  console.log("A got ttt.match.found, board:", JSON.stringify(foundA.payload.snapshot.board));
  console.log("B got ttt.match.found, matchId:", foundB.payload.snapshot.matchId);
  console.log("players:", JSON.stringify(foundB.payload.snapshot.players));

  // 3. A real move must broadcast to both clients.
  const snap = foundA.payload.snapshot;
  const mover = snap.currentTurnUserId === users[0].id ? a : b;
  mover.socket.send(
    JSON.stringify({
      type: "ttt.move",
      actionId: crypto.randomUUID(),
      gameId: snap.matchId,
      expectedStateVersion: snap.version,
      timestamp: new Date().toISOString(),
      payload: { cell: 4 },
    }),
  );
  const [updA, updB] = await Promise.all([
    a.waitFor((e) => e.type === "ttt.match.updated"),
    b.waitFor((e) => e.type === "ttt.match.updated"),
  ]);
  console.log(`move broadcast to both in ${Date.now() - started}ms`);
  console.log("board after move:", JSON.stringify(updA.payload.snapshot.board));
  if (JSON.stringify(updA.payload.snapshot.board) !== JSON.stringify(updB.payload.snapshot.board)) {
    throw new Error("clients disagree on board state");
  }

  a.socket.close();
  b.socket.close();
  console.log("\nPASS: matchmaking pairs users and the board syncs both ways");
  return users.map((u) => u.id);
};

let ids = [];
try {
  ids = await main();
} catch (error) {
  console.error("\nFAIL:", error.message);
  process.exitCode = 1;
} finally {
  // Cleanup: remove everything this probe created.
  const users = await prisma.user.findMany({ where: { email: { in: EMAILS } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    const matches = await prisma.gameMatch.deleteMany({
      where: {
        OR: [
          { userId: { in: userIds } },
          ...userIds.map((id) => ({ difficulty: "ONLINE", state: { path: ["oUserId"], equals: id } })),
        ],
      },
    });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    console.log(`cleanup: removed ${matches.count} match rows and ${userIds.length} test users`);
  }
  await prisma.$disconnect();
  process.exit(process.exitCode ?? 0);
}

// Sumo Arena — HTTP server: static client, JSON agent API, SSE updates.
// No dependencies. Run with `node server.mjs` (PORT env optional, default 3000).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addPlayer,
  applyAction,
  createGame,
  httpError,
  logEvent,
  publicState,
  startGame,
} from "./game.mjs";
import { chooseAction } from "./bot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_GAMES = 500;
const BOT_DELAY_MS = 700;
const IDLE_MOVE_MS = 120_000;

/** @type {Map<string, any>} */
const games = new Map();
/** @type {Map<string, Set<import("node:http").ServerResponse>>} */
const streams = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-player-token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...headers,
  });
  res.end(payload);
}

function fail(res, err) {
  const status = err.status || 500;
  send(res, status, { error: err.message || "Server error" });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw httpError(413, "Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "Body must be valid JSON");
  }
}

function getGame(code) {
  const game = games.get(String(code || "").toUpperCase());
  if (!game) throw httpError(404, "No match with that code");
  return game;
}

function authPlayer(game, req, body) {
  const token =
    req.headers["x-player-token"] ||
    (body && body.token) ||
    new URL(req.url, "http://x").searchParams.get("token");
  const player = game.players.find((p) => p.token && p.token === token);
  if (!player) throw httpError(401, "Missing or invalid player token");
  return player;
}

function stateFor(game, player) {
  const state = publicState(game, player ? player.id : null);
  state.serverTime = Date.now();
  return state;
}

function broadcast(game) {
  const set = streams.get(game.code);
  if (!set || !set.size) return;
  const data = `data: ${JSON.stringify(stateFor(game, null))}\n\n`;
  for (const res of set) {
    try {
      res.write(data);
    } catch {
      set.delete(res);
    }
  }
}

function scheduleTurn(game) {
  clearTimeout(game._botTimer);
  clearTimeout(game._idleTimer);
  game._botTimer = null;
  game._idleTimer = null;
  if (game.status !== "playing") return;
  const current = game.players.find((p) => p.id === game.turn);
  if (!current || !current.alive) return;

  if (current.isBot) {
    game._botTimer = setTimeout(() => {
      game._botTimer = null;
      try {
        if (game.status !== "playing") return;
        const bot = game.players.find((p) => p.id === game.turn);
        if (!bot || !bot.isBot || !bot.alive) return;
        const action = chooseAction(stateFor(game, bot));
        if (action) applyAction(game, bot.id, action);
        broadcast(game);
      } catch (err) {
        // A bot that cannot move should never wedge the match.
        console.error("bot move failed:", err.message);
        try {
          const bot = game.players.find((p) => p.id === game.turn);
          const fallback = publicState(game, bot ? bot.id : null).you?.legal?.[0];
          if (bot && fallback) {
            applyAction(game, bot.id, fallback);
            broadcast(game);
          }
        } catch {
          /* ignore */
        }
      } finally {
        scheduleTurn(game);
      }
    }, BOT_DELAY_MS);
    return;
  }

  // Humans get two minutes; after that the referee keeps the match moving.
  game._idleTimer = setTimeout(() => {
    game._idleTimer = null;
    try {
      if (game.status !== "playing") return;
      const player = game.players.find((p) => p.id === game.turn);
      if (!player || player.isBot || !player.alive) return;
      const legal = publicState(game, player.id).you?.legal || [];
      if (!legal.length) return;
      const action = legal[Math.floor(Math.random() * legal.length)];
      applyAction(game, player.id, action);
      logEvent(game, "idle", `${player.name} hesitates — the referee moves for them`);
      broadcast(game);
    } catch (err) {
      console.error("idle move failed:", err.message);
    } finally {
      scheduleTurn(game);
    }
  }, IDLE_MOVE_MS);
}

function sweep() {
  const now = Date.now();
  for (const [code, game] of games) {
    const age = now - game.updatedAt;
    if (game.status === "finished" && age > 2 * 60 * 60 * 1000) games.delete(code);
    else if (game.status === "lobby" && age > 30 * 60 * 1000) games.delete(code);
    else if (games.size > MAX_GAMES && age > 10 * 60 * 1000) games.delete(code);
  }
}

function listLobbies() {
  const rows = [];
  for (const game of games.values()) {
    if (game.status !== "lobby") continue;
    rows.push({
      code: game.code,
      host: game.players[0]?.name || "?",
      players: game.players.length,
      maxPlayers: game.maxPlayers,
      createdAt: game.createdAt,
    });
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
}

async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "games", ...]
  const method = req.method;

  if (url.pathname === "/api/health") {
    return send(res, 200, {
      ok: true,
      service: "sumo-arena",
      games: games.size,
      uptimeSeconds: Math.round(process.uptime()),
      now: new Date().toISOString(),
    });
  }

  if (url.pathname === "/api/games" && method === "GET") {
    return send(res, 200, { games: listLobbies() });
  }

  if (url.pathname === "/api/games" && method === "POST") {
    const body = await readBody(req);
    if (games.size >= MAX_GAMES) throw httpError(503, "Server is at capacity, try again shortly");
    const game = createGame({
      hostName: body.name,
      maxPlayers: body.maxPlayers,
    });
    const host = game.players[0];
    games.set(game.code, game);
    return send(res, 201, {
      code: game.code,
      playerId: host.id,
      token: host.token,
      state: stateFor(game, host),
    });
  }

  if (parts[1] === "games" && parts[2]) {
    const game = getGame(parts[2]);
    const tail = parts[3];

    if (!tail && method === "GET") {
      const player = game.players.find(
        (p) => p.token && p.token === (req.headers["x-player-token"] || url.searchParams.get("token"))
      );
      return send(res, 200, { state: stateFor(game, player) });
    }

    if (tail === "join" && method === "POST") {
      const body = await readBody(req);
      const player = addPlayer(game, body.name);
      broadcast(game);
      return send(res, 200, {
        code: game.code,
        playerId: player.id,
        token: player.token,
        state: stateFor(game, player),
      });
    }

    if (tail === "start" && method === "POST") {
      const body = await readBody(req);
      const player = authPlayer(game, req, body);
      if (!player.host) throw httpError(403, "Only the host can start the match");
      startGame(game, { fillBots: body.fillBots !== false });
      broadcast(game);
      scheduleTurn(game);
      return send(res, 200, { state: stateFor(game, player) });
    }

    if (tail === "action" && method === "POST") {
      const body = await readBody(req);
      const player = authPlayer(game, req, body);
      applyAction(game, player.id, body);
      broadcast(game);
      scheduleTurn(game);
      return send(res, 200, { state: stateFor(game, player) });
    }

    if (tail === "leave" && method === "POST") {
      const body = await readBody(req);
      const player = authPlayer(game, req, body);
      if (game.status === "lobby") {
        game.players = game.players.filter((p) => p.id !== player.id);
        if (!game.players.length) {
          games.delete(game.code);
          return send(res, 200, { left: true, deleted: true });
        }
        if (player.host && !game.players.some((p) => p.host)) game.players[0].host = true;
        logEvent(game, "leave", `${player.name} left the lobby`);
      } else if (game.status === "playing" && !player.isBot) {
        player.isBot = true;
        logEvent(game, "leave", `${player.name} left — a bot takes over their seat`);
        scheduleTurn(game);
      }
      broadcast(game);
      return send(res, 200, { left: true, state: stateFor(game, player) });
    }

    if (tail === "log" && method === "GET") {
      return send(res, 200, { code: game.code, log: game.log });
    }

    if (tail === "stream" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
        "x-accel-buffering": "no",
      });
      res.write(`retry: 2000\n\n`);
      res.write(`data: ${JSON.stringify(stateFor(game, null))}\n\n`);
      if (!streams.has(game.code)) streams.set(game.code, new Set());
      const set = streams.get(game.code);
      set.add(res);
      const ping = setInterval(() => {
        try {
          res.write(`: ping\n\n`);
        } catch {
          /* ignore */
        }
      }, 20_000);
      req.on("close", () => {
        clearInterval(ping);
        set.delete(res);
        if (!set.size) streams.delete(game.code);
      });
      return;
    }

    throw httpError(404, "Unknown game endpoint");
  }

  throw httpError(404, "Unknown API route");
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel.startsWith("/g/") || rel === "/play") rel = "/index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback for client routes such as /g/CODE
      return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err2, html) => {
        if (err2) return send(res, 404, { error: "Not found" });
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
        res.end(html);
      });
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") return send(res, 204, "");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") throw httpError(405, "Method not allowed");
    return serveStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) return fail(res, err);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
});

setInterval(sweep, 10 * 60 * 1000).unref?.();

server.listen(PORT, HOST, () => {
  console.log(`Sumo Arena listening on http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

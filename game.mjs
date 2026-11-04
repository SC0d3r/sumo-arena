// Sumo Arena — turn-based 2-4 player survival game.
// Pure game logic, no I/O. See README.md for the rules.

export const BOARD = 9;
export const DIRS = {
  N: [0, -1],
  S: [0, 1],
  E: [1, 0],
  W: [-1, 0],
};
export const COLORS = ["#ff5d73", "#4cc9f0", "#ffd166", "#8ac926"];

const key = (x, y) => `${x},${y}`;
const inBoard = (x, y) => x >= 0 && y >= 0 && x < BOARD && y < BOARD;
const ringOf = (x, y) => Math.min(x, y, BOARD - 1 - x, BOARD - 1 - y);

export function createGame({ hostName = "Host", maxPlayers = 2 } = {}) {
  const n = Math.max(2, Math.min(4, Number(maxPlayers) || 2));
  const game = {
    code: makeCode(),
    status: "lobby",
    maxPlayers: n,
    players: [],
    turn: null,
    round: 1,
    shrink: 0,
    winner: null,
    log: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  addPlayer(game, hostName, { host: true });
  return game;
}

export function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export function addPlayer(game, name, { host = false, bot = false } = {}) {
  if (game.status !== "lobby") throw httpError(409, "The match has already started");
  if (game.players.length >= game.maxPlayers) throw httpError(409, "The match is full");
  const id = `p${game.players.length + 1}`;
  const clean = String(name || "").trim().slice(0, 20) || (bot ? `Bot ${game.players.length + 1}` : "Player");
  const player = {
    id,
    name: clean,
    color: COLORS[game.players.length % COLORS.length],
    x: 0,
    y: 0,
    alive: true,
    pushes: 0,
    isBot: Boolean(bot),
    host: Boolean(host),
    token: bot ? null : randomToken(),
  };
  game.players.push(player);
  game.updatedAt = Date.now();
  return player;
}

export function startGame(game, { fillBots = true } = {}) {
  if (game.status !== "lobby") throw httpError(409, "The match has already started");
  if (fillBots) {
    while (game.players.length < game.maxPlayers) addPlayer(game, `Bot ${game.players.length + 1}`, { bot: true });
  }
  if (game.players.length < 2) throw httpError(400, "At least 2 players are needed");
  const corners = [
    [0, 0],
    [BOARD - 1, BOARD - 1],
    [BOARD - 1, 0],
    [0, BOARD - 1],
  ];
  game.players.forEach((p, i) => {
    p.x = corners[i][0];
    p.y = corners[i][1];
    p.alive = true;
  });
  game.status = "playing";
  game.turn = game.players[0].id;
  game.round = 1;
  game.shrink = 0;
  game.winner = null;
  game.log = [];
  game.updatedAt = Date.now();
  logEvent(game, "start", `${game.players.map((p) => p.name).join(" vs ")} — fight!`);
  return game;
}

export function applyAction(game, playerId, action) {
  if (game.status !== "playing") throw httpError(409, "The match is not running");
  const player = game.players.find((p) => p.id === playerId);
  if (!player) throw httpError(404, "Player not found");
  if (!player.alive) throw httpError(409, "You have been eliminated");
  if (game.turn !== playerId) throw httpError(409, "It is not your turn");
  const type = action?.type;
  const dir = String(action?.dir || "").toUpperCase();
  if (!DIRS[dir]) throw httpError(400, "dir must be one of N, S, E, W");
  if (type !== "move" && type !== "push") throw httpError(400, "type must be move or push");

  const [dx, dy] = DIRS[dir];
  const tx = player.x + dx;
  const ty = player.y + dy;
  let text = "";

  if (type === "move") {
    if (!passable(game, tx, ty)) throw httpError(400, "That cell is outside the arena");
    if (occupant(game, tx, ty)) throw httpError(400, "That cell is occupied");
    player.x = tx;
    player.y = ty;
    text = `${player.name} moves ${dir}`;
  } else {
    const target = occupant(game, tx, ty);
    if (!target) throw httpError(400, "There is no opponent to push there");
    const bx = tx + dx;
    const by = ty + dy;
    if (passable(game, bx, by) && occupant(game, bx, by)) throw httpError(400, "The push is blocked");
    player.pushes += 1;
    if (!passable(game, bx, by)) {
      target.alive = false;
      text = `${player.name} pushes ${target.name} off the ring`;
    } else {
      target.x = bx;
      target.y = by;
      text = `${player.name} pushes ${target.name} ${dir}`;
    }
  }
  logEvent(game, "action", text, { player: player.id, type, dir });
  advanceTurn(game);
  game.updatedAt = Date.now();
  return game;
}

export function advanceTurn(game) {
  if (game.status !== "playing") return;
  const alive = game.players.filter((p) => p.alive);
  if (alive.length <= 1) {
    finish(game, alive[0] || null);
    return;
  }
  const order = game.players;
  const idx = order.findIndex((p) => p.id === game.turn);
  let wrapped = false;
  for (let step = 1; step <= order.length; step++) {
    const pos = (idx + step) % order.length;
    const next = order[pos];
    if (pos <= idx && !wrapped) {
      wrapped = true;
      game.round += 1;
      logEvent(game, "round", `Round ${game.round} begins`);
      if ((game.round - 1) % 3 === 0) {
        shrinkArena(game);
        if (game.status !== "playing") return;
      }
    }
    if (!next.alive) continue;
    if (actionsFor(game, next).length === 0) {
      logEvent(game, "pass", `${next.name} has no legal move and passes`);
      continue;
    }
    game.turn = next.id;
    return;
  }
  finish(game, null);
}

export function shrinkArena(game) {
  game.shrink += 1;
  const s = game.shrink;
  let removed = [];
  for (const p of game.players) {
    if (!p.alive) continue;
    if (ringOf(p.x, p.y) < s) {
      p.alive = false;
      removed.push(p.name);
    }
  }
  logEvent(game, "shrink", `The arena shrinks to ring ${s}${removed.length ? ` — ${removed.join(", ")} eliminated` : ""}`);
  const alive = game.players.filter((p) => p.alive);
  if (alive.length <= 1) finish(game, alive[0] || null);
}

function finish(game, winner) {
  game.status = "finished";
  game.winner = winner ? winner.id : null;
  logEvent(game, "finish", winner ? `${winner.name} wins the arena` : "No one survives — draw");
  game.updatedAt = Date.now();
}

export function passable(game, x, y) {
  return inBoard(x, y) && ringOf(x, y) >= game.shrink;
}

export function occupant(game, x, y) {
  return game.players.find((p) => p.alive && p.x === x && p.y === y) || null;
}

export function legalActions(game, playerId) {
  const player = game.players.find((p) => p.id === playerId);
  if (!player || !player.alive || game.turn !== playerId) return [];
  return actionsFor(game, player);
}

function actionsFor(game, player) {
  const out = [];
  for (const [dir, [dx, dy]] of Object.entries(DIRS)) {
    const tx = player.x + dx;
    const ty = player.y + dy;
    if (passable(game, tx, ty) && !occupant(game, tx, ty)) out.push({ type: "move", dir });
    const target = occupant(game, tx, ty);
    if (target) {
      const bx = tx + dx;
      const by = ty + dy;
      if (!passable(game, bx, by) || !occupant(game, bx, by)) out.push({ type: "push", dir });
    }
  }
  return out;
}

export function publicState(game, viewerId = null) {
  const viewer = game.players.find((p) => p.id === viewerId) || null;
  return {
    code: game.code,
    status: game.status,
    maxPlayers: game.maxPlayers,
    board: BOARD,
    shrink: game.shrink,
    round: game.round,
    turn: game.turn,
    winner: game.winner,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      alive: p.alive,
      pushes: p.pushes,
      isBot: p.isBot,
      host: p.host,
    })),
    you: viewer
      ? {
          id: viewer.id,
          name: viewer.name,
          isHost: viewer.host,
          legal: legalActions(game, viewer.id),
        }
      : null,
    lastEvent: game.log.length ? game.log[game.log.length - 1].text : "",
    log: game.log.slice(-40),
  };
}

export function logEvent(game, kind, text, extra = {}) {
  game.log.push({ at: Date.now(), round: game.round, kind, text, ...extra });
  if (game.log.length > 200) game.log.shift();
}

export function randomToken() {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

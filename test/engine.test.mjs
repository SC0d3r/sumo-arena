import test from "node:test";
import assert from "node:assert/strict";
import {
  addPlayer,
  applyAction,
  createGame,
  legalActions,
  publicState,
  startGame,
} from "../game.mjs";

function twoPlayerGame() {
  const game = createGame({ hostName: "A", maxPlayers: 2 });
  addPlayer(game, "B");
  startGame(game, { fillBots: false });
  return game;
}

test("starting a match places players in opposite corners and fills empty seats with bots", () => {
  const game = createGame({ hostName: "A", maxPlayers: 4 });
  addPlayer(game, "B");
  startGame(game, { fillBots: true });
  assert.equal(game.players.length, 4);
  assert.equal(game.players.filter((p) => p.isBot).length, 2);
  assert.deepEqual(
    game.players.map((p) => [p.x, p.y]),
    [
      [0, 0],
      [8, 8],
      [8, 0],
      [0, 8],
    ]
  );
  assert.equal(game.status, "playing");
  assert.equal(game.turn, "p1");
});

test("a move is legal only into a free cell and passes the turn", () => {
  const game = twoPlayerGame();
  assert.deepEqual(legalActions(game, "p1"), [
    { type: "move", dir: "S" },
    { type: "move", dir: "E" },
  ]);
  applyAction(game, "p1", { type: "move", dir: "E" });
  assert.equal(game.players[0].x, 1);
  assert.equal(game.turn, "p2");
  assert.throws(() => applyAction(game, "p1", { type: "move", dir: "E" }), /not your turn/i);
});

test("pushing a rival off the board eliminates them and ends the match", () => {
  const game = twoPlayerGame();
  const [a, b] = game.players;
  a.x = 7;
  a.y = 0;
  b.x = 8;
  b.y = 0;
  game.turn = a.id;
  applyAction(game, a.id, { type: "push", dir: "E" });
  assert.equal(b.alive, false);
  assert.equal(game.status, "finished");
  assert.equal(game.winner, a.id);
  assert.match(game.log.map((e) => e.text).join("\n"), /off the ring/);
});

test("a push into ground that has already fallen also eliminates", () => {
  const game = twoPlayerGame();
  const [a, b] = game.players;
  game.shrink = 1;
  a.x = 2;
  a.y = 1;
  b.x = 1;
  b.y = 1;
  game.turn = a.id;
  applyAction(game, a.id, { type: "push", dir: "W" });
  assert.equal(b.alive, false);
  assert.equal(game.status, "finished");
});

test("the ring shrinks after every third round and takes anyone still on the edge", () => {
  const game = twoPlayerGame();
  const [a, b] = game.players;
  a.x = 0;
  a.y = 0; // ring 0, will fall
  b.x = 4;
  b.y = 4; // centre, safe
  game.round = 3;
  game.turn = b.id;
  game.players.forEach((p) => (p.alive = true));
  // p2 acts; the turn wraps back to p1, round becomes 4 and the ring shrinks.
  applyAction(game, b.id, { type: "move", dir: "N" });
  assert.equal(game.round, 4);
  assert.equal(game.shrink, 1);
  assert.equal(a.alive, false);
  assert.equal(game.status, "finished");
  assert.equal(game.winner, b.id);
});

test("turn order skips eliminated players", () => {
  const game = createGame({ hostName: "A", maxPlayers: 3 });
  addPlayer(game, "B");
  addPlayer(game, "C");
  startGame(game, { fillBots: false });
  const [a, b, c] = game.players;
  b.alive = false;
  game.turn = a.id;
  applyAction(game, a.id, { type: "move", dir: "E" });
  assert.equal(game.turn, c.id);
});

test("the public state never exposes player tokens", () => {
  const game = twoPlayerGame();
  const state = publicState(game, "p1");
  assert.equal(JSON.stringify(state).includes("token"), false);
  assert.equal(state.you.id, "p1");
  assert.ok(Array.isArray(state.you.legal));
  assert.ok(state.log.length >= 1);
});

test("illegal actions are rejected without changing the game", () => {
  const game = twoPlayerGame();
  const before = JSON.stringify(publicState(game, "p1"));
  assert.throws(() => applyAction(game, "p1", { type: "push", dir: "S" }), /no opponent/i);
  assert.throws(() => applyAction(game, "p1", { type: "move", dir: "N" }), /outside/i);
  assert.throws(() => applyAction(game, "p1", { type: "jump", dir: "N" }), /type must be/i);
  assert.equal(JSON.stringify(publicState(game, "p1")), before);
});

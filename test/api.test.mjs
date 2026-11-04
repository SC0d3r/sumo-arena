import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(pathname, options) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: { "content-type": "application/json", ...(options?.headers || {}) },
  });
  const body = await res.json();
  return { status: res.status, body };
}

test("HTTP API: create, join, start, play to a finish, and read the replay", async (t) => {
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => server.kill("SIGTERM"));

  let up = false;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  assert.ok(up, `server did not start: ${stderr}`);

  const health = await json("/api/health");
  assert.equal(health.body.ok, true);
  assert.equal(health.body.service, "sumo-arena");

  const created = await json("/api/games", {
    method: "POST",
    body: JSON.stringify({ name: "Tester", maxPlayers: 2 }),
  });
  assert.equal(created.status, 201);
  const { code, playerId, token } = created.body;
  assert.match(code, /^[A-Z0-9]{6}$/);

  const started = await json(`/api/games/${code}/start`, {
    method: "POST",
    body: JSON.stringify({ token, fillBots: true }),
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.state.status, "playing");
  assert.equal(started.body.state.players.length, 2);
  assert.equal(started.body.state.players.filter((p) => p.isBot).length, 1);

  let state = started.body.state;
  for (let i = 0; i < 800 && state.status !== "finished"; i++) {
    if (state.turn === playerId) {
      const action = state.you.legal[0];
      if (action) {
        const moved = await json(`/api/games/${code}/action`, {
          method: "POST",
          body: JSON.stringify({ token, ...action }),
        });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        state = moved.body.state;
        continue;
      }
    }
    await sleep(100);
    const polled = await json(`/api/games/${code}?token=${token}`);
    state = polled.body.state;
  }
  assert.equal(state.status, "finished", "match did not finish in time");
  assert.ok(state.winner, "a winner should be set");

  const replay = await json(`/api/games/${code}/log`);
  assert.ok(replay.body.log.length >= 4);
  assert.equal(replay.body.log.at(-1).kind, "finish");

  // Static client and invite routes.
  for (const route of ["/", `/g/${code}`]) {
    const res = await fetch(BASE + route);
    assert.equal(res.status, 200, route);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const html = await res.text();
    assert.match(html, /Sumo Arena/);
  }

  // A second human can join a lobby and leave it again.
  const lobby = await json("/api/games", {
    method: "POST",
    body: JSON.stringify({ name: "Host", maxPlayers: 2 }),
  });
  const joined = await json(`/api/games/${lobby.body.code}/join`, {
    method: "POST",
    body: JSON.stringify({ name: "Guest" }),
  });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.state.players.length, 2);
  const left = await json(`/api/games/${lobby.body.code}/leave`, {
    method: "POST",
    body: JSON.stringify({ token: joined.body.token }),
  });
  assert.equal(left.status, 200);
  const after = await json(`/api/games/${lobby.body.code}?token=${lobby.body.token}`);
  assert.equal(after.body.state.players.length, 1);

  const missing = await json("/api/games/ZZZZZZ");
  assert.equal(missing.status, 404);
});

// Sumo Arena bot — a small, dependency-free example agent.
//
// The same heuristic powers the in-browser bot seats, and this file is also a
// working sample of the public HTTP/JSON API:
//
//   node bot.mjs --demo                 # create a 4-player match and play it
//   node bot.mjs --join ABC123          # join a lobby and play when it starts
//   node bot.mjs --code ABC123 --token TOKEN   # play a seat you already hold
//
// All it needs is the state JSON returned by GET /api/games/:code.

const DIRS = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

/**
 * Choose one legal action from a public game state.
 * @param {any} state - the `state` object returned by the API
 * @returns {{type: "move"|"push", dir: "N"|"S"|"E"|"W"} | null}
 */
export function chooseAction(state) {
  if (!state || state.status !== "playing" || !state.you) return null;
  const me = state.players.find((p) => p.id === state.you.id);
  if (!me || !me.alive) return null;
  const legal = state.you.legal || [];
  if (!legal.length) return null;

  const n = state.board;
  const shrink = state.shrink || 0;
  const ring = (x, y) => Math.min(x, y, n - 1 - x, n - 1 - y);
  const passable = (x, y) => x >= 0 && y >= 0 && x < n && y < n && ring(x, y) >= shrink;
  const at = (x, y) => state.players.find((p) => p.alive && p.x === x && p.y === y) || null;
  const enemies = state.players.filter((p) => p.alive && p.id !== me.id);

  const pushInfo = (a) => {
    const [dx, dy] = DIRS[a.dir];
    const target = at(me.x + dx, me.y + dy);
    if (!target) return null;
    const bx = target.x + dx;
    const by = target.y + dy;
    return { target, bx, by, kill: !passable(bx, by) };
  };

  // 1. Take an elimination whenever it is available.
  const kills = legal
    .filter((a) => a.type === "push")
    .map((a) => ({ a, p: pushInfo(a) }))
    .filter((x) => x.p && x.p.kill);
  if (kills.length) {
    // Prefer eliminating the opponent closest to the centre (denies them the ring).
    kills.sort((x, y) => ring(x.p.target.x, x.p.target.y) - ring(y.p.target.x, y.p.target.y));
    return kills[0].a;
  }

  // 2. Otherwise weigh position, pressure and the risk of being pushed out.
  const dangerAt = (x, y) => {
    let danger = 0;
    for (const e of enemies) {
      const dx = e.x - x;
      const dy = e.y - y;
      if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
      if (!passable(x + dx, y + dy)) danger += 1;
    }
    return danger;
  };

  const scored = legal.map((a) => {
    const [dx, dy] = DIRS[a.dir];
    let score = 0;
    if (a.type === "push") {
      const p = pushInfo(a);
      if (!p) return { a, score: -999 };
      const destRing = passable(p.bx, p.by) ? ring(p.bx, p.by) : 0;
      // Pushing outward is progress; holding the centre matters more.
      score = 8 + (ring(p.target.x, p.target.y) - destRing) + (4 - ring(me.x, me.y)) * 0.5;
    } else {
      const nx = me.x + dx;
      const ny = me.y + dy;
      const nearest = enemies.reduce(
        (best, e) => Math.min(best, Math.abs(e.x - nx) + Math.abs(e.y - ny)),
        99
      );
      score =
        ring(nx, ny) * 2.2 -
        nearest * 0.55 -
        dangerAt(nx, ny) * 7 +
        dangerAt(me.x, me.y) * 5;
      if (nearest === 1) score += 0.8; // step in, threaten a push
    }
    score += Math.random() * 0.9; // stay unpredictable between equal moves
    return { a, score };
  });

  scored.sort((x, y) => y.score - x.score);
  return scored[0]?.a || legal[0];
}

// ---------------------------------------------------------------- sample CLI
const API = (process.env.SUMO_URL || "http://localhost:3000").replace(/\/$/, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status} on ${path}`);
  return body;
}

async function playSeat({ code, token, playerId, label }) {
  console.log(`${label}: playing match ${code} as ${playerId}`);
  let lastTurn = null;
  for (let guard = 0; guard < 1200; guard++) {
    const { state } = await call(`/api/games/${code}?token=${encodeURIComponent(token)}`);
    if (state.status === "finished") {
      const winner = state.players.find((p) => p.id === state.winner);
      console.log(`${label}: match over — ${winner ? `${winner.name} wins` : "draw"}`);
      return state;
    }
    if (state.status === "lobby") {
      await sleep(700);
      continue;
    }
    if (state.turn !== playerId) {
      await sleep(300);
      continue;
    }
    if (state.turn === lastTurn) await sleep(200);
    lastTurn = state.turn;
    const action = chooseAction(state);
    if (!action) {
      await sleep(300);
      continue;
    }
    console.log(`${label}: round ${state.round} ${action.type} ${action.dir}`);
    await call(`/api/games/${code}/action`, {
      method: "POST",
      body: JSON.stringify({ token, ...action }),
    });
    await sleep(120);
  }
  throw new Error("match did not finish");
}

async function demo() {
  const created = await call("/api/games", {
    method: "POST",
    body: JSON.stringify({ name: "DemoBot", maxPlayers: 4 }),
  });
  console.log(`created match ${created.code} (${API}/g/${created.code})`);
  await call(`/api/games/${created.code}/start`, {
    method: "POST",
    body: JSON.stringify({ token: created.token, fillBots: true }),
  });
  await playSeat({
    code: created.code,
    token: created.token,
    playerId: created.playerId,
    label: "DemoBot",
  });
}

async function join(code) {
  const name = `Bot-${Math.random().toString(36).slice(2, 6)}`;
  const joined = await call(`/api/games/${code}/join`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  console.log(`joined ${code} as ${name} (${joined.playerId}); waiting for the host`);
  await playSeat({
    code,
    token: joined.token,
    playerId: joined.playerId,
    label: name,
  });
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("--demo")) {
  demo().catch((err) => {
    console.error("demo failed:", err.message);
    process.exit(1);
  });
} else if (flag("--join")) {
  join(flag("--join").toUpperCase()).catch((err) => {
    console.error("join failed:", err.message);
    process.exit(1);
  });
} else if (flag("--code") && flag("--token")) {
  playSeat({
    code: flag("--code").toUpperCase(),
    token: flag("--token"),
    playerId: "seat",
    label: "Bot",
  }).catch((err) => {
    console.error("play failed:", err.message);
    process.exit(1);
  });
} else if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`Sumo Arena bot

  node bot.mjs --demo
  node bot.mjs --join <CODE>
  node bot.mjs --code <CODE> --token <TOKEN>

Server: ${API}`);
}

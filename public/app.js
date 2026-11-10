// Sumo Arena browser client. No dependencies; talks to the JSON API in server.mjs.
const $ = (sel) => document.querySelector(sel);
const DIRS = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
const SEAT_KEY = "sumo-arena-seat-v1";
const BOARD = 9;

const S = {
  code: null,
  playerId: null,
  token: null,
  state: null,
  es: null,
  pollTimer: null,
  refreshTimer: null,
  busy: false,
  overShown: false,
};

const screens = {
  home: $("#screen-home"),
  lobby: $("#screen-lobby"),
  game: $("#screen-game"),
};

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3600);
}

function saveSeat() {
  try {
    sessionStorage.setItem(
      SEAT_KEY,
      JSON.stringify({ code: S.code, playerId: S.playerId, token: S.token })
    );
  } catch {
    /* storage can be disabled; the session still works in memory */
  }
}
function clearSeat() {
  try {
    sessionStorage.removeItem(SEAT_KEY);
  } catch {
    /* ignore */
  }
}
function loadSeat() {
  try {
    return JSON.parse(sessionStorage.getItem(SEAT_KEY) || "null");
  } catch {
    return null;
  }
}

function inviteUrl(code) {
  return `${location.origin}/g/${code}`;
}

function closeLive() {
  if (S.es) {
    S.es.close();
    S.es = null;
  }
  clearInterval(S.pollTimer);
  S.pollTimer = null;
  clearTimeout(S.refreshTimer);
  S.refreshTimer = null;
}

function scheduleRefresh(delay = 120) {
  clearTimeout(S.refreshTimer);
  S.refreshTimer = setTimeout(refresh, delay);
}

function connectLive() {
  closeLive();
  if (!S.code) return;
  try {
    const es = new EventSource(`/api/games/${S.code}/stream`);
    es.onmessage = () => scheduleRefresh();
    S.es = es;
  } catch {
    /* polling below is the fallback */
  }
  S.pollTimer = setInterval(refresh, 3000);
}

async function refresh() {
  if (!S.code || !S.token) return;
  try {
    const { state } = await api(
      `/api/games/${S.code}?token=${encodeURIComponent(S.token)}`
    );
    S.state = state;
    if (state.status === "lobby") {
      show("lobby");
      renderLobby(state);
    } else {
      show("game");
      renderGame(state);
    }
  } catch (err) {
    if (err.status === 404) {
      toast("That match no longer exists.");
      goHome();
    }
  }
}

async function enterGame(code, playerId, token) {
  S.code = String(code || "").toUpperCase();
  S.playerId = playerId;
  S.token = token;
  S.state = null;
  S.overShown = false;
  saveSeat();
  connectLive();
  await refresh();
}

function goHome() {
  closeLive();
  clearSeat();
  S.code = null;
  S.playerId = null;
  S.token = null;
  S.state = null;
  $("#over").hidden = true;
  document.body.classList.remove("over-open");
  if (location.pathname !== "/") history.replaceState(null, "", "/");
  show("home");
}

// ---------------------------------------------------------------- home forms
$("#form-create").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim() || "Tanuki";
  const maxPlayers = Number(data.get("seats") || 2);
  try {
    const created = await api("/api/games", {
      method: "POST",
      body: JSON.stringify({ name, maxPlayers }),
    });
    await enterGame(created.code, created.playerId, created.token);
  } catch (err) {
    toast(err.message);
  }
});

$("#form-join").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const code = String(data.get("code") || "").trim().toUpperCase();
  const name = String(data.get("name") || "").trim() || "Kappa";
  if (code.length !== 6) return toast("Match codes are six characters.");
  try {
    const joined = await api(`/api/games/${code}/join`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await enterGame(joined.code, joined.playerId, joined.token);
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------- lobby
function renderLobby(state) {
  $("#lobby-code").textContent = state.code;
  const me = state.you;
  const humans = state.players;
  const taken = humans.length;
  $("#lobby-sub").textContent =
    `${taken} of ${state.maxPlayers} seats taken. ` +
    (taken < state.maxPlayers
      ? `${state.maxPlayers - taken} empty seat${state.maxPlayers - taken === 1 ? "" : "s"} will be filled by bots.`
      : "The ring is full.");

  const list = $("#lobby-players");
  list.innerHTML = "";
  for (const p of humans) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="dot" style="background:${p.color}"></span>
      <span>${escapeHtml(p.name)}</span>
      ${p.id === state.you?.id ? '<span class="tag me">you</span>' : ""}
      ${p.host ? '<span class="tag">host</span>' : ""}`;
    list.append(li);
  }
  for (let i = humans.length; i < state.maxPlayers; i++) {
    const li = document.createElement("li");
    li.className = "ghost";
    li.innerHTML = `<span class="dot"></span><span>Open seat</span><span class="tag">bot</span>`;
    list.append(li);
  }

  const isHost = Boolean(me && me.isHost);
  $("#btn-start").hidden = !isHost;
  $("#lobby-wait").hidden = isHost;
  $("#btn-start").textContent = taken < state.maxPlayers ? "Start with bots" : "Start match";
}

$("#btn-start").addEventListener("click", async () => {
  if (!S.code || !S.token) return;
  $("#btn-start").disabled = true;
  try {
    await api(`/api/games/${S.code}/start`, {
      method: "POST",
      body: JSON.stringify({ token: S.token, fillBots: true }),
    });
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    $("#btn-start").disabled = false;
  }
});

$("#btn-copy").addEventListener("click", async () => {
  const url = inviteUrl(S.code);
  try {
    await navigator.clipboard.writeText(url);
    toast("Invite link copied.");
  } catch {
    const area = document.createElement("textarea");
    area.value = url;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      document.execCommand("copy");
      toast("Invite link copied.");
    } catch {
      toast(url);
    }
    area.remove();
  }
});

// ---------------------------------------------------------------- board
const board = $("#board");
for (let y = 0; y < BOARD; y++) {
  for (let x = 0; x < BOARD; x++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.x = String(x);
    cell.dataset.y = String(y);
    board.append(cell);
  }
}
const cells = [...board.children];

function myPlayer() {
  if (!S.state || !S.state.you) return null;
  return S.state.players.find((p) => p.id === S.state.you.id) || null;
}

function initials(name) {
  const clean = String(name || "").trim();
  const bot = clean.match(/^bot\s*(\d+)$/i);
  if (bot) return `B${bot[1]}`;
  const words = clean.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase() || "?";
}

function renderBoard(state) {
  const me = myPlayer();
  const legal = state.you?.legal || [];
  const targets = new Map();
  for (const action of legal) {
    const [dx, dy] = DIRS[action.dir];
    targets.set(`${me.x + dx},${me.y + dy}`, action.type);
  }

  for (const cell of cells) {
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    const ring = Math.min(x, y, BOARD - 1 - x, BOARD - 1 - y);
    cell.classList.toggle("void", ring < state.shrink);
    const kind = targets.get(`${x},${y}`);
    cell.classList.toggle("legal-move", kind === "move");
    cell.classList.toggle("legal-push", kind === "push");
  }

  const seen = new Set();
  for (const p of state.players) {
    seen.add(p.id);
    let piece = board.querySelector(`.piece[data-id="${p.id}"]`);
    if (!piece) {
      piece = document.createElement("div");
      piece.className = "piece";
      piece.dataset.id = p.id;
      piece.innerHTML = `<div class="disc" style="background:${p.color}"><span>${escapeHtml(
        initials(p.name)
      )}</span></div>`;
      piece.title = p.name;
      board.append(piece);
    }
    piece.style.left = `${(p.x * 100) / BOARD}%`;
    piece.style.top = `${(p.y * 100) / BOARD}%`;
    piece.classList.toggle("dead", !p.alive);
    piece.classList.toggle("active", state.status === "playing" && state.turn === p.id);
    const disc = piece.querySelector(".disc");
    disc.style.background = p.color;
    disc.querySelector("span").textContent = initials(p.name);
    piece.title = `${p.name}${p.alive ? ` — ${p.x},${p.y}` : " — out"}`;
  }
  for (const piece of board.querySelectorAll(".piece")) {
    if (!seen.has(piece.dataset.id)) piece.remove();
  }
}

function renderGame(state) {
  const me = myPlayer();
  const current = state.players.find((p) => p.id === state.turn);
  const youTurn = state.status === "playing" && state.turn === S.playerId;

  $("#stat-round").textContent = String(state.round);
  $("#stat-ring").textContent = `${state.shrink}/4`;

  const turnPill = $("#turn-pill");
  const dot = $("#turn-dot");
  if (state.status === "finished") {
    const winner = state.players.find((p) => p.id === state.winner);
    $("#turn-text").textContent = winner ? `${winner.name} wins` : "Draw";
    dot.style.background = winner ? winner.color : "#8b7e6b";
  } else {
    $("#turn-text").textContent = youTurn
      ? "Your turn"
      : `${current ? current.name : "Someone"} to move`;
    dot.style.background = current ? current.color : "#8b7e6b";
  }
  turnPill.style.borderColor = youTurn ? "rgba(63,167,150,.55)" : "";

  renderBoard(state);

  const list = $("#game-players");
  list.innerHTML = "";
  for (const p of state.players) {
    const li = document.createElement("li");
    if (!p.alive) li.classList.add("dead");
    li.innerHTML = `
      <span class="dot" style="background:${p.color}"></span>
      <span>${escapeHtml(p.name)}</span>
      ${p.id === S.playerId ? '<span class="tag me">you</span>' : ""}
      ${p.isBot ? '<span class="tag">bot</span>' : ""}
      ${p.host ? '<span class="tag">host</span>' : ""}
      <span class="pos">${p.alive ? `${p.pushes} push${p.pushes === 1 ? "" : "es"}` : "out"}</span>`;
    list.append(li);
  }

  const log = $("#log");
  log.innerHTML = "";
  for (const entry of state.log || []) {
    const li = document.createElement("li");
    if (entry.kind) li.classList.add(entry.kind);
    li.innerHTML = `<span class="r">R${entry.round}</span><span>${escapeHtml(entry.text)}</span>`;
    log.append(li);
  }
  log.scrollTop = log.scrollHeight;

  const nextShrink = 3 - ((state.round - 1) % 3);
  const ringStatus = $("#ring-status");
  if (state.shrink >= 4) {
    ringStatus.innerHTML = "The ring is gone — <b>sudden death</b>.";
  } else if (state.status === "finished") {
    ringStatus.innerHTML = "Match over.";
  } else {
    ringStatus.innerHTML = `Next shrink in <b>${nextShrink}</b> round${nextShrink === 1 ? "" : "s"}.`;
  }
  const ringDots = $("#ring-dots");
  if (ringDots.children.length !== 4) {
    ringDots.innerHTML = "<i></i><i></i><i></i><i></i>";
  }
  [...ringDots.children].forEach((dot, i) => dot.classList.toggle("on", state.shrink > i));

  const hint = $("#hint");
  if (state.status === "finished") {
    const winner = state.players.find((p) => p.id === state.winner);
    hint.innerHTML = winner
      ? `<b>${escapeHtml(winner.name)}</b> takes the ring.`
      : "Nobody survives — a draw.";
  } else if (!me || !me.alive) {
    hint.textContent = "You are out — spectating the rest of the match.";
  } else if (youTurn) {
    hint.innerHTML = "Your turn — click a glowing cell, or use <b>WASD</b> / arrows.";
  } else if (current?.isBot) {
    hint.textContent = "Bot is thinking…";
  } else {
    hint.textContent = `Waiting for ${current ? current.name : "the next player"}…`;
  }

  if (state.status === "finished" && !S.overShown) {
    S.overShown = true;
    const winner = state.players.find((p) => p.id === state.winner);
    const mine = winner && winner.id === S.playerId;
    $("#over-title").textContent = winner ? (mine ? "You win" : `${winner.name} wins`) : "Draw";
    $("#over-sub").textContent = winner
      ? mine
        ? `Last one standing after ${state.round} round${state.round === 1 ? "" : "s"}. Nicely pushed.`
        : `Last one standing after ${state.round} round${state.round === 1 ? "" : "s"}.`
      : "The ring took everyone.";
    $("#over").hidden = false;
    document.body.classList.add("over-open");
  }
}

function actDir(dir) {
  if (S.busy || !S.state || S.state.status !== "playing") return;
  const me = myPlayer();
  if (!me || !me.alive) return;
  if (S.state.turn !== S.playerId) return toast("Not your turn yet.");
  const [dx, dy] = DIRS[dir];
  const x = me.x + dx;
  const y = me.y + dy;
  const occupied = S.state.players.some((p) => p.alive && p.x === x && p.y === y);
  const legal = (S.state.you?.legal || []).find(
    (a) => a.dir === dir && a.type === (occupied ? "push" : "move")
  );
  if (!legal) {
    return toast(occupied ? "You cannot push that way." : "That cell is out of play.");
  }
  act(legal);
}

async function act(action) {
  if (S.busy) return;
  S.busy = true;
  try {
    const { state } = await api(`/api/games/${S.code}/action`, {
      method: "POST",
      body: JSON.stringify({ token: S.token, ...action }),
    });
    S.state = state;
    renderGame(state);
  } catch (err) {
    toast(err.message);
    scheduleRefresh(80);
  } finally {
    S.busy = false;
  }
}

board.addEventListener("click", (event) => {
  const cell = event.target.closest(".cell");
  if (!cell || !S.state) return;
  const me = myPlayer();
  if (!me || !me.alive) return;
  const x = Number(cell.dataset.x);
  const y = Number(cell.dataset.y);
  const dx = x - me.x;
  const dy = y - me.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) {
    if (S.state.turn === S.playerId) toast("Pick a cell next to your disc.");
    return;
  }
  actDir(dx === 1 ? "E" : dx === -1 ? "W" : dy === 1 ? "S" : "N");
});

document.addEventListener("keydown", (event) => {
  if (screens.game.hidden || S.busy) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  const map = {
    ArrowUp: "N",
    ArrowDown: "S",
    ArrowLeft: "W",
    ArrowRight: "E",
    w: "N",
    W: "N",
    s: "S",
    S: "S",
    a: "W",
    A: "W",
    d: "E",
    D: "E",
  };
  const dir = map[event.key];
  if (!dir) return;
  event.preventDefault();
  actDir(dir);
});

// ---------------------------------------------------------------- leaving / restart
$("#btn-leave").addEventListener("click", async () => {
  if (S.state?.status === "playing") {
    const ok = window.confirm("Leave the match? A bot will finish your seat.");
    if (!ok) return;
  }
  try {
    if (S.code && S.token) {
      await api(`/api/games/${S.code}/leave`, {
        method: "POST",
        body: JSON.stringify({ token: S.token }),
      });
    }
  } catch {
    /* leaving is best-effort */
  }
  goHome();
});

$("#btn-home").addEventListener("click", goHome);

$("#btn-again").addEventListener("click", async () => {
  const name = S.state?.you?.name || "Tanuki";
  const maxPlayers = S.state?.maxPlayers || 2;
  $("#over").hidden = true;
  document.body.classList.remove("over-open");
  try {
    const created = await api("/api/games", {
      method: "POST",
      body: JSON.stringify({ name, maxPlayers }),
    });
    await enterGame(created.code, created.playerId, created.token);
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------- boot
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.code) scheduleRefresh(50);
});

(function boot() {
  const pathCode = location.pathname.match(/^\/g\/([A-Za-z0-9]{6})$/);
  const seat = loadSeat();
  if (pathCode) {
    const code = pathCode[1].toUpperCase();
    if (seat && seat.code === code) {
      enterGame(seat.code, seat.playerId, seat.token);
      return;
    }
    const joinForm = $("#form-join");
    joinForm.elements.code.value = code;
    joinForm.elements.name.focus();
    show("home");
    return;
  }
  if (seat && seat.code && seat.token) {
    enterGame(seat.code, seat.playerId, seat.token);
    return;
  }
  show("home");
})();

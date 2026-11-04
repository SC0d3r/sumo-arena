#!/usr/bin/env node
// End-to-end browser check against the running Sumo Arena server.
// Opens its own tab in the already-running Chrome (CDP 9222), creates a match,
// starts it against a bot, makes one move, and captures screenshots.
import fs from "node:fs";

const CDP = Number(process.env.CDP_PORT || 9222);
const URL = process.env.SUMO_URL || "http://127.0.0.1:3000/";
const OUT = process.env.OUT_DIR || "/tmp/sumo-ui";
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTab(url) {
  const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!r.ok) throw new Error(`new tab: HTTP ${r.status}`);
  return r.json();
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send };
}

const tab = await newTab(URL);
const { ws, send } = await connect(tab.webSocketDebuggerUrl);
const errors = [];
try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval failed");
    return r.result.value;
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = `${OUT}/${name}.png`;
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  };

  for (let i = 0; i < 60; i++) {
    const ready = await ev("document.readyState").catch(() => "loading");
    if (ready === "complete") break;
    await sleep(200);
  }
  // Wait for the client module to boot: it builds the 81 board cells at import.
  for (let i = 0; i < 100; i++) {
    const cells = await ev("document.querySelectorAll('#board .cell').length").catch(() => 0);
    if (cells === 81) break;
    await sleep(200);
  }
  await sleep(400);

  const home = await ev(`(() => ({
    title: document.title,
    h1: document.querySelector('h1')?.innerText,
    bodyLen: document.body.innerText.length,
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
    cards: document.querySelectorAll('.home-grid .card').length,
    boardCells: document.querySelectorAll('#board .cell').length,
    scrollH: document.documentElement.scrollHeight,
    viewH: window.innerHeight,
    pageScroll: document.documentElement.scrollHeight > window.innerHeight + 2
  }))()`);
  const homeShot = await shot("home");

  // Fill the create form and submit it like a person would.
  const created = await ev(`(() => {
    const form = document.querySelector('#form-create');
    form.elements.name.value = 'UI-Tester';
    form.requestSubmit();
    return true;
  })()`);
  await sleep(1600);

  const lobby = await ev(`(() => ({
    code: document.querySelector('#lobby-code')?.textContent,
    players: [...document.querySelectorAll('#lobby-players li')].map(li => li.innerText.replace(/\\n/g,' ')),
    startVisible: !document.querySelector('#btn-start')?.hidden,
    path: location.pathname
  }))()`);
  const lobbyShot = await shot("lobby");

  await ev(`document.querySelector('#btn-start').click()`);
  await sleep(2200);

  const game = await ev(`(() => ({
    turn: document.querySelector('#turn-text')?.textContent,
    round: document.querySelector('#stat-round')?.textContent,
    pieces: document.querySelectorAll('#board .piece').length,
    legal: document.querySelectorAll('#board .legal-move, #board .legal-push').length,
    logRows: document.querySelectorAll('#log li').length,
    hint: document.querySelector('#hint')?.textContent,
    scrollH: document.documentElement.scrollHeight,
    viewH: window.innerHeight,
    pageScroll: document.documentElement.scrollHeight > window.innerHeight + 2,
    boardBottom: Math.round(document.querySelector('.board-shell').getBoundingClientRect().bottom)
  }))()`);
  const gameShot = await shot("game");

  // Make one legal move if it is our turn.
  const moved = await ev(`(() => {
    const cell = document.querySelector('#board .cell.legal-move, #board .cell.legal-push');
    if (!cell) return 'no legal target';
    cell.click();
    return { x: cell.dataset.x, y: cell.dataset.y };
  })()`);
  await sleep(1600);
  const after = await ev(`(() => ({
    turn: document.querySelector('#turn-text')?.textContent,
    round: document.querySelector('#stat-round')?.textContent,
    logRows: document.querySelectorAll('#log li').length,
    lastLog: document.querySelector('#log li:last-child')?.innerText.replace(/\\n/g,' ')
  }))()`);
  const afterShot = await shot("after-move");

  console.log(JSON.stringify({ home, created, lobby, game, moved, after, shots: { homeShot, lobbyShot, gameShot, afterShot }, errors }, null, 1));
} finally {
  ws.close();
}

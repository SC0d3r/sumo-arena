#!/usr/bin/env node
// Play a whole 2-seat match against the bot through the public URL and verify
// the finish overlay. Uses its own tab in the already-running Chrome (CDP 9222).
const CDP = Number(process.env.CDP_PORT || 9222);
const URL = process.env.SUMO_URL || "http://127.0.0.1:3000/";
const OUT = process.env.OUT_DIR || "/tmp/sumo-full";
import fs from "node:fs";
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tab = await (
  await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(URL)}`, { method: "PUT" })
).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
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
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

for (let i = 0; i < 120; i++) {
  const cells = await ev("document.querySelectorAll('#board .cell').length").catch(() => 0);
  if (cells === 81) break;
  await sleep(250);
}

// Create a two-seat match and start it against the bot.
await ev(`(() => {
  const f = document.querySelector('#form-create');
  f.elements.name.value = 'FullRun';
  f.querySelector('input[name=seats][value="2"]').checked = true;
  f.requestSubmit();
  return true;
})()`);
await sleep(2500);
const code = await ev("document.querySelector('#lobby-code')?.textContent");
await ev("document.querySelector('#btn-start')?.click()");
await sleep(2500);

let moves = 0;
let status = "playing";
for (let i = 0; i < 400 && status !== "finished"; i++) {
  const s = await ev(`(() => ({
    status: (document.querySelector('#over') && !document.querySelector('#over').hidden) ? 'finished' : 'playing',
    myTurn: document.querySelector('#turn-text')?.textContent === 'Your turn',
    legal: document.querySelectorAll('#board .cell.legal-move, #board .cell.legal-push').length,
    round: document.querySelector('#stat-round')?.textContent,
    shrink: document.querySelector('#stat-ring')?.textContent
  }))()`);
  status = s.status;
  if (status === "finished") break;
  if (s.myTurn && s.legal > 0) {
    await ev(`(() => {
      const cells = [...document.querySelectorAll('#board .cell.legal-move, #board .cell.legal-push')];
      const pick = cells[Math.floor(Math.random() * cells.length)];
      pick.click();
      return true;
    })()`);
    moves++;
    await sleep(900);
  } else {
    await sleep(500);
  }
}

const final = await ev(`(() => ({
  over: !document.querySelector('#over').hidden,
  title: document.querySelector('#over-title')?.textContent,
  sub: document.querySelector('#over-sub')?.textContent,
  logRows: document.querySelectorAll('#log li').length,
  lastLog: document.querySelector('#log li:last-child')?.innerText.replace(/\\n/g,' '),
  hint: document.querySelector('#hint')?.textContent,
  scrollH: document.documentElement.scrollHeight,
  viewH: window.innerHeight
}))()`);

const { data } = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(`${OUT}/finished.png`, Buffer.from(data, "base64"));

console.log(JSON.stringify({ code, moves, status, final, shot: `${OUT}/finished.png` }, null, 1));
ws.close();

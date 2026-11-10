#!/usr/bin/env node
// Mobile sanity check: 390x844, load home, create + start a 2-seat match,
// tap a legal cell, and report layout metrics + console errors.
const CDP = Number(process.env.CDP_PORT || 9222);
const URL = process.env.SUMO_URL || "http://127.0.0.1:3000/";
const OUT = process.env.OUT_DIR || "/tmp/sumo-mobile";
import fs from "node:fs";
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tab = await (
  await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(URL)}`, { method: "PUT" })
).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const errors = [];
ws.onmessage = (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") { const d=m.params.exceptionDetails||{}; errors.push(((d.exception&&d.exception.description)||d.text||"exception").slice(0,600)); }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
    errors.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 200));
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
});
await send("Emulation.setTouchEmulationEnabled", { enabled: true });

for (let i = 0; i < 120; i++) {
  const cells = await ev("document.querySelectorAll('#board .cell').length").catch(() => 0);
  if (cells === 81) break;
  await sleep(250);
}
await sleep(500);
const home = await ev(`(() => ({
  scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
  scrollH: document.documentElement.scrollHeight, viewH: window.innerHeight,
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  createVisible: !!document.querySelector('#form-create')?.offsetParent,
  title: document.title
}))()`);
await shot("home");

await ev(`(() => {
  const f = document.querySelector('#form-create');
  f.elements.name.value = 'MobileMax';
  f.querySelector('input[name=seats][value="2"]').checked = true;
  f.requestSubmit();
  return true;
})()`);
await sleep(2500);
await ev("document.querySelector('#btn-start')?.click()");
await sleep(2500);

const game = await ev(`(() => ({
  scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  boardW: document.querySelector('#board')?.getBoundingClientRect().width,
  boardH: document.querySelector('#board')?.getBoundingClientRect().height,
  boardBottom: document.querySelector('#board')?.getBoundingClientRect().bottom,
  viewH: window.innerHeight,
  turn: document.querySelector('#turn-text')?.textContent,
  legal: document.querySelectorAll('#board .cell.legal-move, #board .cell.legal-push').length,
  tapTarget: (() => { const c = document.querySelector('#board .cell'); if (!c) return null; const r = c.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()
}))()`);
await shot("game");

// Tap one legal cell via a real touch event.
const tapped = await ev(`(() => {
  const c = document.querySelector('#board .cell.legal-move, #board .cell.legal-push');
  if (!c) return 'no legal cell';
  const r = c.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width/2, clientY: r.top + r.height/2, pointerType: 'touch' };
  c.dispatchEvent(new PointerEvent('pointerdown', opts));
  c.dispatchEvent(new PointerEvent('pointerup', opts));
  c.click();
  return 'tapped';
})()`);
await sleep(2000);
const after = await ev(`(() => ({
  turn: document.querySelector('#turn-text')?.textContent,
  round: document.querySelector('#stat-round')?.textContent,
  logRows: document.querySelectorAll('#log li').length,
  scrollH: document.documentElement.scrollHeight,
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
}))()`);
await shot("after-tap");

console.log(JSON.stringify({ home, game, tapped, after, errors, shots: OUT }, null, 1));
ws.close();

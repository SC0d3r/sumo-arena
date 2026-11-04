#!/usr/bin/env node
// Attach to an existing Chrome tab (matched by URL substring) instead of
// opening a new one, so multi-step flows such as OAuth survive between calls.
//
//   node cdp-tab.mjs <url-substring> dump
//   node cdp-tab.mjs <url-substring> eval "<expression>"
//   node cdp-tab.mjs <url-substring> click "<selector>"
//   node cdp-tab.mjs <url-substring> open <url>     # navigate this tab
//
// The tab itself stays open; only the debugger websocket is closed.

const PORT = Number(process.env.CDP_PORT || 9222);
const [match, mode, arg] = process.argv.slice(2);
if (!match || !mode) {
  console.error("usage: cdp-tab.mjs <url-substring> dump|eval|click|open [arg]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!r.ok) throw new Error(`targets: HTTP ${r.status}`);
  return r.json();
}

async function findTab() {
  const list = await targets();
  return (
    list.find((t) => t.type === "page" && decodeURIComponent(t.url).includes(match)) ||
    list.find((t) => t.type === "page" && t.url.includes(match)) ||
    null
  );
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

const tab = await findTab();
if (!tab) {
  console.error(`no tab matching ${match}`);
  process.exit(1);
}
const { ws, send } = await connect(tab.webSocketDebuggerUrl);
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval failed");
  return r.result.value;
};

try {
  if (mode === "open") {
    await send("Page.navigate", { url: arg });
    await sleep(2500);
  }
  for (let i = 0; i < 40; i++) {
    const ready = await ev("document.readyState").catch(() => "loading");
    if (ready === "complete") break;
    await sleep(300);
  }
  if (mode === "dump") {
    const out = await ev(`(() => {
      const rows = [];
      document.querySelectorAll("input,select,textarea,button,a").forEach((el) => rows.push({
        tag: el.tagName, type: el.type || "", name: el.name || "", id: el.id || "",
        href: (el.href || "").slice(0, 160),
        text: (el.innerText || "").trim().slice(0, 60),
      }));
      return { title: document.title, url: location.href, text: document.body.innerText.slice(0, 1500), fields: rows.slice(0, 60) };
    })()`);
    console.log(JSON.stringify(out, null, 1));
  } else if (mode === "eval") {
    console.log(JSON.stringify(await ev(arg), null, 1));
  } else if (mode === "click") {
    const out = await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(arg)});
      if (!el) return "not found";
      el.click();
      return "clicked " + (el.innerText || el.tagName).slice(0, 40);
    })()`);
    console.log(out);
  }
} finally {
  ws.close();
}

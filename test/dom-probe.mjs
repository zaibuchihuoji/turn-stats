/**
 * DOM 挂载探针：检查 turn-stats 运行时状态 + 手动往最后一轮 append 测试行。
 * 用法：node test/dom-probe.mjs
 */
const PORT = 9226;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return list.filter((t) => t.type === "page" && /sessions\//.test(t.url ?? ""))[0];
}
const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r?.result?.value;
};

await send("Runtime.enable");
const out = await evalJs(`(() => {
  const o = {};
  o.installed = !!window.__turnStatsInstalled;
  o.state = window.__turnStatsState ?? null;
  const turns = [...document.querySelectorAll('[data-turn-id]')].filter(el => el.dataset.turnId && !/cron/i.test(el.className));
  o.turnCount = turns.length;
  if (turns.length) {
    const last = turns[turns.length - 1];
    o.lastClass = String(last.className).slice(0, 60);
    const d = document.createElement('div');
    d.className = 'ts-line ts-scope';
    d.textContent = 'MANUAL-TEST';
    last.appendChild(d);
    o.manualAppend = 'ok';
    o.existingLines = document.querySelectorAll('.ts-line').length;
  }
  return JSON.stringify(o);
})()`);
console.log(out);
process.exit(0);

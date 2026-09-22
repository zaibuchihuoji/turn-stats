/**
 * WS 嗅探：订阅指定会话（默认最近会话），打印收到的所有消息类型分布与
 * turn.* 事件负载。用法：node test/ws-sniff.mjs [秒数=45]
 */
const PORT = 9226;
const DURATION = Number(process.argv[2] ?? 45) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.filter((t) => t.type === "page" && /sessions\//.test(t.url ?? ""))[0];
if (!page) throw new Error("未找到会话页");
const SID = page.url.split("/").pop().split("?")[0];
console.log("嗅探会话:", SID.slice(0, 34));

// 本地 server origin 从页面里拿（有鉴权考虑时更稳）
const ws2 = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws2.onopen = res; ws2.onerror = rej; });
let seq = 0; const pending = new Map();
ws2.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send2 = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws2.send(JSON.stringify({ id, method, params })); });
let origin = null;
for (let i = 0; i < 10 && !origin; i++) {
  const r = await send2("Runtime.evaluate", {
    expression: "sessionStorage.getItem('kimi-desktop-server-origin')", returnByValue: true,
  });
  origin = r?.result?.value ?? null;
  if (!origin) await sleep(1000);
}
if (!origin) throw new Error("拿不到 server origin");
console.log("origin:", origin);
ws2.close();

const ws = new WebSocket(origin.replace("http", "ws") + "/api/v1/ws?client_id=sniff-" + Date.now());
const types = new Map();
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "subscribe_v2", id: 1, payload: { session_id: SID } }));
  console.log("已订阅，嗅探", DURATION / 1000, "秒…");
};
ws.onmessage = (ev) => {
  try {
    const m = JSON.parse(ev.data);
    const t = m.type ?? m.envelope?.type ?? "?";
    types.set(t, (types.get(t) ?? 0) + 1);
    if (/turn/i.test(t)) {
      console.log("!!", t, "| turnId", m.envelope?.payload?.turnId ?? m.payload?.turnId,
        "| usage", JSON.stringify(m.envelope?.payload?.usage ?? m.payload?.usage ?? ""),
        "| dur", m.envelope?.payload?.durationMs ?? m.payload?.durationMs ?? "");
    }
  } catch {}
};
await sleep(DURATION);
console.log("=== 消息类型分布 ===");
for (const [t, n] of [...types].sort((a, b) => b[1] - a[1])) console.log(" ", t, "×", n);
process.exit(0);

/**
 * CDP 深度探针：全部会话的 usage + 最近会话的消息列表形状。
 * 用法：node test/cdp-probe2.mjs
 */
const PORT = 9226;
async function findPage() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return list.filter((t) => t.type === "page" && /app:\/\/renderer\/sessions\//.test(t.url ?? ""))[0];
}
const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;

await send("Runtime.enable");
const probe = await evalJs(`(async () => {
  const origin = sessionStorage.getItem("kimi-desktop-server-origin");
  const raw = sessionStorage.getItem("kimi-web.server-credential");
  const token = raw ? JSON.parse(raw)?.credential : null;
  const H = token ? { Authorization: "Bearer " + token } : {};
  const get = async (p) => (await fetch(origin + p, { headers: H })).json();
  const list = (await get("/api/v1/sessions?limit=20"))?.data?.items ?? [];
  const sessions = list.map((s) => ({
    id: s.id?.slice(0, 14), title: (s.title ?? "").slice(0, 16),
    model: s.agent_config?.model, busy: s.busy, mta: s.main_turn_active,
    in: s.usage?.input_tokens, out: s.usage?.output_tokens, turns: s.usage?.turn_count,
    msgs: s.message_count,
  }));
  // 最近活跃会话的消息列表
  const target = list.find((s) => s.busy || s.main_turn_active) ?? list[0];
  let messages = null;
  try {
    const mj = await get("/api/v1/sessions/" + target.id + "/messages");
    const items = mj?.data?.items ?? mj?.data?.messages ?? mj?.data ?? [];
    const arr = Array.isArray(items) ? items : (items?.items ?? []);
    messages = {
      envelopeKeys: Object.keys(mj?.data ?? {}),
      count: arr.length,
      sample: arr.slice(-3).map((m) => ({
        keys: Object.keys(m).slice(0, 20),
        role: m.role ?? m.type,
        usage: m.usage ?? m.token_usage ?? m.tokens ?? "(无 usage 字段)",
      })),
    };
  } catch (e) { messages = { err: String(e) }; }
  return { sessions, target: target.id?.slice(0, 14), model: target.agent_config?.model, messages };
})()`);
console.log(JSON.stringify(probe, null, 1));
process.exit(0);

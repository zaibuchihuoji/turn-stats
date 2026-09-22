/**
 * CDP 字段探针：在渲染进程内直接调本地 server，确认会话列表/详情的真实字段。
 * 用法：node test/cdp-probe.mjs
 */
const PORT = 9226;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pages = list.filter((t) => t.type === "page" && /app:\/\/renderer\/sessions\//.test(t.url ?? ""));
  if (!pages[0]) throw new Error("未找到会话页");
  return pages[0];
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
  const get = async (p) => {
    const r = await fetch(origin + p, { headers: H });
    return { status: r.status, body: await r.json() };
  };
  const list = await get("/api/v1/sessions?limit=5");
  const first = list.body?.data?.items?.[0];
  const sid = first?.id;
  let detail = null;
  try { detail = await get("/api/v1/sessions/" + sid); } catch (e) { detail = { err: String(e) }; }
  return {
    origin,
    listEnvelopeKeys: Object.keys(list.body ?? {}),
    listDataKeys: Object.keys(list.body?.data ?? {}),
    itemKeys: first ? Object.keys(first) : null,
    itemUsage: first?.usage ?? "(列表项无 usage 字段)",
    itemBusy: first ? { busy: first.busy, main_turn_active: first.main_turn_active } : null,
    detailStatus: detail.status,
    detailDataKeys: detail.body?.data ? Object.keys(detail.body.data) : Object.keys(detail.body ?? {}),
    detailUsage: detail.body?.data?.usage ?? detail.body?.usage ?? "(详情无 usage)",
  };
})()`);
console.log(JSON.stringify(probe, null, 1));
process.exit(0);

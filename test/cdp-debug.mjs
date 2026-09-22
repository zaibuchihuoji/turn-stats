/**
 * CDP 调试：连接 Kimi Code Desktop（--remote-debugging-port=9226），
 * 检查 turn-stats 运行时状态 → 自动发送一条测试消息 → 跟踪回合检测全链路。
 * 用法：node test/cdp-debug.mjs ["测试消息内容"]
 */
const PORT = 9226;
const MESSAGE = process.argv[2] ?? "你好，请用一句话回复我";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = list.filter((t) => t.type === "page" && /app:\/\/renderer\/sessions\//.test(t.url ?? ""));
      if (pages[0]) return pages[0];
    } catch {}
    await sleep(1000);
  }
  throw new Error("未找到会话页 target");
}

const page = await findPage();
console.log("page:", page.url.slice(0, 70));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const consoleLogs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    consoleLogs.push(`[${msg.params.type}] ${text}`);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r?.result?.value;
}

await send("Runtime.enable");

// 1. 运行时状态
for (let i = 0; i < 15; i++) {
  const installed = await evalJs("!!window.__turnStatsInstalled");
  if (installed) break;
  await sleep(1000);
}
const installed = await evalJs("!!window.__turnStatsInstalled");
console.log("runtime 已安装:", installed);
if (!installed) {
  console.log("!! 脚本没在页面里 —— index.html 可能被 app:// 缓存或注入被清");
  const tag = await evalJs("!!document.getElementById('turn-stats-style')");
  console.log("style 标记存在:", tag);
  process.exit(1);
}

// 2. 初始诊断
console.log("初始状态:", JSON.stringify(await evalJs("window.__turnStatsState"), null, 1));
console.log("turn 元素数:", await evalJs("document.querySelectorAll('[data-turn-id]').length"));

// 3. 发送测试消息（点击 composer → 输入 → Enter）
const rect = await evalJs(`(() => {
  const el = document.querySelector('.ProseMirror') || document.querySelector('[contenteditable=true]');
  if (!el) return null;
  el.focus();
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
if (!rect) { console.log("!! 未找到 composer"); process.exit(1); }
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
await sleep(300);
await send("Input.insertText", { text: MESSAGE });
await sleep(200);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
console.log("已发送测试消息");

// 4. 跟踪回合检测（40 秒）
for (let i = 0; i < 14; i++) {
  await sleep(3000);
  const st = await evalJs("window.__turnStatsState");
  console.log(`t+${(i + 1) * 3}s`, JSON.stringify(st));
  if (st?.recordsCount > 0) {
    const hasLine = await evalJs("!!document.querySelector('.ts-line')");
    const lineText = await evalJs("document.querySelector('.ts-line')?.textContent ?? ''");
    console.log(">>> 统计行已挂载:", hasLine, "| 内容:", lineText);
    break;
  }
}
console.log("--- 最近的 console 输出 ---");
for (const l of consoleLogs.filter((l) => l.includes("turn-stats")).slice(-8)) console.log(l);
process.exit(0);

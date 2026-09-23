#!/usr/bin/env node
/**
 * turn-stats 真机验证闭环：注入最新副本 → 强制重启 Kimi Code（带
 * --remote-debugging-port=9226）→ 通过 CDP 断言运行时状态。
 *
 * 断言项：脚本已加载且版本为最新注入版 / 样式已注入 / 悬浮条已挂载 /
 * 数据链路正常（sidecar 连通、无错误）/ 配色已生效 / 两侧对齐（宽度跟随
 * 输入框）/ 不遮挡输入框（悬浮条底边 ≤ 输入框顶边）/ 悬浮条在视口内。
 *
 * 注意：会强制结束并重启 Kimi Code（对话在服务端，不丢数据），验证完成后
 * 应用保持运行。用法：node scripts/verify.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(HERE);
const AUTO = join(PLUGIN_ROOT, "scripts", "auto-patch.mjs");
const VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, "kimi.plugin.json"), "utf8")).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 挑一个空闲的 CDP 调试端口（固定端口可能被已死进程的僵尸监听占住）
async function pickPort() {
  for (let p = 9400; p < 9500; p++) {
    const free = await new Promise((res) => {
      const s = createServer();
      s.once("error", () => res(false));
      s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
    });
    if (free) return p;
  }
  throw new Error("9400-9499 无空闲端口");
}
const CDP_PORT = await pickPort();
const CDP = `http://127.0.0.1:${CDP_PORT}`;

let passed = 0, failed = 0;
const assert = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`ok: ${name}${detail ? `（${detail}）` : ""}`); }
  else { failed++; console.error(`FAIL: ${name}${detail ? `（${detail}）` : ""}`); }
};

// 1. 注入最新开发副本并确保 sidecar（dev 守卫使自更新天然跳过）
const inj = spawnSync(process.execPath, [AUTO, "--force"], { encoding: "utf8" });
assert("注入完成", inj.status === 0, (inj.stdout ?? "").trim().split("\n")[0] ?? "");

// 2. 强制重启应用，带 CDP 调试端口
const exeCandidates = [
  process.env.TURN_STATS_EXE,
  join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-code", "Kimi Code", "Kimi Code.exe"),
  "D:\\kimi-code\\Kimi Code\\Kimi Code.exe",
  join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-desktop", "kimi-desktop.exe"),
];
const exe = exeCandidates.find((p) => p && existsSync(p));
if (!exe) { console.error("未找到 Kimi Code 可执行文件（可用 TURN_STATS_EXE 环境变量指定）"); process.exit(1); }
try { spawnSync("taskkill", ["/F", "/IM", "Kimi Code.exe"], { stdio: "ignore" }); } catch {}
// 等进程真正清零：单实例锁下残留进程会把新启动变成"唤起旧实例"后直接退出
for (let i = 0; i < 15; i++) {
  const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq Kimi Code.exe", "/NH"], { encoding: "utf8" }).stdout ?? "";
  if (!out.includes("Kimi Code.exe")) break;
  await sleep(1000);
}
spawn(exe, [
  `--remote-debugging-port=${CDP_PORT}`,
  // 窗口被遮挡时 Chromium 会把页面定时器节流到 ~1 次/分钟，验证会读到陈旧状态；
  // 验证场景关掉这些节流保证确定性
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
], { detached: true, stdio: "ignore" }).unref();

// 3. 等 CDP 端口就绪（所有请求带超时，防止半开连接挂死整个验证）
const fetchT = (url, ms = 3000) => fetch(url, { signal: AbortSignal.timeout(ms) });
let cdpUp = false;
for (let i = 0; i < 40 && !cdpUp; i++) {
  try { await (await fetchT(`${CDP}/json/version`, 2000)).json(); cdpUp = true; } catch { await sleep(1000); }
}
assert("CDP 端口就绪", cdpUp);
if (!cdpUp) process.exit(1);

// 4. 找应用主窗口页面 target：注入脚本会进所有 app://renderer 页面，但只有
// 可见窗口的定时器是活的——逐个探测 visibilityState，选 visible 的那个
const isMainPage = (u) => /^app:\/\/renderer/.test(u ?? "") && !/browser-overlay|browser-control|\/pin\//.test(u ?? "");
const probeTarget = async (t) => {
  const ws2 = new WebSocket(t.webSocketDebuggerUrl);
  const opened = await new Promise((res) => { ws2.onopen = res; ws2.onerror = () => res(null); setTimeout(() => res(null), 3000); });
  if (!opened) { ws2.close(); return null; }
  let seq2 = 0; const p2 = new Map();
  ws2.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id); } };
  ws2.send(JSON.stringify({ id: ++seq2, method: "Runtime.enable", params: {} }));
  const ev2 = (expression) => new Promise((res) => {
    const id = ++seq2; p2.set(id, (m) => res(m.result?.result?.value));
    ws2.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  const info = await ev2(`JSON.stringify({vis: document.visibilityState, installed: !!window.__turnStatsInstalled, url: location.href})`);
  ws2.close();
  try { return JSON.parse(info); } catch { return null; }
};

let target = null;
for (let i = 0; i < 30 && !target; i++) {
  const list = await fetchT(`${CDP}/json/list`).then((r) => r.json()).catch(() => []);
  const mains = list.filter((t) => t.type === "page" && isMainPage(t.url));
  for (const t of mains) {
    const info = await probeTarget(t);
    if (info?.vis === "visible" && info.installed) { target = t; break; }
  }
  if (!target && mains.length) {
    // 都不可见（应用被遮挡/最小化）：退而求其次选已安装的主页面
    const withScript = [];
    for (const t of mains) {
      const info = await probeTarget(t);
      if (info?.installed) withScript.push({ t, url: info.url });
    }
    if (withScript.length) target = withScript[0].t;
  }
  if (!target) await sleep(1000);
}
assert("找到应用页面", !!target, target?.url?.slice(0, 70));
if (!target) process.exit(1);

// 5. CDP 连接
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("WS 连接失败")); });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;

// 6. 等脚本加载、悬浮条挂载（boot 后首个 tick ≤1.5s，留足冷启动余量）
const SEL = '.ProseMirror, [contenteditable=true], textarea, [aria-label*="输入"]';
let snap = null;
for (let i = 0; i < 25; i++) {
  snap = await evalJs(`(() => {
    const chip = document.getElementById("turn-stats-chip");
    const st = window.__turnStatsState ?? {};
    const composer = document.querySelector(${JSON.stringify(SEL)});
    const cr = composer ? composer.getBoundingClientRect() : null;
    const chipR = chip ? chip.getBoundingClientRect() : null;
    const cs = chip ? getComputedStyle(chip) : null;
    const tagV = /v=([^&"]+)/.exec([...document.querySelectorAll('script[src*="turn-stats.js"]')].pop()?.src ?? "")?.[1] ?? null;
    const cands = [...document.querySelectorAll(${JSON.stringify(SEL)})].map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName, cls: String(el.className).slice(0, 40), t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return JSON.stringify({
      installed: !!window.__turnStatsInstalled,
      tagVersion: tagV,
      hasStyle: !!document.getElementById("turn-stats-style"),
      hasChip: !!chip,
      polled: st.polled ?? 0,
      styleTop: chip?.style.top ?? "", styleLeft: chip?.style.left ?? "", styleRight: chip?.style.right ?? "",
      chipRect: chipR ? { t: Math.round(chipR.top), b: Math.round(chipR.bottom), l: Math.round(chipR.left), w: Math.round(chipR.width), h: Math.round(chipR.height) } : null,
      composerRect: cr ? { t: Math.round(cr.top), l: Math.round(cr.left), w: Math.round(cr.width), h: Math.round(cr.height) } : null,
      cands,
      innerH: innerHeight, innerW: innerWidth, dpr: devicePixelRatio,
      bg: cs ? cs.backgroundColor : "",
      sidecar: st.sidecar ?? "", lastError: st.lastError ?? "", offline: !!st.offline,
    });
  })()`).then((s) => JSON.parse(s)).catch(() => null);
  // 等到悬浮条"落位"再断言：底边须位于输入框顶上方 60px 内（boot 初期布局
  // 未稳定时 composer 还在页面中部，此刻的定位是过期的）
  const settled = snap?.hasChip && snap?.tagVersion === VERSION && !snap?.offline
    && snap?.composerTop != null && (snap.composerTop - snap.chipRect.b) >= 0
    && (snap.composerTop - snap.chipRect.b) <= 60;
  if (settled) break;
  await sleep(1000);
}
if (snap) {
  console.log(`诊断: viewport=${snap.innerW}x${snap.innerH} dpr=${snap.dpr} polled=${snap.polled}`);
  console.log(`  chip style: top=${snap.styleTop} left=${snap.styleLeft} right=${snap.styleRight}`);
  console.log(`  chip=${JSON.stringify(snap.chipRect)} composer=${JSON.stringify(snap.composerRect)}`);
  console.log(`  候选=${JSON.stringify(snap.cands)}`);
}

// 7. 断言
const cRect = snap?.composerRect, chipR2 = snap?.chipRect;
assert("runtime 已加载", snap?.installed === true);
assert("脚本版本为最新注入版", snap?.tagVersion === VERSION, `页面=${snap?.tagVersion ?? "?"} 期望=${VERSION}`);
assert("样式已注入", snap?.hasStyle === true);
assert("悬浮条已挂载", snap?.hasChip === true, snap ? `w=${chipR2?.w}` : "");
assert("数据链路正常", !!snap?.sidecar && !snap?.offline && !snap?.lastError, `sidecar=${snap?.sidecar ?? "?"} lastError=${snap?.lastError || "无"}`);
assert("配色已生效（非透明背景）", /rgba?\(/.test(snap?.bg ?? "") && !/rgba\([^)]*,\s*0\)/.test(snap?.bg ?? ""), snap?.bg || "无");
assert("悬浮条在视口内", !!chipR2 && chipR2.t >= 0 && chipR2.l >= 0);
assert("找到输入框元素", !!cRect, cRect ? `t=${cRect.t} w=${cRect.w}` : "无候选");
if (cRect && chipR2) {
  assert("两侧对齐（左右缘对齐输入框）", Math.abs(chipR2.l - cRect.l) <= 30 && Math.abs((chipR2.l + chipR2.w) - (cRect.l + cRect.w)) <= 30,
    `chip l=${chipR2.l} w=${chipR2.w} vs 输入框 l=${cRect.l} w=${cRect.w}`);
  assert("紧贴输入框上边缘且不遮挡", chipR2.b <= cRect.t + 2 && cRect.t - chipR2.b <= 60,
    `chip 底=${chipR2.b} 输入框顶=${cRect.t} 间距=${cRect.t - chipR2.b}`);
}

ws.close();
console.log(failed === 0 ? `--- 真机验证 ${passed} 项全部通过 ---` : `--- 真机验证：${failed} 项失败，${passed} 项通过 ---`);
process.exit(failed === 0 ? 0 : 1);

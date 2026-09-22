/**
 * turn-stats 插件 —— 自动补丁 + 会话注入 + 自更新
 *
 * 由插件 hook（SessionStart）调用。hook 模式静默：检查/修复 desktop-dist 注入，
 * 任何错误静默退出（exit 0），绝不阻塞会话启动；最后做限频 24h 的自更新检查。
 *
 * 手动模式：
 *   node auto-patch.mjs --status        只读诊断（注入版本 / sidecar 与 config 一致性 / 自更新状态），绝不修改
 *   node auto-patch.mjs --force         强制重新注入
 *   node auto-patch.mjs --check-update  立即检查并应用自更新
 *   node auto-patch.mjs --uninstall     还原 desktop-dist
 *   其余参数：--dist <desktop-dist目录>  --no-update
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as su from "./self-update.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(HERE);
const REPO = "zaibuchihuoji/turn-stats";
const SCRIPT_NAME = "turn-stats.js";
const BACKUP_NAME = "index.html.turn-stats.bak";
const startedAt = Date.now();

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const quiet = !has("--status") && !has("--uninstall") && !has("--force") && !has("--check-update") && !args.includes("--verbose");
const say = (m) => { if (!quiet) console.log(m); };

// --- 版本单一来源：kimi.plugin.json ------------------------------------------
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, "kimi.plugin.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// --- 定位 ------------------------------------------------------------------------
function findDistDir() {
  const forced = opt("--dist") || process.env.TURN_STATS_DIST;
  if (forced) {
    const p = resolve(forced);
    return existsSync(join(p, "index.html")) ? p : null;
  }
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-code", "Kimi Code", "resources", "desktop-dist"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-desktop", "resources", "desktop-dist"),
    "D:\\kimi-code\\Kimi Code\\resources\\desktop-dist",
  ];
  for (const c of candidates) if (c && existsSync(join(c, "index.html"))) return resolve(c);
  return null;
}

// --- 原子写 ------------------------------------------------------------------------
function writeAtomic(fp, data) {
  const tmp = `${fp}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, fp);
  } catch {
    try { unlinkSync(tmp); } catch {}
    writeFileSync(fp, data, "utf8");
  }
}

// --- 补丁 / 还原 --------------------------------------------------------------------
// 备份内容 = 当前 index.html 去掉本插件注入行，每次打补丁跟随刷新（应用更新、
// 其他插件增删后仍是干净基线），卸载不会恢复出过期页面或 ghost 标签。
// script 标签带 ?v=版本号：app:// 协议对同 URL 资源有缓存，换内容不换 URL 会
// 读到旧脚本；版本号变化 → URL 变化 → 强制绕过缓存。
function scriptTag() {
  return `    <script src="/assets/${SCRIPT_NAME}?v=${VERSION}"></script>\n`;
}

function statOf(fp) {
  try { const s = statSync(fp); return `${s.size}:${s.mtimeMs}`; } catch { return "missing"; }
}

// index.html 是三个插件的公共注入点（usage-union / auto-memory 同款机制），
// 且 app:// 协议对每个请求实时读盘。这里用「读前后 stat 校验 + 原子写 +
// 写后复验 + 有限重试」的乐观并发：撞上其他插件/应用自身的并发写时重读
// 重算，收敛于包含所有人标签的最新内容；原子写保证渲染进程永远读不到半截文件。
function patchHtml(indexPath) {
  const backupPath = join(dirname(indexPath), BACKUP_NAME);
  for (let attempt = 0; attempt < 5; attempt++) {
    const s1 = statOf(indexPath);
    const html = readFileSync(indexPath, "utf8");
    if (statOf(indexPath) !== s1) continue;   // 读期间文件在变，重读
    const clean = html
      .split("\n")
      .filter((l) => !l.includes(SCRIPT_NAME))
      .join("\n");
    if (!clean.includes("</body>")) throw new Error("index.html 结构异常");
    let cur = null;
    try { cur = readFileSync(backupPath, "utf8"); } catch {}
    if (cur !== clean) writeAtomic(backupPath, clean);
    writeAtomic(indexPath, clean.replace("</body>", `${scriptTag()}</body>`));
    // 写后复验：若被并发写覆盖丢了我们的标签，下一轮重试会基于最新内容补回
    if (readFileSync(indexPath, "utf8").includes(SCRIPT_NAME)) return;
  }
  throw new Error("index.html 并发写入冲突，重试耗尽（下次会话自动重试）");
}

function uninstallDist(dist) {
  const indexPath = join(dist, "index.html");
  const backupPath = join(dist, BACKUP_NAME);
  if (existsSync(backupPath)) {
    writeAtomic(indexPath, readFileSync(backupPath, "utf8"));
    rmSync(backupPath, { force: true });
  } else if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, "utf8");
    writeAtomic(indexPath, html.split("\n").filter((l) => !l.includes(SCRIPT_NAME)).join("\n"));
  }
  rmSync(join(dist, "assets", SCRIPT_NAME), { force: true });
  rmSync(join(dist, "assets", CONFIG_NAME), { force: true });   // 残留的 port+token 凭据文件一并清理
}

// --- 注入 ------------------------------------------------------------------------
function injectUI(dist) {
  const indexPath = join(dist, "index.html");
  const runtimePath = join(dist, "assets", SCRIPT_NAME);
  mkdirSync(join(dist, "assets"), { recursive: true });
  const template = readFileSync(join(HERE, "..", "assets", "turn-stats.js"), "utf8");
  const html = readFileSync(indexPath, "utf8");
  const patched = html.includes(SCRIPT_NAME);
  const stale = !existsSync(runtimePath) || !readFileSync(runtimePath, "utf8").includes(`turn-stats@${VERSION}`);
  if (patched && !stale && !has("--force")) return false;
  writeFileSync(runtimePath, `/* turn-stats@${VERSION} */\n` + template, "utf8");
  // 始终重写标签：升级时 ?v= 随之变化，绕过 app:// 的脚本缓存
  patchHtml(indexPath);
  return true;
}

// --- sidecar ------------------------------------------------------------------------
const CONFIG_NAME = "turn-stats.config.json";

/** 进程存活检查；EPERM 视为活着（别人的进程无权发信号）。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

async function ping(port) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(400) })).json();
    return j?.service === "turn-stats" ? j : null;
  } catch { return null; }
}

async function ensureSidecar(dist) {
  // 只复用 config 指向的健康实例。config 缺失 / 指向死端口 / 版本不一致时，
  // 一律拉起新实例：它绑定下一空闲端口并重写 config（自愈渲染端拿不到服务的
  // 死局），旧实例按 config 里的 pid 看门狗让位退出。
  // （旧逻辑"任一同版本实例即复用"在 config 陈旧时会留下健康实例 + 坏 config
  //   的死局：渲染端连不上，实例自己 30s 后自杀，统计静默失效到下次会话。）
  const ports = [];
  for (let p = 39501; p < 39511; p++) ports.push(p);
  const hits = await Promise.all(ports.map(ping));
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(join(dist, "assets", CONFIG_NAME), "utf8")); } catch {}
  if (cfg && Number.isInteger(cfg.port)) {
    const i = ports.indexOf(cfg.port);
    if (i >= 0 && hits[i]?.version === VERSION) return { running: true, port: cfg.port, spawned: false };
  }
  if (has("--no-spawn")) return { running: false, spawned: false };
  const assetsDir = join(dist, "assets");
  const child = spawn(process.execPath, [join(PLUGIN_ROOT, "scripts", "sidecar.mjs")], {
    detached: true,
    stdio: "ignore",
    cwd: homedir(),   // 别让子进程把 CWD 带进插件目录，否则引擎安装/升级 rename 该目录会 EBUSY
    env: { ...process.env, TURN_STATS_ASSETS: assetsDir },
    windowsHide: true,
  });
  child.unref();
  // 等 sidecar 绑定端口并写好 config
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const c = JSON.parse(readFileSync(join(assetsDir, CONFIG_NAME), "utf8"));
      if (c.port && await ping(c.port)) return { running: true, port: c.port, spawned: true };
    } catch {}
  }
  return { running: false, spawned: true };
}

async function shutdownSidecar(dist) {
  try {
    const c = JSON.parse(readFileSync(join(dist, "assets", CONFIG_NAME), "utf8"));
    if (c.port && c.token) {
      await fetch(`http://127.0.0.1:${c.port}/shutdown`, {
        method: "POST", headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(800),
      }).catch(() => {});
    }
  } catch {}
}

// --- 只读诊断（--status）--------------------------------------------------------------
function injectedVersion(html) {
  const m = new RegExp(`<script src="/assets/${SCRIPT_NAME}\\?v=([^"]+)">`).exec(html);
  return m ? m[1] : null;
}

async function statusReport(dist) {
  const indexPath = join(dist, "index.html");
  let html = "";
  try { html = readFileSync(indexPath, "utf8"); } catch {}
  const v = injectedVersion(html);
  const runtimePath = join(dist, "assets", SCRIPT_NAME);
  let rtV = null;
  try { rtV = /^\/\* turn-stats@([^\s*]+) \*\//.exec(readFileSync(runtimePath, "utf8"))?.[1] ?? null; } catch {}
  say("turn-stats 状态（只读诊断）");
  say(`  desktop-dist: ${dist}`);
  say(`  注入: ${v ? `@${v}` : "未注入"}${rtV ? `（runtime @${rtV}）` : existsSync(runtimePath) ? "（runtime 版本头异常）" : "（无 runtime 文件）"}`);
  if (v && v !== VERSION) say(`  !! 注入版本 ${v} ≠ 插件版本 ${VERSION}：重开会话自动修复，或 --force 立即修复`);
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(join(dist, "assets", CONFIG_NAME), "utf8")); } catch {}
  if (!cfg) {
    say("  config: 缺失（渲染脚本找不到服务；重开会话或 --force 拉起）");
  } else {
    const alive = cfg.port ? await ping(cfg.port) : null;
    say(`  config: :${cfg.port} @${cfg.version ?? "?"} · pid ${cfg.pid}${pidAlive(cfg.pid) ? "" : "（进程已死）"}`);
    if (alive) {
      say(`  sidecar: 运行中 v${alive.version}${alive.version !== VERSION ? `（版本低于插件 ${VERSION}，重开会话自动升级）` : ""}`);
    } else {
      say("  sidecar: config 指向的端口无响应 —— 重开会话或 --force 拉起");
    }
  }
  const st = su.updateState(PLUGIN_ROOT);
  if (st?.failedAt) say(`  自更新: 上次检查失败（${st.lastError ?? "未知"}），退避后自动重试`);
  else if (st?.checkedAt) say(`  自更新: 上次检查 ${new Date(st.checkedAt).toLocaleString()} · 记录版本 ${st.version}`);
  else say("  自更新: 尚无检查记录");
}

// --- 主流程 -----------------------------------------------------------------------
async function main() {
  if (has("--uninstall")) {
    const dist = findDistDir();
    if (!dist) { console.error("未找到 desktop-dist"); process.exit(1); }
    await shutdownSidecar(dist);
    uninstallDist(dist);
    console.log(`✓ 已还原 ${dist}，统计服务已停止`);
    return;
  }

  const dist = findDistDir();
  if (!dist) { say("turn-stats: desktop-dist 未找到，跳过"); return; }

  if (has("--status")) {
    await statusReport(dist);   // 只读：检查/报告，绝不修改注入与服务
    return;
  }

  let injected = false;
  try { injected = injectUI(dist); } catch (e) { say(`turn-stats: 注入失败 ${e?.message ?? e}`); }
  say(`turn-stats: ${injected ? `已注入 @${VERSION} → ${dist}（重启应用生效）` : `已是最新 (@${VERSION})`}`);

  // sidecar：统计脚本的数据源（读事件日志、聚合每回合用量）
  const side = await ensureSidecar(dist);
  say(`turn-stats: 统计服务 ${side.running ? `运行中 :${side.port}` : side.spawned ? "拉起失败" : "未运行"}`);

  // 自更新：放最后，失败静默、限时预算（self-update.mjs）。
  // 本次拉起过 sidecar 时跳过（hook 总时长有限，优先保证首次启动轻快）。
  // hook 模式（quiet）传 deadline：留 3s 余量给 15s 的 hook 超时，
  // self-update 会在预算耗尽前放弃交换，绝不被杀在目录交换中间态。
  if (!has("--no-update") && !process.env.TURN_STATS_NO_UPDATE && !side.spawned && Date.now() - startedAt < 9000) {
    try {
      const r = await su.selfUpdate({
        repo: REPO, pluginRoot: PLUGIN_ROOT, currentVersion: VERSION,
        log: say, force: has("--check-update"),
        deadline: quiet ? startedAt + 12_000 : undefined,
      });
      if (r?.applied) say(`turn-stats: 已自动更新到 v${r.version}，下次会话生效`);
      else if (r?.reason && (has("--check-update") || has("--status"))) say(`turn-stats: 更新检查：${r.latest ?? r.reason}`);
    } catch {}
  }
}

main().catch((e) => { if (!quiet) { console.error("turn-stats 失败:", e?.message ?? e); process.exit(1); } });

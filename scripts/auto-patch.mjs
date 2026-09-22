/**
 * turn-stats 插件 —— 自动补丁 + 会话注入 + 自更新
 *
 * 由插件 hook（SessionStart）调用。hook 模式静默：检查/修复 desktop-dist 注入，
 * 任何错误静默退出（exit 0），绝不阻塞会话启动；最后做限频 24h 的自更新检查。
 *
 * 手动模式：
 *   node auto-patch.mjs --status        查看注入状态
 *   node auto-patch.mjs --force         强制重新注入
 *   node auto-patch.mjs --check-update  立即检查并应用自更新
 *   node auto-patch.mjs --uninstall     还原 desktop-dist
 *   其余参数：--dist <desktop-dist目录>  --no-update
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, unlinkSync } from "node:fs";
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

function patchHtml(indexPath) {
  const html = readFileSync(indexPath, "utf8");
  const backupPath = join(dirname(indexPath), BACKUP_NAME);
  const clean = html
    .split("\n")
    .filter((l) => !l.includes(SCRIPT_NAME))
    .join("\n");
  if (!clean.includes("</body>")) throw new Error("index.html 结构异常");
  let cur = null;
  try { cur = readFileSync(backupPath, "utf8"); } catch {}
  if (cur !== clean) writeAtomic(backupPath, clean);
  writeFileSync(indexPath, clean.replace("</body>", `${scriptTag()}</body>`), "utf8");
}

function uninstallDist(dist) {
  const indexPath = join(dist, "index.html");
  const backupPath = join(dist, BACKUP_NAME);
  if (existsSync(backupPath)) {
    writeAtomic(indexPath, readFileSync(backupPath, "utf8"));
    rmSync(backupPath, { force: true });
  } else if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, "utf8");
    writeFileSync(indexPath, html.split("\n").filter((l) => !l.includes(SCRIPT_NAME)).join("\n"), "utf8");
  }
  rmSync(join(dist, "assets", SCRIPT_NAME), { force: true });
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

async function ping(port) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(400) })).json();
    return j?.service === "turn-stats" ? j : null;
  } catch { return null; }
}

async function ensureSidecar(dist) {
  // 并行探测端口段：同版本已在跑直接复用；版本不一致继续拉起，旧实例自愈退出
  const ports = [];
  for (let p = 39501; p < 39511; p++) ports.push(p);
  const hits = await Promise.all(ports.map(ping));
  for (let i = 0; i < ports.length; i++) {
    if (hits[i]?.version === VERSION) return { running: true, port: ports[i], spawned: false };
  }
  if (has("--no-spawn")) return { running: false, spawned: false };
  const assetsDir = join(dist, "assets");
  const child = spawn(process.execPath, [join(PLUGIN_ROOT, "scripts", "sidecar.mjs")], {
    detached: true,
    stdio: "ignore",
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

  let injected = false;
  try { injected = injectUI(dist); } catch (e) { say(`turn-stats: 注入失败 ${e?.message ?? e}`); }
  say(`turn-stats: ${injected ? `已注入 @${VERSION} → ${dist}（重启应用生效）` : `已是最新 (@${VERSION})`}`);

  // sidecar：统计脚本的数据源（读事件日志、聚合每回合用量）
  const side = await ensureSidecar(dist);
  say(`turn-stats: 统计服务 ${side.running ? `运行中 :${side.port}` : side.spawned ? "拉起失败" : "未运行"}`);

  // 自更新：放最后，失败静默、限时预算（self-update.mjs）
  if (!has("--no-update") && !process.env.TURN_STATS_NO_UPDATE && Date.now() - startedAt < 9000) {
    try {
      const r = await su.selfUpdate({
        repo: REPO, pluginRoot: PLUGIN_ROOT, currentVersion: VERSION,
        log: say, force: has("--check-update"),
      });
      if (r?.applied) say(`turn-stats: 已自动更新到 v${r.version}，下次会话生效`);
      else if (r?.reason && (has("--check-update") || has("--status"))) say(`turn-stats: 更新检查：${r.latest ?? r.reason}`);
    } catch {}
  }
}

main().catch((e) => { if (!quiet) { console.error("turn-stats 失败:", e?.message ?? e); process.exit(1); } });

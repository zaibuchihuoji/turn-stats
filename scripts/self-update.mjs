/**
 * self-update —— 插件自更新（codeload 直连通道；两插件共用同一实现，各自持有一份）
 *
 * 设计原则：
 *  - 只依赖 codeload.github.com（国内直连可达，与引擎安装插件是同一通道）；
 *    github.com / api.github.com 直连常不可达，不进入依赖路径
 *  - 每 24h 最多联网检查一次（.update-state.json 缓存），其余会话零开销
 *  - 开发副本（目录含 .git）永不自更新，避免覆盖本地改动
 *  - 任何错误静默返回，绝不阻塞会话启动；更新在下一会话生效
 *    （本会话代码已加载，替换文件只影响之后启动的 hook 与注入）
 *
 * 手动触发：node auto-patch.mjs --check-update（无视缓存立即检查并应用）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import zlib from "node:zlib";

const CHECK_INTERVAL = 24 * 3600_000;
const DOWNLOAD_TIMEOUT = 8000;

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function versionOf(v) {
  return String(v ?? "").split(".").map((n) => parseInt(n, 10) || 0);
}

/** 语义化三段版本比较：a > b 时返回 true */
export function isNewer(a, b) {
  const pa = versionOf(a), pb = versionOf(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** 最小 zip 解包：codeload 的 zip 是「顶层单目录 + deflate 条目」，无需第三方依赖 */
export function extractZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: EOCD 未找到");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error("zip: central directory 损坏");
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString("utf8");
    // local header 的 name/extra 长度可能与 central 不同，数据偏移以 local 为准
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnLen + leLen;
    const data = buf.slice(dataStart, dataStart + compressedSize);
    if (!name.endsWith("/")) {
      files.set(name, method === 0 ? data : zlib.inflateRawSync(data));
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function fetchBranchZip(repo, ref, log) {
  const res = await fetch(`https://codeload.github.com/${repo}/zip/refs/heads/${ref}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  log(`已下载 ${repo}@${ref}（${Math.round(res.headers.get("content-length") ?? 0 / 1024)}）`);
  return Buffer.from(await res.arrayBuffer());
}

async function applyUpdate({ repo, pluginRoot, currentVersion, log }) {
  let zip = null;
  for (const ref of ["main", "master"]) {
    try { zip = await fetchBranchZip(repo, ref, log); break; } catch (e) { log(`下载 ${ref} 分支失败：${e?.message ?? e}`); }
  }
  if (!zip) throw new Error("codeload 不可达");
  const files = extractZip(zip);
  const top = files.keys().next().value?.split("/")[0];
  const manifestRaw = top && files.get(`${top}/kimi.plugin.json`);
  if (!manifestRaw) throw new Error("zip 内无 kimi.plugin.json");
  const newVersion = JSON.parse(manifestRaw.toString("utf8")).version;
  if (!isNewer(newVersion, currentVersion)) return { applied: false, latest: newVersion, reason: "已是最新" };

  // 解包到暂存目录（跳过仓库里的状态文件；.git 本就不会出现在 codeload zip 里）
  const tmpDir = join(pluginRoot, ".update-new");
  const oldDir = join(pluginRoot, ".update-old");
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(oldDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  for (const [path, data] of files) {
    const rel = path.slice(top.length + 1);
    if (!rel || rel === ".update-state.json") continue;
    const fp = join(tmpDir, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, data);
  }

  // 交换：当前文件 → .update-old，暂存文件 → 插件根；中途失败完整回滚
  mkdirSync(oldDir, { recursive: true });
  const keep = new Set([".update-new", ".update-old", ".update-state.json", ".git"]);
  const movedIn = [];
  try {
    for (const name of readdirSync(pluginRoot)) {
      if (keep.has(name)) continue;
      renameSync(join(pluginRoot, name), join(oldDir, name));
    }
    for (const name of readdirSync(tmpDir)) {
      renameSync(join(tmpDir, name), join(pluginRoot, name));
      movedIn.push(name);
    }
  } catch (err) {
    for (const name of movedIn) {
      try { renameSync(join(pluginRoot, name), join(tmpDir, name)); } catch {}
    }
    for (const name of readdirSync(oldDir)) {
      renameSync(join(oldDir, name), join(pluginRoot, name));
    }
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(oldDir, { recursive: true, force: true });
    throw err;
  }
  rmSync(oldDir, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
  return { applied: true, version: newVersion };
}

/**
 * 检查并应用自更新。
 * 返回 { applied, version? } | { applied: false, latest?, reason? } | { skipped, ... }
 * 调用方（hook）自行兜底 try/catch 与时间预算。
 */
export async function selfUpdate({ repo, pluginRoot, currentVersion, log = () => {}, force = false }) {
  const statePath = join(pluginRoot, ".update-state.json");
  // 开发副本守卫不受 force 影响：force 只表示"无视 24h 缓存"，任何情况下都
  // 不能覆盖开发者的本地改动
  if (existsSync(join(pluginRoot, ".git"))) {
    return { skipped: "dev", reason: "开发副本（含 .git）不自动更新" };
  }
  const state = readJson(statePath) ?? {};
  const now = Date.now();
  if (!force && state.checkedAt && now - state.checkedAt < CHECK_INTERVAL && state.version === currentVersion) {
    return { skipped: "cache", latest: state.version };
  }
  let result;
  try {
    result = await applyUpdate({ repo, pluginRoot, currentVersion, log });
  } catch (err) {
    try { writeFileSync(statePath, JSON.stringify({ version: currentVersion, checkedAt: now, lastError: String(err?.message ?? err) }) + "\n"); } catch {}
    return { applied: false, reason: String(err?.message ?? err) };
  }
  try {
    writeFileSync(statePath, JSON.stringify({ version: result.version ?? currentVersion, checkedAt: now }) + "\n");
  } catch {}
  return result;
}

/** 读取更新状态（供注入配置 / sidecar /state 展示"已更新待生效"） */
export function updateState(pluginRoot) {
  return readJson(join(pluginRoot, ".update-state.json"));
}

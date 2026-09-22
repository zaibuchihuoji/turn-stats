/**
 * turn-stats sidecar
 *
 * 渲染进程没有 fs 权限，而每回合的 token 用量在本地 server 落盘的事件日志里
 * （~/.kimi-code/server/events/session_<id>.jsonl，事件：turn.started /
 * turn.step.completed / turn.ended）。本服务由 SessionStart hook 拉起：
 *   - 监听事件目录（2s 轮询增量），聚合出每个回合的 token 消耗与时长
 *   - 通过 HTTP 把已完成回合喂给注入的统计脚本
 * 仅绑定 127.0.0.1，Bearer token 写入 desktop-dist/assets/turn-stats.config.json。
 * 自愈：config 被新实例改写（指向别的端口）→ 让位退出；config 连续缺失 → 退出。
 *
 * 端点：
 *   GET /ping     → {ok, service, version, port}
 *   GET /state    → {ok, turns:[...], version}
 *   POST /shutdown
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, mkdirSync, renameSync, unlinkSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, "kimi.plugin.json"), "utf8")).version ?? "0.0.0";
  } catch { return "0.0.0"; }
})();
const ASSETS_DIR = process.env.TURN_STATS_ASSETS ?? null;
const CONFIG_NAME = "turn-stats.config.json";
const PORT_RANGE = [39501, 39511];
const EVENTS_DIR = join(
  process.env.KIMI_CODE_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".kimi-code"),
  "server", "events",
);
const MAX_TURNS = 40;

let TOKEN = randomBytes(16).toString("hex");
let PORT = 0;
let lastWorkspace = null;

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

function writeClientConfig() {
  if (!ASSETS_DIR) return;
  try {
    mkdirSync(ASSETS_DIR, { recursive: true });
    writeAtomic(join(ASSETS_DIR, CONFIG_NAME), JSON.stringify({
      version: VERSION, port: PORT, token: TOKEN, pid: process.pid,
    }, null, 2) + "\n");
  } catch {}
}

// --- 事件日志聚合 -------------------------------------------------------------
// 回合粒度 = 主 agent（agentId "main"）的 turnId；Task 子代理（agent-N）的
// turnId 独立编号且与 main 冲突，其消耗按发生时间归入当时进行中的主回合。
const turns = new Map();         // `${sessionId}|main|${turnId}` -> main turn
const subBuckets = new Map();    // `${sessionId}|${agentId}|${turnId}` -> 子代理独立桶（不外发）
const currentMain = new Map();   // sessionId -> 进行中的主回合 key
const pendingSubs = new Map();   // sessionId -> [{usage, decodeMs}] 主回合未观察到 started 时的子代理步
const fileOffsets = new Map();   // 文件路径 -> 已消费到的字节（按完整行推进）
let filesScanned = 0;

function getBucket(map, key, time) {
  if (!map.has(key)) {
    map.set(key, {
      sessionId: "", agentId: "", turnId: 0,
      startT: Number(time) || Date.now(),
      endT: 0, durationMs: 0, reason: "",
      in: 0, out: 0, cacheRead: 0, cacheCreation: 0,
      decodeMs: 0, firstTokenMs: 0,
      done: false,
    });
    prune(map);
  }
  return map.get(key);
}

function prune(map) {
  const done = [...map.entries()].filter(([, t]) => t.done);
  if (done.length > MAX_TURNS * 2) {
    done.sort((a, b) => a[1].endT - b[1].endT);
    for (let i = 0; i < done.length - MAX_TURNS * 2; i++) map.delete(done[i][0]);
  }
}

function addUsage(t, u) {
  t.in += Number(u.inputOther ?? 0) + Number(u.inputCacheRead ?? 0) + Number(u.inputCacheCreation ?? 0);
  t.out += Number(u.output ?? 0);
  t.cacheRead += Number(u.inputCacheRead ?? 0);
  t.cacheCreation += Number(u.inputCacheCreation ?? 0);
}

function processLine(line) {
  if (!line.includes("turn.")) return;
  let j;
  try { j = JSON.parse(line); } catch { return; }
  const env = j.envelope ?? j;
  const type = env.type ?? "";
  const p = env.payload ?? {};
  const sessionId = env.session_id ?? "";
  const agentId = p.agentId ?? "main";
  const turnId = p.turnId;
  if (!sessionId || turnId === undefined) return;

  const isMain = agentId === "main";
  const key = `${sessionId}|${agentId}|${turnId}`;
  const map = isMain ? turns : subBuckets;
  const t = getBucket(map, key, p.time);
  t.sessionId = sessionId; t.agentId = agentId; t.turnId = turnId;

  if (type === "turn.started") {
    t.startT = Number(p.time) || t.startT;
    if (isMain) {
      // 新主回合开始：清掉上一回合结束后仍未归属的散落子代理步（无法归属即丢弃）
      pendingSubs.delete(sessionId);
      currentMain.set(sessionId, key);
    }
    return;
  }
  if (type === "turn.step.completed") {
    addUsage(t, p.usage ?? {});
    const decode = Number(p.llmServerDecodeMs ?? 0);
    t.decodeMs += decode;
    if (!t.firstTokenMs) t.firstTokenMs = Number(p.llmServerFirstTokenMs ?? 0);
    // 子代理的消耗归入当时进行中的主回合；sidecar 启动晚、错过主回合 started
    // 时先暂存，待主回合 ended 时按时间窗归入
    if (!isMain) {
      const mk = currentMain.get(sessionId);
      if (mk) {
        addUsage(turns.get(mk), p.usage ?? {});
        turns.get(mk).decodeMs += decode;
      } else {
        if (!pendingSubs.has(sessionId)) pendingSubs.set(sessionId, []);
        pendingSubs.get(sessionId).push({ usage: p.usage ?? {}, decodeMs: decode });
      }
    }
    return;
  }
  if (type === "turn.ended") {
    t.endT = Number(p.time) || Date.now();
    t.durationMs = Number(p.durationMs ?? 0) || Math.max(0, t.endT - t.startT);
    t.reason = p.reason ?? "completed";
    if (isMain) {
      // 归入暂存的子代理步（sidecar 中途启动 / 冷启动窗口截断的场景）
      for (const s of pendingSubs.get(sessionId) ?? []) {
        addUsage(t, s.usage);
        t.decodeMs += s.decodeMs;
      }
      pendingSubs.delete(sessionId);
      if (currentMain.get(sessionId) === key) currentMain.delete(sessionId);
    }
    t.done = true;
  }
}

function scanEvents() {
  let names = [];
  try { names = readdirSync(EVENTS_DIR).filter((f) => f.endsWith(".jsonl")); } catch { return; }
  filesScanned = names.length;
  for (const name of names) {
    const fp = join(EVENTS_DIR, name);
    let size = 0;
    try { size = statSync(fp).size; } catch { continue; }
    const off = fileOffsets.get(fp) ?? 0;
    if (size <= off) {
      // 文件被截断/重写：offset 失效，从头读
      if (size < off) fileOffsets.set(fp, 0);
      continue;
    }
    // 首次见到该文件：只读末尾 256KB（历史回合太多，回满会撑爆内存）
    const from = off === 0 ? Math.max(0, size - 256 * 1024) : off;
    let text = "";
    try {
      const fd = openSync(fp, "r");
      const len = size - from;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, from);
      closeSync(fd);
      text = buf.toString("utf8");
    } catch { continue; }
    // 只消费完整行：最后一段可能是写了一半的行，留给下轮增量（否则事件永久丢失）
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      if (process.env.TURN_STATS_DEBUG) console.error(`[scan] ${basename(fp)}: 无完整行，等待`);
      continue;
    }
    const complete = text.slice(0, lastNewline + 1);
    fileOffsets.set(fp, from + Buffer.byteLength(complete, "utf8"));
    if (process.env.TURN_STATS_DEBUG) console.error(`[scan] ${basename(fp)}: off=${off} from=${from} 消费 ${Buffer.byteLength(complete, "utf8")}B → offset=${fileOffsets.get(fp)}`);
    for (const line of complete.split(/\r?\n/)) processLine(line);
  }
}

function statePayload() {
  scanEvents();
  const now = Date.now();
  const list = [...turns.values()].filter((t) => t.done)
    .sort((a, b) => b.endT - a.endT)
    .slice(0, MAX_TURNS);
  // 进行中的回合（面板实时统计用）
  const active = [...turns.values()].filter((t) => !t.done && now - t.startT < 24 * 3600_000)
    .sort((a, b) => b.startT - a.startT)
    .map((t) => ({
      sessionId: t.sessionId, turnId: t.turnId, startT: t.startT,
      elapsedMs: now - t.startT, in: t.in, out: t.out,
      cacheRead: t.cacheRead, cacheCreation: t.cacheCreation,
    }));
  if (process.env.TURN_STATS_DEBUG) {
    console.error(`[state] turns=${list.length} turnIds=${JSON.stringify(list.map((t) => t.turnId))} offsets=${JSON.stringify([...fileOffsets])} subdir=${JSON.stringify([...subBuckets.keys()].slice(0, 5))}`);
  }
  return {
    ok: true, version: VERSION, turns: list, active,
    filesScanned, lastWorkspace,
  };
}

// --- HTTP ------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Access-Control-Max-Age": "86400",
};
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...CORS });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 1e5) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("JSON 解析失败")); } });
    req.on("error", reject);
  });
}

let DIAG = null;   // 渲染进程上报的消息区 DOM 结构（锚点策略分析用）

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (url.pathname === "/ping") {
    return json(res, 200, { ok: true, service: "turn-stats", version: VERSION, port: PORT });
  }
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { ok: false, error: "未授权" });
  try {
    if (req.method === "GET" && url.pathname === "/state") {
      const s = statePayload();
      return json(res, 200, { ...s, diag: DIAG });
    }
    if (req.method === "POST" && url.pathname === "/diag") {
      const b = await readBody(req);
      DIAG = { at: new Date().toISOString(), ...b };
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/touch") {
      const b = await readBody(req);
      if (b?.workspace) lastWorkspace = String(b.workspace);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    json(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    json(res, 400, { ok: false, error: String(err?.message ?? err) });
  }
});

server.on("error", (e) => {
  if (e?.code === "EADDRINUSE" && tryingPort < PORT_RANGE[1]) listen(tryingPort + 1);
  else process.exit(1);
});

let tryingPort = 0;
function listen(port) {
  tryingPort = port;
  server.listen(port, "127.0.0.1", () => {
    PORT = port;
    writeClientConfig();
    let configMisses = 0;
    setInterval(() => {
      if (!ASSETS_DIR) return;
      try {
        const c = JSON.parse(readFileSync(join(ASSETS_DIR, CONFIG_NAME), "utf8"));
        configMisses = 0;
        if (c.port && c.port !== PORT) process.exit(0);
      } catch {
        if (++configMisses >= 2) process.exit(0);
      }
    }, 30_000).unref();
  });
}

// --- 启动 ------------------------------------------------------------------------
// 复用同版本旧实例：端口上有活着的服务且 config 仍指向它 → 直接退出
async function pickExisting() {
  for (let p = PORT_RANGE[0]; p < PORT_RANGE[1]; p++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${p}/ping`, { signal: AbortSignal.timeout(400) })).json();
      if (j?.ok && j?.service === "turn-stats" && j?.version === VERSION) {
        const cfgPath = ASSETS_DIR ? join(ASSETS_DIR, CONFIG_NAME) : null;
        if (cfgPath && existsSync(cfgPath)) {
          const c = JSON.parse(readFileSync(cfgPath, "utf8"));
          if (c.port === p) return true;
        }
      }
    } catch {}
  }
  return false;
}

if (await pickExisting()) {
  process.exit(0);
}
scanEvents();
listen(PORT_RANGE[0]);

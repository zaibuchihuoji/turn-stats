/**
 * turn-stats sidecar
 *
 * 渲染进程没有 fs 权限，而每回合的 token 用量在本地 server 落盘的事件日志里
 * （~/.kimi-code/server/events/session_<id>.jsonl，事件：turn.started /
 * turn.step.completed / turn.ended）。本服务由 SessionStart hook 拉起：
 *   - 在 /state 被拉取时增量扫描事件目录（渲染端 1.5s 轮询驱动；没有后台
 *     定时器），只消费完整行（半行等补全），按 epoch+seq 去重防止文件
 *     截断/重写或 epoch 轮换（seq 重新从小值开始）导致的漏计/重计
 *   - 行处理逐行隔离：单行异常只丢该行，不再中断整轮扫描
 *   - 聚合出每个回合的 token 消耗与时长，通过 HTTP 喂给注入的统计脚本
 * 仅绑定 127.0.0.1，Bearer token 写入 desktop-dist/assets/turn-stats.config.json。
 * 自愈：
 *   - 看门狗按 config 里的 pid 判断：config 被更新的实例改写（对方进程活着）
 *     → 让位退出；config 丢失或指向死进程 → 重写夺回（渲染端立刻恢复），
 *     只有连续两轮仍丢失才视为有意删除（卸载兜底）而退出
 *   - 30 分钟没有任何 /state 拉取（应用已关闭）→ 自退，不留后台进程
 *
 * 端点：
 *   GET /ping     → {ok, service, version}
 *   GET /state    → {ok, turns:[...], active:[...], filesScanned, parsed, version}
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
const MAX_TURNS = 40;               // /state 单次外发的全局回合上限（负载预算）
const MAX_TURNS_PER_SESSION = 10;   // 每会话在外发窗口里保留的回合数（切回旧会话仍有数据）
const MAX_DONE_KEEP = 240;          // 内存保留的已完成桶上限（外发窗口的 6 倍余量）
const STALE_ACTIVE_MS = 10 * 60_000;  // 事件文件这么久没有新增的未结束回合视为已死（应用崩溃/断电）
const IDLE_EXIT_MS = 30 * 60_000;     // 这么久没有 /state 拉取（应用已关闭）→ 自退

let TOKEN = randomBytes(16).toString("hex");
let PORT = 0;

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

/** 进程存活检查；EPERM 视为活着（别人的进程无权发信号）。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

// --- 事件日志聚合 -------------------------------------------------------------
// 回合粒度 = 主 agent（agentId "main"）的 turnId；Task 子代理（agent-N）的
// turnId 独立编号且与 main 冲突，其消耗按发生时间归入当时进行中的主回合。
const turns = new Map();         // `${sessionId}|main|${turnId}` -> main turn
const subBuckets = new Map();    // `${sessionId}|${agentId}|${turnId}` -> 子代理独立桶（不外发）
const currentMain = new Map();   // sessionId -> 进行中的主回合 key
const pendingSubs = new Map();   // sessionId -> [{usage, decodeMs}] 主回合未观察到 started 时的子代理步
const fileOffsets = new Map();   // 文件路径 -> 已消费到的字节（按完整行推进）
const fileSeqs = new Map();      // 文件路径 -> 当前 epoch 下已见最大 envelope.seq
const fileEpochs = new Map();    // 文件路径 -> 当前 epoch（变化 = seq 基线作废）
const fileMtimes = new Map();    // 文件路径 -> 最后修改时间（死回合判定用）
const sessionFiles = new Map();  // sessionId -> 事件文件路径（死回合判定按会话找文件，不猜命名）
const parsed = { turnEvents: 0, stepCompleted: 0, stepNoUsage: 0, ended: 0, endedNoDuration: 0 };
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
    prune(map, key);
  }
  return map.get(key);
}

// 清扫：释放死桶（应用崩溃残留、超过保鲜期等不到 ended）与过剩的已完成桶。
// keepKey：刚创建还未返回的桶不许被本次清扫删掉（冷启动回放的旧事件 startT
// 就是旧的，且后续行里可能还有它的 turn.ended）。
function prune(map, keepKey) {
  const now = Date.now();
  for (const [k, t] of map) {
    if (k === keepKey) continue;
    if (!t.done && now - t.startT > 24 * 3600_000) map.delete(k);
  }
  const done = [...map.entries()].filter(([, t]) => t.done);
  if (done.length > MAX_DONE_KEEP) {
    done.sort((a, b) => a[1].endT - b[1].endT);
    for (let i = 0; i < done.length - MAX_DONE_KEEP; i++) map.delete(done[i][0]);
  }
}

function addUsage(t, u) {
  t.in += Number(u.inputOther ?? 0) + Number(u.inputCacheRead ?? 0) + Number(u.inputCacheCreation ?? 0);
  t.out += Number(u.output ?? 0);
  t.cacheRead += Number(u.inputCacheRead ?? 0);
  t.cacheCreation += Number(u.inputCacheCreation ?? 0);
}

function processLine(fp, line) {
  if (!line.includes("turn.")) return;
  let j;
  try { j = JSON.parse(line); } catch { return; }
  const env = j.envelope ?? j;
  const type = env.type ?? "";
  if (!String(type).startsWith("turn.")) return;
  parsed.turnEvents++;
  const p = env.payload ?? {};
  const sessionId = env.session_id ?? "";
  const agentId = p.agentId ?? "main";
  const turnId = p.turnId;
  if (!sessionId || turnId === undefined) return;
  sessionFiles.set(sessionId, fp);

  // epoch 轮换：server 重启后以新 epoch 继续追加同一文件时 seq 可能重新从小值
  // 开始，旧基线必须作废，否则此后所有事件会被 seq 去重永久丢弃
  const epoch = String(j.epoch ?? env.epoch ?? "");
  if (epoch) {
    const prev = fileEpochs.get(fp);
    if (prev !== undefined && prev !== epoch) fileSeqs.delete(fp);
    fileEpochs.set(fp, epoch);
  }

  // seq 幂等：文件被截断/重写导致 offset 归零重放时，老事件直接跳过，绝不重复累加
  const seq = Number(j.seq ?? env.seq ?? 0);
  if (seq > 0) {
    const seen = fileSeqs.get(fp) ?? 0;
    if (seq <= seen) return;
    fileSeqs.set(fp, seq);
  }

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
    const usage = p.usage ?? {};
    parsed.stepCompleted++;
    if (usage.inputOther === undefined && usage.output === undefined) parsed.stepNoUsage++;
    addUsage(t, usage);
    const decode = Number(p.llmServerDecodeMs ?? 0);
    t.decodeMs += decode;
    if (!t.firstTokenMs) t.firstTokenMs = Number(p.llmServerFirstTokenMs ?? 0);
    // 子代理的消耗归入当时进行中的主回合；sidecar 启动晚、错过主回合 started
    // 时先暂存，待主回合 ended 时按时间窗归入
    if (!isMain) {
      const main = turns.get(currentMain.get(sessionId));
      if (main) {
        addUsage(main, usage);
        main.decodeMs += decode;
      } else {
        if (!pendingSubs.has(sessionId)) pendingSubs.set(sessionId, []);
        pendingSubs.get(sessionId).push({ usage, decodeMs: decode });
      }
    }
    return;
  }
  if (type === "turn.ended") {
    parsed.ended++;
    if (p.durationMs === undefined) parsed.endedNoDuration++;
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
    let size = 0, mtimeMs = 0;
    try { const st = statSync(fp); size = st.size; mtimeMs = st.mtimeMs; } catch { continue; }
    if (mtimeMs) fileMtimes.set(fp, mtimeMs);
    const off = fileOffsets.get(fp) ?? 0;
    if (size <= off) {
      // 文件被截断/重写：offset 失效，从头读（seq 去重保证重放不重复计数）
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
    // 逐行隔离：单行异常只丢该行，不再让整个 chunk 的剩余行跟着丢失
    for (const line of complete.split(/\r?\n/)) {
      if (!line) continue;
      try { processLine(fp, line); } catch (e) {
        if (process.env.TURN_STATS_DEBUG) console.error(`[scan] ${basename(fp)}: 行处理失败 ${e?.message ?? e}`);
      }
    }
  }
}

function statePayload() {
  scanEvents();
  prune(turns);          // 周期清扫死桶/过剩桶，不依赖"新回合到来"才触发
  prune(subBuckets);
  const now = Date.now();
  // 先按会话分组各取最近 N 回合再合流：高强度使用其他会话后切回来，
  // 当前会话的统计不会被全局窗口挤光
  const bySession = new Map();
  for (const t of turns.values()) {
    if (!t.done) continue;
    let arr = bySession.get(t.sessionId);
    if (!arr) bySession.set(t.sessionId, (arr = []));
    arr.push(t);
  }
  const list = [];
  for (const arr of bySession.values()) {
    arr.sort((a, b) => b.endT - a.endT);
    list.push(...arr.slice(0, MAX_TURNS_PER_SESSION));
  }
  list.sort((a, b) => b.endT - a.endT);
  if (list.length > MAX_TURNS) list.length = MAX_TURNS;
  // 进行中的回合（面板实时统计用）。事件文件超过 STALE_ACTIVE_MS 没有任何新增
  // 的回合视为已死（应用崩溃/断电残留），不再当"统计中"显示，避免悬浮条
  // 挂一个虚假增长的耗时直到 24h 保鲜期过完
  const active = [...turns.values()].filter((t) => {
    if (t.done || now - t.startT >= 24 * 3600_000) return false;
    const mt = fileMtimes.get(sessionFiles.get(t.sessionId));
    return !mt || now - mt < STALE_ACTIVE_MS;
  })
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
    filesScanned,
    parsed: { ...parsed },   // 契约漂移诊断：事件数多但 NoUsage/NoDuration 占比高 = 字段改名了
  };
}

// --- HTTP ------------------------------------------------------------------------
// CORS 只放行桌面应用的自定义协议来源；其他浏览器页面拿不到 ACAO，跨域读被拦。
function corsFor(req) {
  const origin = req.headers.origin ?? "";
  if (origin.startsWith("app://")) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "authorization,content-type",
      "Access-Control-Max-Age": "86400",
    };
  }
  return {};
}
function json(req, res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...corsFor(req) });
  res.end(JSON.stringify(obj));
}

let lastPullAt = Date.now();
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "OPTIONS") { res.writeHead(204, corsFor(req)); res.end(); return; }
  if (url.pathname === "/ping") {
    return json(req, res, 200, { ok: true, service: "turn-stats", version: VERSION });
  }
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) return json(req, res, 401, { ok: false, error: "未授权" });
  try {
    if (req.method === "GET" && url.pathname === "/state") {
      lastPullAt = Date.now();
      return json(req, res, 200, statePayload());
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      json(req, res, 200, { ok: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    json(req, res, 404, { ok: false, error: "not found" });
  } catch (err) {
    json(req, res, 400, { ok: false, error: String(err?.message ?? err) });
  }
});

server.on("error", (e) => {
  // 递增只到 PORT_RANGE[1]-1：可绑定端口范围必须与 ensureSidecar/pickExisting
  // 的探测范围一致，否则绑在探测范围外的实例永远不会被复用/发现
  if (e?.code === "EADDRINUSE" && tryingPort + 1 < PORT_RANGE[1]) listen(tryingPort + 1);
  else process.exit(1);
});

let tryingPort = 0;
function listen(port) {
  tryingPort = port;
  server.listen(port, "127.0.0.1", () => {
    PORT = port;
    writeClientConfig();
    // 空闲自退：渲染端开着窗口时每 1.5s 拉一次；应用关了就没人拉取，
    // 30 分钟后退出，不留常驻 node 进程
    setInterval(() => {
      if (Date.now() - lastPullAt > IDLE_EXIT_MS) process.exit(0);
    }, 60_000).unref();
    // config 看门狗：pid 判断让位/夺回，替代旧的"端口不一致就自杀"
    let configMisses = 0;
    setInterval(() => {
      if (!ASSETS_DIR) return;
      let c = null;
      try { c = JSON.parse(readFileSync(join(ASSETS_DIR, CONFIG_NAME), "utf8")); } catch {}
      if (!c || typeof c.port !== "number") {
        // 丢失/损坏：连续两轮仍丢（有人在有意删，如卸载 shutdown 失败的兜底）→ 让位；
        // 单次意外丢失（杀软锁文件等）→ 重写夺回，渲染端立刻恢复
        if (++configMisses >= 2) process.exit(0);
        writeClientConfig();
        return;
      }
      configMisses = 0;
      if (c.pid === process.pid && c.port === PORT) return;
      // 别的活实例改写了 config（新版本接管）→ 让位；config 指向死进程（陈旧）
      // → 重写夺回。pid 复用的误判代价只是多退一次，下个 hook 会重新拉起
      if (c.port !== PORT && pidAlive(c.pid)) process.exit(0);
      writeClientConfig();
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

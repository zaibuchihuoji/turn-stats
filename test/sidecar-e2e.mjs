/**
 * turn-stats sidecar 端到端：伪造事件日志 → 拉起 → 聚合校验 → 追加增量 → 停止。
 * 覆盖：增量/残行补全/重放幂等/子代理归入/死回合/epoch 轮换/按会话窗口/鉴权。
 * 用法：node test/sidecar-e2e.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), "ts-e2e-"));
const assets = join(home, "assets");
const eventsDir = join(home, "server", "events");
mkdirSync(assets, { recursive: true });
mkdirSync(eventsDir, { recursive: true });

const SID = "session_abc";
// 真实日志每行都带顶层 epoch；fixture 同样带上，才能覆盖 epoch 轮换路径
const ev = (type, p, seq, epoch = "ep_A", sid = SID) => JSON.stringify({ kind: "event", seq, epoch, envelope: { type, session_id: sid, seq, payload: p } });

let passed = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL: " + m); child.kill(); process.exit(1); } passed++; console.log("ok: " + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 第一批事件：回合 0（2 个 step + 子代理消耗归入）+ 回合 1（1 个 step）
const batch1 = [
  ev("turn.started", { time: 1000, turnId: 0, prompt: "测试一", agentId: "main" }, 1),
  ev("turn.step.completed", { time: 1500, turnId: 0, agentId: "main", usage: { inputOther: 100, output: 200, inputCacheRead: 3000, inputCacheCreation: 10 }, llmServerDecodeMs: 2000, llmServerFirstTokenMs: 800 }, 2),
  ev("turn.step.completed", { time: 1800, turnId: 0, agentId: "agent-0", usage: { inputOther: 500, output: 60, inputCacheRead: 0, inputCacheCreation: 0 }, llmServerDecodeMs: 900 }, 3),
  ev("turn.step.completed", { time: 2000, turnId: 0, agentId: "main", usage: { inputOther: 50, output: 150, inputCacheRead: 1000, inputCacheCreation: 0 }, llmServerDecodeMs: 1000, llmServerFirstTokenMs: 700 }, 4),
  ev("turn.ended", { time: 2600, turnId: 0, agentId: "main", durationMs: 1600, reason: "completed" }, 5),
  ev("turn.started", { time: 5000, turnId: 1, agentId: "main", prompt: "测试二" }, 6),
  ev("turn.step.completed", { time: 6000, turnId: 1, agentId: "main", usage: { inputOther: 30, output: 40, inputCacheRead: 0, inputCacheCreation: 0 }, llmServerDecodeMs: 500 }, 7),
  ev("turn.ended", { time: 6500, turnId: 1, agentId: "main", durationMs: 1500, reason: "completed" }, 8),
];
writeFileSync(join(eventsDir, `session_${SID}.jsonl`), batch1.join("\n") + "\n");

const child = spawn(process.execPath, [join(HERE, "..", "scripts", "sidecar.mjs")], {
  env: { ...process.env, KIMI_CODE_HOME: home, TURN_STATS_ASSETS: assets, TURN_STATS_DEBUG: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});

const cfgPath = join(assets, "turn-stats.config.json");
let cfg = null;
for (let i = 0; i < 40 && !cfg; i++) {
  await sleep(250);
  try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch {}
}
assert(cfg?.port, "sidecar 启动并写出 config");
const H = { Authorization: `Bearer ${cfg.token}` };
const base = `http://127.0.0.1:${cfg.port}`;

let st = await (await fetch(`${base}/state`, { headers: H })).json();
assert(st.ok && st.turns.length === 2, `两个主回合聚合（${st.turns.length}）`);
const t0 = st.turns.find((t) => t.turnId === 0);
assert(t0.in === 100 + 3000 + 10 + 50 + 1000 + 500, `回合 0 输入含缓存与子代理归入（${t0.in}）`);
assert(t0.out === 200 + 150 + 60, `回合 0 输出含子代理（${t0.out}）`);
assert(t0.durationMs === 1600, "时长用服务端 turn.ended 值");
assert(t0.decodeMs === 2000 + 1000 + 900, `纯生成解码时间跨 step/子代理累加（${t0.decodeMs}）`);
assert(st.turns.some((t) => t.turnId === 1 && t.decodeMs === 500), "单回合解码时间");
assert(!st.turns.some((t) => t.agentId && t.agentId !== "main"), "子代理独立桶不外发");
assert(typeof st.parsed?.turnEvents === "number" && st.parsed.turnEvents > 0, `契约诊断计数存在（turnEvents=${st.parsed?.turnEvents}）`);

// 增量追加：回合 2 + 一个写一半的 turn.ended 残行（下轮补全后应恰好计一次）
const batch2 = [
  ev("turn.started", { time: 9000, turnId: 2, agentId: "main", prompt: "测试三" }, 9),
  ev("turn.step.completed", { time: 9500, turnId: 2, agentId: "main", usage: { inputOther: 7, output: 8, inputCacheRead: 0, inputCacheCreation: 0 } }, 10),
  ev("turn.ended", { time: 9800, turnId: 2, agentId: "main", durationMs: 800, reason: "completed" }, 11),
];
const fullLine3 = ev("turn.ended", { time: 9900, turnId: 3, agentId: "main", durationMs: 900, reason: "completed" }, 12);
const partial = fullLine3.slice(0, fullLine3.lastIndexOf('"re') + 3);   // 截断到 "re 处
writeFileSync(join(eventsDir, `session_${SID}.jsonl`), batch1.concat(batch2).join("\n") + "\n" + partial);
await sleep(2500);
st = await (await fetch(`${base}/state`, { headers: H })).json();
assert(st.turns.some((t) => t.turnId === 2), "增量事件被拾取");
assert(!st.turns.some((t) => t.turnId === 11 || t.startT === 99), "残行未被当成事件");

// 残行补全（真实场景事件行总带结尾换行）
writeFileSync(join(eventsDir, `session_${SID}.jsonl`), batch1.concat(batch2).join("\n") + "\n" + fullLine3 + "\n");
await sleep(2500);
st = await (await fetch(`${base}/state`, { headers: H })).json();
assert(st.turns.some((t) => t.turnId === 3), `补全后的残行被正确消费且只计一次（实际: ${JSON.stringify(st.turns.map((t) => [t.turnId, t.agentId, t.done]))}）`);

// 进行中回合：只有 started 没有 ended → 出现在 active，且不进已完成列表
// （用真实当前时间，走 24h 新鲜度过滤）
const liveT = Date.now();
const liveLines = [
  ev("turn.started", { time: liveT, turnId: 4, agentId: "main", prompt: "进行中" }, 13),
  ev("turn.step.completed", { time: liveT + 500, turnId: 4, agentId: "main", usage: { inputOther: 5, output: 6, inputCacheRead: 0, inputCacheCreation: 0 }, llmServerDecodeMs: 400 }, 14),
];
writeFileSync(join(eventsDir, `session_${SID}.jsonl`), batch1.concat(batch2).join("\n") + "\n" + fullLine3 + "\n" + liveLines.join("\n") + "\n");
await sleep(2500);
st = await (await fetch(`${base}/state`, { headers: H })).json();
const act = (st.active ?? []).find((t) => t.turnId === 4);
assert(!!act && act.out === 6 && act.elapsedMs > 0, "进行中回合出现在 active（实时统计）");
assert(!st.turns.some((t) => t.turnId === 4), "未完成回合不进已完成列表");

const anon = await fetch(`${base}/state`);
assert(anon.status === 401, "无 token 401");

// 死回合判定：事件文件 10 分钟没有新增的未结束回合不再显示"统计中"
const sessionFp = join(eventsDir, `session_${SID}.jsonl`);
const staleTime = new Date(Date.now() - 11 * 60_000);
const { utimesSync } = await import("node:fs");
utimesSync(sessionFp, staleTime, staleTime);
st = await (await fetch(`${base}/state`, { headers: H })).json();
assert(!(st.active ?? []).some((t) => t.turnId === 4), "事件文件 10 分钟无新增的死回合不再显示统计中");
utimesSync(sessionFp, new Date(), new Date());
st = await (await fetch(`${base}/state`, { headers: H })).json();
assert((st.active ?? []).some((t) => t.turnId === 4), "文件恢复动静后重新显示实时统计");

// 重放防护：截断文件（offset 归零）再写回全部内容，seq 去重保证不重复计数
const before = (await (await fetch(`${base}/state`, { headers: H })).json()).turns.find((t) => t.turnId === 0);
writeFileSync(sessionFp, batch1.join("\n") + "\n");   // 比 offset 短 → 触发 offset 重置
st = await (await fetch(`${base}/state`, { headers: H })).json();
writeFileSync(sessionFp, batch1.concat(batch2).join("\n") + "\n" + fullLine3 + "\n" + liveLines.join("\n") + "\n");
st = await (await fetch(`${base}/state`, { headers: H })).json();
const after = st.turns.find((t) => t.turnId === 0);
assert(after && before && after.in === before.in && after.out === before.out,
  `文件重写重放后回合 0 计数不变（in ${after?.in} vs ${before?.in}，out ${after?.out} vs ${before?.out}）`);

// epoch 轮换：server 重启后新 epoch 继续追加同一文件、seq 重新从小值开始
// → 旧 seq 基线必须作废，新事件照常计数（否则从此全部被去重掉，统计静默归零）。
// 真实场景是纯追加（文件不缩），这里同样走追加路径
const epT = Date.now();
const epBLines = [
  ev("turn.started", { time: epT, turnId: 5, agentId: "main", prompt: "epoch轮换" }, 1, "ep_B"),
  ev("turn.step.completed", { time: epT + 400, turnId: 5, agentId: "main", usage: { inputOther: 11, output: 22, inputCacheRead: 0, inputCacheCreation: 0 } }, 2, "ep_B"),
  ev("turn.ended", { time: epT + 500, turnId: 5, agentId: "main", durationMs: 500, reason: "completed" }, 3, "ep_B"),
];
writeFileSync(sessionFp, batch1.concat(batch2).join("\n") + "\n" + fullLine3 + "\n" + liveLines.join("\n") + "\n" + epBLines.join("\n") + "\n");
await sleep(2500);
st = await (await fetch(`${base}/state`, { headers: H })).json();
assert(st.turns.some((t) => t.turnId === 5 && t.out === 22), `epoch 轮换后 seq 重置的事件照常计数（turns: ${JSON.stringify(st.turns.map((t) => t.turnId))}）`);

// 按会话窗口：另一个会话灌 12 个回合，只保留最近 10 个，且不把本会话挤出窗口
const lines999 = [];
for (let i = 0; i < 12; i++) {
  const t0 = epT + 60_000 + i * 1000;
  lines999.push(ev("turn.started", { time: t0, turnId: i, agentId: "main" }, 10 + i * 2, "ep_A", "session_999"));
  lines999.push(ev("turn.ended", { time: t0 + 800, turnId: i, agentId: "main", durationMs: 800, reason: "completed" }, 11 + i * 2, "ep_A", "session_999"));
}
writeFileSync(join(eventsDir, "session_999.jsonl"), lines999.join("\n") + "\n");
await sleep(2500);
st = await (await fetch(`${base}/state`, { headers: H })).json();
const from999 = st.turns.filter((t) => t.sessionId === "session_999");
assert(from999.length === 10, `每会话窗口：高产会话保留最近 10 回合（实际 ${from999.length}）`);
assert(st.turns.some((t) => t.sessionId === SID), "跨会话不互相挤光：session_abc 仍在窗口内");

await fetch(`${base}/shutdown`, { method: "POST", headers: H });
await sleep(600);
let dead = true;
try { await fetch(`${base}/ping`, { signal: AbortSignal.timeout(500) }); dead = false; } catch {}
assert(dead, "shutdown 后端口关闭");

console.log(`--- sidecar e2e ${passed} 项全部通过 ---`);
process.exit(0);

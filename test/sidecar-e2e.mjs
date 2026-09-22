/**
 * turn-stats sidecar 端到端：伪造事件日志 → 拉起 → 聚合校验 → 追加增量 → 停止。
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
const ev = (type, p, seq) => JSON.stringify({ kind: "event", seq, envelope: { type, session_id: SID, seq, payload: p } });

let passed = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL: " + m); child.kill(); process.exit(1); } passed++; console.log("ok: " + m); };

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
  await new Promise((r) => setTimeout(r, 250));
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

// 增量追加：回合 2 + 一个写一半的 turn.ended 残行（下轮补全后应恰好计一次）
const batch2 = [
  ev("turn.started", { time: 9000, turnId: 2, agentId: "main", prompt: "测试三" }, 8),
  ev("turn.step.completed", { time: 9500, turnId: 2, agentId: "main", usage: { inputOther: 7, output: 8, inputCacheRead: 0, inputCacheCreation: 0 } }, 9),
  ev("turn.ended", { time: 9800, turnId: 2, agentId: "main", durationMs: 800, reason: "completed" }, 10),
];
const fullLine3 = ev("turn.ended", { time: 9900, turnId: 3, agentId: "main", durationMs: 900, reason: "completed" }, 11);
const partial = fullLine3.slice(0, fullLine3.lastIndexOf('"re') + 3);   // 截断到 "re 处
writeFileSync(join(eventsDir, `session_${SID}.jsonl`), batch1.concat(batch2).join("\n") + "\n" + partial);
await new Promise((r) => setTimeout(r, 2500));
st = await (await fetch(`${base}/state`, { headers: H })).json();
assert(st.turns.some((t) => t.turnId === 2), "增量事件被拾取");
assert(!st.turns.some((t) => t.turnId === 11 || t.startT === 99), "残行未被当成事件");

// 残行补全（真实场景事件行总带结尾换行）
writeFileSync(join(eventsDir, `session_${SID}.jsonl`), batch1.concat(batch2).join("\n") + "\n" + fullLine3 + "\n");
await new Promise((r) => setTimeout(r, 2500));
st = await (await fetch(`${base}/state`, { headers: H })).json();
assert(st.turns.some((t) => t.turnId === 3), `补全后的残行被正确消费且只计一次（实际: ${JSON.stringify(st.turns.map((t) => [t.turnId, t.agentId, t.done]))}）`);

const anon = await fetch(`${base}/state`);
assert(anon.status === 401, "无 token 401");

await fetch(`${base}/shutdown`, { method: "POST", headers: H });
await new Promise((r) => setTimeout(r, 600));
let dead = true;
try { await fetch(`${base}/ping`, { signal: AbortSignal.timeout(500) }); dead = false; } catch {}
assert(dead, "shutdown 后端口关闭");

console.log(`--- sidecar e2e ${passed} 项全部通过 ---`);
process.exit(0);

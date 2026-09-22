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

// 第一批事件：回合 0（2 个 step）+ 回合 1（1 个 step）
const batch1 = [
  ev("turn.started", { time: 1000, turnId: 0, prompt: "测试一" }, 1),
  ev("turn.step.completed", { time: 1500, turnId: 0, usage: { inputOther: 100, output: 200, inputCacheRead: 3000, inputCacheCreation: 10 } }, 2),
  ev("turn.step.completed", { time: 2000, turnId: 0, usage: { inputOther: 50, output: 150, inputCacheRead: 1000, inputCacheCreation: 0 } }, 3),
  ev("turn.ended", { time: 2600, turnId: 0, durationMs: 1600, reason: "completed" }, 4),
  ev("turn.started", { time: 5000, turnId: 1, prompt: "测试二" }, 5),
  ev("turn.step.completed", { time: 6000, turnId: 1, usage: { inputOther: 30, output: 40, inputCacheRead: 0, inputCacheCreation: 0 } }, 6),
  ev("turn.ended", { time: 6500, turnId: 1, durationMs: 1500, reason: "completed" }, 7),
];
writeFileSync(join(eventsDir, `session_${SID}.jsonl`), batch1.join("\n") + "\n");

const child = spawn(process.execPath, [join(HERE, "..", "scripts", "sidecar.mjs")], {
  env: { ...process.env, KIMI_CODE_HOME: home, TURN_STATS_ASSETS: assets },
  stdio: "ignore",
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
assert(st.ok && st.turns.length === 2, `两个回合聚合（${st.turns.length}）`);
const t0 = st.turns.find((t) => t.turnId === 0);
assert(t0.in === 100 + 3000 + 10 + 50 + 1000, `回合 0 输入含缓存聚合（${t0.in}）`);
assert(t0.out === 350, `回合 0 输出聚合（${t0.out}）`);
assert(t0.durationMs === 1600, "时长用服务端 turn.ended 值");
assert(st.turns[0].turnId === 1 || st.turns[0].turnId === 0, "回合列表返回");

// 增量追加：回合 2
const batch2 = [
  ev("turn.started", { time: 9000, turnId: 2, prompt: "测试三" }, 8),
  ev("turn.step.completed", { time: 9500, turnId: 2, usage: { inputOther: 7, output: 8, inputCacheRead: 0, inputCacheCreation: 0 } }, 9),
  ev("turn.ended", { time: 9800, turnId: 2, durationMs: 800, reason: "completed" }, 10),
];
writeFileSync(join(eventsDir, `session_${SID}.jsonl`), batch1.concat(batch2).join("\n") + "\n");
await new Promise((r) => setTimeout(r, 2500));
st = await (await fetch(`${base}/state`, { headers: H })).json();
assert(st.turns.some((t) => t.turnId === 2), "增量事件被拾取");

const anon = await fetch(`${base}/state`);
assert(anon.status === 401, "无 token 401");

await fetch(`${base}/shutdown`, { method: "POST", headers: H });
await new Promise((r) => setTimeout(r, 600));
let dead = true;
try { await fetch(`${base}/ping`, { signal: AbortSignal.timeout(500) }); dead = false; } catch {}
assert(dead, "shutdown 后端口关闭");

console.log(`--- sidecar e2e ${passed} 项全部通过 ---`);
process.exit(0);

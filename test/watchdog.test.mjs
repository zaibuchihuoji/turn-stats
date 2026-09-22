/**
 * sidecar 看门狗测试（真实时序，约 1-2 分钟）：
 *   A. config 意外丢失 → 重写夺回，进程不退（渲染端立刻恢复）
 *   B. config 被别的活实例改写（新版本接管）→ 让位退出
 *   C. config 指向死进程（陈旧）→ 夺回，进程不退
 * 用法：node test/watchdog.test.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR = join(HERE, "..", "scripts", "sidecar.mjs");
const home = mkdtempSync(join(tmpdir(), "ts-wd-"));
const assets = join(home, "assets");
const events = join(home, "server", "events");
mkdirSync(assets, { recursive: true });
mkdirSync(events, { recursive: true });
const cfgPath = join(assets, "turn-stats.config.json");

let passed = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL: " + m); cleanup(); process.exit(1); } passed++; console.log("ok: " + m); };
const children = [];
const alive = (child) => child.exitCode === null && child.signalCode === null;
const readCfg = () => { try { return JSON.parse(readFileSync(cfgPath, "utf8")); } catch { return null; } };
const waitCfg = async () => { for (let i = 0; i < 40; i++) { const c = readCfg(); if (c?.port) return c; await new Promise((r) => setTimeout(r, 250)); } return null; };
const poll = async (fn, ms = 40_000) => { const end = Date.now() + ms; for (;;) { if (fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 1000)); } };
function cleanup() { for (const c of children) { try { c.kill(); } catch {} } }
process.on("exit", cleanup);

function startSidecar() {
  const child = spawn(process.execPath, [SIDECAR], {
    env: { ...process.env, KIMI_CODE_HOME: home, TURN_STATS_ASSETS: assets },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

// 占位"活的别的进程"（模拟接管方 pid）
const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
children.push(sleeper);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
await sleepMs(500);

// A. config 意外丢失 → 夺回
const a = startSidecar();
const cfgA = await waitCfg();
assert(cfgA?.port, "A: sidecar 启动并写出 config");
const { unlinkSync } = await import("node:fs");
unlinkSync(cfgPath);
const reclaimed = await poll(() => readCfg() && alive(a));
assert(reclaimed && alive(a), "A: config 丢失后重写夺回且进程存活");

// B. config 被别的活实例改写 → 让位退出
writeFileSync(cfgPath, JSON.stringify({ version: "9.9.9", port: cfgA.port + 1, token: "ff", pid: sleeper.pid }) + "\n");
const yielded = await poll(() => !alive(a));
assert(yielded, "B: 别的活实例接管 config 后让位退出");

// C. config 指向死进程（陈旧）→ 夺回
unlinkSync(cfgPath);   // 清掉 B 留下的坏 config，waitCfg 等到的一定是新实例自己写的
const c = startSidecar();
const cfgC = await waitCfg();
assert(cfgC?.port, "C: sidecar 启动并写出 config");
writeFileSync(cfgPath, JSON.stringify({ version: "0.0.1", port: cfgC.port + 1, token: "ff", pid: 999999999 }) + "\n");
const reclaimed2 = await poll(() => { const x = readCfg(); return x?.pid === cfgC.pid && x?.port === cfgC.port; });
assert(reclaimed2 && alive(c), "C: config 指向死进程时重写夺回且进程存活");

cleanup();
console.log(`--- watchdog ${passed} 项全部通过 ---`);
process.exit(0);

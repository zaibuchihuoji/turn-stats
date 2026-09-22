/**
 * self-update 单元测试：失败退避 / 更新锁 / deadline 预算。
 * 不跑真实更新交换（不动仓库文件）；网络路径只打不存在的仓库（404 快速返回）。
 * 用法：node test/self-update.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { selfUpdate, isNewer, acquireUpdateLock, resolveSafe } from "../scripts/self-update.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } passed++; console.log("ok: " + m); };
const readState = (root) => { try { return JSON.parse(readFileSync(join(root, ".update-state.json"), "utf8")); } catch { return null; } };

// 1. 版本比较
assert(isNewer("0.5.2", "0.5.1"), "isNewer 补丁位");
assert(isNewer("0.10.0", "0.9.9"), "isNewer 数值比较（非字典序）");
assert(!isNewer("1.0.0", "1.0.0"), "相同版本不算新");

// 2. 仓库不存在 → 检查失败：写 failedAt，不写 checkedAt（不能占用 24h 缓存）
const root1 = mkdtempSync(join(tmpdir(), "ts-su-"));
let r = await selfUpdate({ repo: "zaibuchihuoji/__no_such_repo_xyz__", pluginRoot: root1, currentVersion: "0.5.2", force: true });
assert(r.applied === false && /404|不可达/.test(r.reason ?? ""), `失败仓库返回失败原因（${r.reason}）`);
let st = readState(root1);
assert(st?.failedAt > 0 && !st?.checkedAt, "失败写入 failedAt 且不写 checkedAt");

// 3. 失败退避：刚失败过，非 force 调用被短退避拦下
r = await selfUpdate({ repo: "zaibuchihuoji/__no_such_repo_xyz__", pluginRoot: root1, currentVersion: "0.5.2" });
assert(r.skipped === "backoff", `失败后短退避生效（${r.reason}）`);

// 4. force 无视退避（手动 --check-update 场景）
r = await selfUpdate({ repo: "zaibuchihuoji/__no_such_repo_xyz__", pluginRoot: root1, currentVersion: "0.5.2", force: true });
assert(r.applied === false, "force 绕过退避重新检查");

// 5. deadline 已过：交换前放弃，不碰网络不碰目录
const root2 = mkdtempSync(join(tmpdir(), "ts-su-"));
r = await selfUpdate({ repo: "zaibuchihuoji/turn-stats", pluginRoot: root2, currentVersion: "0.0.1", force: true, deadline: Date.now() - 1000 });
assert(r.applied === false && /预算/.test(r.reason ?? ""), `deadline 耗尽时放弃（${r.reason}）`);
assert(existsSync(join(root2, "kimi.plugin.json")) === false, "deadline 放弃未向插件根写入任何文件");

// 6. 更新锁：持有期间他人拿不到；过期锁可接管
const root3 = mkdtempSync(join(tmpdir(), "ts-su-"));
const lock = acquireUpdateLock(root3);
assert(!!lock, "首次拿锁成功");
assert(acquireUpdateLock(root3) === null, "持有期间第二次拿锁失败");
const old = new Date(Date.now() - 10 * 60_000);
utimesSync(lock, old, old);   // 模拟持锁者死亡（锁内容过期判断看 at 字段，这里直接改写内容）
writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() - 10 * 60_000 }) + "\n");
assert(!!acquireUpdateLock(root3), "过期锁可接管");
rmSync(join(root3, ".update-lock.json"), { force: true });
assert(!!acquireUpdateLock(root3), "锁释放后可重新获取");

// 7. resolveSafe：zip-slip 边界（必须比较到路径分隔符，前缀相同的兄弟目录要拒绝）
import { basename } from "node:path";
const zipBase = mkdtempSync(join(tmpdir(), "ts-zip-"));
assert(resolveSafe(zipBase, "scripts/x.mjs") === join(zipBase, "scripts", "x.mjs"), "resolveSafe 正常相对路径");
assert(resolveSafe(zipBase, "a/../b.txt") === join(zipBase, "b.txt"), "resolveSafe 允许留在基目录内的 ..");
assert(resolveSafe(zipBase, "../outside.txt") === null, "resolveSafe 拒绝 ../ 逃逸");
const evilRel = "../" + basename(zipBase) + "-evil/x";   // 旧 startsWith(base) 会误放行的前缀兄弟目录
assert(resolveSafe(zipBase, evilRel) === null, `resolveSafe 拒绝前缀相同的兄弟目录（${evilRel}）`);
assert(resolveSafe(zipBase, "..") === null, "resolveSafe 拒绝解析到基目录本身之外");

console.log(`--- self-update 单元 ${passed} 项全部通过 ---`);

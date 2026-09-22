/**
 * turn-stats 冒烟测试：注入/卸载/备份语义/与其他插件共存/--status 只读。
 * 用法：node test/smoke.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTO = join(HERE, "..", "scripts", "auto-patch.mjs");
let pass = 0;
const assert = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } pass++; console.log("ok: " + m); };
// --no-update / --no-spawn：测试封闭（不联网检查更新、不拉起真实 sidecar）
const cli = (args, env = {}) => spawnSync(process.execPath, [AUTO, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

const manifest = JSON.parse(readFileSync(join(HERE, "..", "kimi.plugin.json"), "utf8"));
const expectVer = `turn-stats@${manifest.version}`;

// 0. --status 只读：未注入的目录不产生任何文件/改动
const dist0 = mkdtempSync(join(tmpdir(), "ts-ro-"));
writeFileSync(join(dist0, "index.html"), '<html><body><div>app</div></body></html>\n');
const before0 = readFileSync(join(dist0, "index.html"), "utf8");
let r = cli(["--status", "--no-update", "--no-spawn", "--dist", dist0]);
assert(r.status === 0, "status 在未注入目录正常退出");
assert(readFileSync(join(dist0, "index.html"), "utf8") === before0, "status 只读：未注入目录无改动");
assert(!existsSync(join(dist0, "assets")), "status 只读：不创建 assets 目录");

// 1. 首次注入（--force；html 里已有 usage-union 注入，共存场景）
const dist = mkdtempSync(join(tmpdir(), "ts-dist-"));
const html0 = '<html><body><div>app</div>    <script src="/assets/usage-union.js"></script>\n</body></html>\n';
writeFileSync(join(dist, "index.html"), html0);
mkdirSync(join(dist, "assets"), { recursive: true });
writeFileSync(join(dist, "assets", "usage-union.js"), "/* placeholder */");

r = cli(["--force", "--no-update", "--no-spawn", "--dist", dist]);
assert(r.status === 0, "首次注入成功");
const html1 = readFileSync(join(dist, "index.html"), "utf8");
assert(html1.includes("turn-stats.js") && html1.includes("usage-union.js"), "turn-stats 注入且 usage-union 保留");
const rt = readFileSync(join(dist, "assets", "turn-stats.js"), "utf8");
assert(rt.startsWith(`/* ${expectVer} */`), `runtime 带版本头（${manifest.version}）`);
const bak = readFileSync(join(dist, "index.html.turn-stats.bak"), "utf8");
assert(bak.includes("usage-union.js") && !bak.includes("turn-stats.js"), "备份=干净基线（保留其他插件、无自己）");

// 1b. --status 只读：已注入的目录同样零改动
const html1snap = html1;
r = cli(["--status", "--no-update", "--no-spawn", "--dist", dist]);
assert(r.status === 0, "status 在已注入目录正常退出");
assert(readFileSync(join(dist, "index.html"), "utf8") === html1snap, "status 只读：已注入目录无改动");

// 2. 二次运行（默认 hook 模式）：不重复注入
r = cli(["--verbose", "--no-update", "--no-spawn", "--dist", dist]);
assert(r.stdout.includes("已是最新"), "二次运行为已是最新");
assert(readFileSync(join(dist, "index.html"), "utf8").split("turn-stats.js").length - 1 === 1, "注入标记唯一");

// 3. 模拟应用更新覆盖 html 后重注入：备份跟随刷新
writeFileSync(join(dist, "index.html"), '<html><body><div>NEW-APP</div>    <script src="/assets/usage-union.js"></script>\n</body></html>\n');
r = cli(["--no-update", "--no-spawn", "--dist", dist]);
assert(r.status === 0, "应用更新后重注入成功");
assert(readFileSync(join(dist, "index.html.turn-stats.bak"), "utf8").includes("NEW-APP"), "备份跟随应用更新");

// 4. 卸载：恢复新版页面，usage-union 保留、无 ghost 标签
r = cli(["--uninstall", "--dist", dist]);
assert(r.status === 0, "卸载成功");
const html2 = readFileSync(join(dist, "index.html"), "utf8");
assert(html2.includes("NEW-APP") && !html2.includes("turn-stats.js"), "卸载恢复新版页面且无自己标记");
assert(html2.includes("usage-union.js"), "卸载不影响其他插件注入");
assert(!existsSync(join(dist, "assets", "turn-stats.js")), "runtime 文件已删");
assert(!existsSync(join(dist, "index.html.turn-stats.bak")), "备份文件已清");

// 5. 版本号来自 manifest（版本头断言见第 1 步）
assert(rt.includes(expectVer), "runtime 版本与 manifest 一致");

console.log(`--- turn-stats 冒烟 ${pass} 项全部通过 ---`);

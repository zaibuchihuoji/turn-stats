/**
 * scanEvents 逻辑单步追踪：残行 → 补全 → 消费。
 * 用法：node test/trace-scan.mjs
 */
import { writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";

const SID = "session_abc";
const ev = (type, p, seq) => JSON.stringify({ kind: "event", seq, envelope: { type, session_id: SID, seq, payload: p } });
const batch1 = [
  ev("turn.started", { time: 1000, turnId: 0, prompt: "t1", agentId: "main" }, 1),
  ev("turn.step.completed", { time: 1500, turnId: 0, agentId: "main", usage: { inputOther: 100, output: 200, inputCacheRead: 3000, inputCacheCreation: 10 } }, 2),
  ev("turn.ended", { time: 2600, turnId: 0, agentId: "main", durationMs: 1600, reason: "completed" }, 3),
];
const batch2 = [
  ev("turn.started", { time: 9000, turnId: 2, agentId: "main", prompt: "t3" }, 8),
  ev("turn.ended", { time: 9800, turnId: 2, agentId: "main", durationMs: 800, reason: "completed" }, 9),
];
// 模拟写一半的 turn.ended 行（截断到 "re 处）
const fullLine = ev("turn.ended", { time: 9900, turnId: 3, agentId: "main", durationMs: 900, reason: "completed" }, 11);
const partial = fullLine.slice(0, fullLine.indexOf('"reason"') + 9);

writeFileSync("trace.jsonl", batch1.concat(batch2).join("\n") + "\n" + partial);
const offsets = [0];

function scan() {
  const fp = "trace.jsonl";
  const size = statSync(fp).size;
  const off = offsets[0] ?? 0;
  if (size <= off) { console.log("  无新增 (size", size, "<= off", off, ")"); return; }
  const from = off === 0 ? Math.max(0, size - 256 * 1024) : off;
  const fd = openSync(fp, "r");
  const buf = Buffer.alloc(size - from);
  readSync(fd, buf, 0, size - from, from);
  closeSync(fd);
  const text = buf.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) { console.log("  无完整行，等待补全"); return; }
  const complete = text.slice(0, lastNewline + 1);
  offsets[0] = from + Buffer.byteLength(complete, "utf8");
  for (const line of complete.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      console.log("  消费事件:", j.envelope.type, "turnId", j.envelope.payload.turnId);
    } catch {
      console.log("  解析失败:", line.slice(0, 60));
    }
  }
}

console.log("scan 1（文件含残行）:");
scan();
console.log("offset:", offsets[0]);

writeFileSync("trace.jsonl", batch1.concat(batch2).join("\n") + "\n" + fullLine + "\n");
console.log("scan 2（补全后）:");
scan();
console.log("offset:", offsets[0]);

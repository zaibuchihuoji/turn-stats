/*!
 * turn-stats renderer runtime
 * 由 scripts/auto-patch.mjs 生成并注入 Kimi Code Desktop 的 desktop-dist/index.html。
 *
 * 功能：每轮对话结束（busy/main_turn_active → 双双转 false）后，在最后一轮回答
 * 下方插入一行小字：本轮耗时、token 消耗（输入/输出/缓存/费用）与生成速度。
 *
 * 数据源（全部来自本地 server，凭据复用宿主 SPA 的 sessionStorage）：
 *  - GET /api/v1/sessions        会话列表：busy / main_turn_active / usage（累计值）
 *  - usage 字段（snake_case）：input_tokens / output_tokens / cache_read_tokens /
 *    cache_creation_tokens / total_cost_usd / context_tokens / context_limit / turn_count
 *  - 回合消耗 = 回合结束快照 - 回合开始快照（累计值差值），结束前延迟重取一次，
 *    拿最终落盘的 usage（避免最后一段流式 token 没算进来）
 *
 * DOM 锚点：消息区每轮是 [data-turn-id] 元素（逆向自宿主 SPA），统计行 append 在
 * 最后一轮元素内部；宿主重渲染后由 2s 重挂载循环补挂。找不到锚点时该轮统计仅
 * 保存在内存，不阻塞任何功能。
 */
(() => {
  if (window.__turnStatsInstalled) return;
  window.__turnStatsInstalled = true;

  const POLL_MS = 2000;            // 会话状态轮询
  const SETTLE_MS = 1200;          // 回合结束后等 usage 落盘再取终值
  const ATTACH_RETRY_MS = 2000;    // 统计行重挂载检查
  const ATTACH_TTL = 10 * 60000;   // 统计行重挂载放弃时限
  const FETCH_TIMEOUT = 6000;

  // -------------------------------------------------------------------------
  // 宿主凭据（app:// 页面 → 本地 server）
  // -------------------------------------------------------------------------
  function kimiRuntime() {
    let origin = null, token = null;
    try {
      origin = sessionStorage.getItem("kimi-desktop-server-origin");
      const raw = sessionStorage.getItem("kimi-web.server-credential");
      if (raw) token = JSON.parse(raw)?.credential ?? null;
    } catch {}
    return { origin, token };
  }

  async function fetchSessions() {
    const { origin, token } = kimiRuntime();
    if (!origin) throw new Error("server origin 未知");
    const res = await fetch(`${origin}/api/v1/sessions?limit=20`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return body?.data?.items ?? [];
  }

  // -------------------------------------------------------------------------
  // 回合计数：busy 开始记快照，busy+mainTurnActive 双双转 false 判定结束
  // -------------------------------------------------------------------------
  const watchers = new Map();   // sessionId -> {startT, startUsage, lastUsage, wasBusy, joinedMid}
  const records = [];           // 已结束回合 {key, sessionId, title, startT, endT, delta, joinedMid, attached}

  function num(u, k) { return Number(u?.[k] ?? 0) || 0; }

  function deltaUsage(a, b) {
    const keys = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "turn_count"];
    const d = {};
    for (const k of keys) d[k] = num(b, k) - num(a, k);
    d.total_cost_usd = num(b, "total_cost_usd") - num(a, "total_cost_usd");
    return d;
  }

  async function pollOnce() {
    const items = await fetchSessions();
    const runningIds = new Set();
    for (const s of items) {
      const busy = !!(s.busy || s.main_turn_active);
      if (!busy) continue;
      runningIds.add(s.id);
      const w = watchers.get(s.id);
      if (!w) {
        // 首次见到 busy：若该会话 usage 的 turn_count 之前没见过，视为中途加入
        // （无从得知回合起点），统计值只覆盖观察窗口
        watchers.set(s.id, {
          startT: Date.now(), startUsage: s.usage ?? {}, lastUsage: s.usage ?? {},
          wasBusy: true, joinedMid: true, title: s.title ?? "",
        });
      } else {
        w.wasBusy = true;
        w.lastUsage = s.usage ?? w.lastUsage;
      }
    }
    // 不再 busy 的 watcher → 回合结束
    for (const [id, w] of [...watchers]) {
      if (runningIds.has(id)) continue;
      watchers.delete(id);
      if (!w.wasBusy) continue;
      finalizeTurn(id, w, Date.now());
    }
  }

  async function finalizeTurn(sessionId, w, endDetectedT) {
    const key = `${sessionId}#${Date.now()}`;
    // 延迟取终值：流式收尾的 usage 常在状态翻转后一瞬才落盘。
    // 耗时按"检测到结束"的时刻算，不含这段结算延迟
    setTimeout(async () => {
      let endUsage = w.lastUsage;
      try {
        const items = await fetchSessions();
        const s = items.find((x) => x.id === sessionId);
        if (s?.usage) endUsage = s.usage;
      } catch {}
      records.push({
        key, sessionId, title: w.title, startT: w.startT, endT: endDetectedT,
        delta: deltaUsage(w.startUsage, endUsage), joinedMid: w.joinedMid, attached: null,
      });
      if (records.length > 40) records.shift();
      attachStats();
    }, SETTLE_MS);
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------
  const CSS = `
.ts-scope{--ts-fg:#c9c9d1;--ts-dim:rgba(201,201,209,.55);--ts-border:rgba(255,255,255,.12)}
.ts-scope.light{--ts-fg:#3d3d46;--ts-dim:rgba(61,61,70,.55);--ts-border:rgba(0,0,0,.12)}
@media (prefers-color-scheme: light){.ts-scope:not(.dark):not(.light){
  --ts-fg:#3d3d46;--ts-dim:rgba(61,61,70,.55);--ts-border:rgba(0,0,0,.12)}}
.ts-line{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;margin-top:8px;
  padding:5px 10px;border-top:1px dashed var(--ts-border);font-size:11px;line-height:1.5;
  color:var(--ts-fg);opacity:.78;user-select:text;font-variant-numeric:tabular-nums}
.ts-line .ts-k{opacity:.55;margin-right:3px}
.ts-line .ts-v{font-weight:600}
`;

  function themeClass() {
    const ds = document.documentElement.dataset.colorScheme;
    if (ds === "light" || ds === "dark") return `ts-scope ${ds}`;
    return `ts-scope ${matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"}`;
  }

  function fmtDuration(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return `${s} 秒`;
    return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  }

  function fmtTokens(n) {
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n));
  }

  function fmtCost(usd) {
    if (usd >= 0.01) return `$${usd.toFixed(3)}`;
    if (usd > 0) return `$${usd.toFixed(4)}`;
    return "";
  }

  function buildLine(r) {
    const d = r.delta;
    const ms = r.endT - r.startT;
    const speed = ms > 500 ? d.output_tokens / (ms / 1000) : 0;
    const line = document.createElement("div");
    line.className = `ts-line ${themeClass()}`;
    line.dataset.tsKey = r.key;
    const put = (k, v) => {
      const span = document.createElement("span");
      const kEl = document.createElement("i"); kEl.className = "ts-k"; kEl.textContent = k;
      const vEl = document.createElement("b"); vEl.className = "ts-v"; vEl.textContent = v;
      span.append(kEl, vEl);
      line.appendChild(span);
    };
    put("耗时", (r.joinedMid ? "≈" : "") + fmtDuration(ms));
    put("输入", fmtTokens(d.input_tokens));
    put("输出", fmtTokens(d.output_tokens));
    if (speed > 0) put("速度", `${Math.round(speed)} tok/s`);
    const cost = fmtCost(d.total_cost_usd);
    if (cost) put("费用", cost);
    line.title = [
      `本轮输入 ${d.input_tokens.toLocaleString()} tok（含缓存读 ${d.cache_read_tokens.toLocaleString()}）`,
      `本轮输出 ${d.output_tokens.toLocaleString()} tok（缓存创建 ${d.cache_creation_tokens.toLocaleString()}）`,
      `回合数 +${d.turn_count} · 会话：${r.title || r.sessionId}`,
      r.joinedMid ? "注意：插件在回合中途才开始观察，数值只覆盖观察窗口" : "",
    ].filter(Boolean).join("\n");
    return line;
  }

  function turnCandidates() {
    return [...document.querySelectorAll("[data-turn-id]")]
      .filter((el) => el.dataset.turnId && !/cron/i.test(el.className));
  }

  function attachStats() {
    const turns = turnCandidates();
    if (!turns.length) return;
    const now = Date.now();
    // 记录按时间升序、回合元素按 DOM 序升序：最新记录配最后一轮，依次向前；
    // 回合元素比记录少时跳过最旧的记录
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.attached && now - r.endT > ATTACH_TTL) continue;
      const idx = turns.length - 1 - (records.length - 1 - i);
      if (idx < 0) break;
      const turnEl = turns[idx];
      if (turnEl.querySelector(`.ts-line[data-ts-key="${CSS.escape(r.key)}"]`)) { r.attached = now; continue; }
      // 该回合元素已挂了统计行（含其他记录），不再叠加
      if (turnEl.querySelector(".ts-line")) continue;
      try {
        turnEl.appendChild(buildLine(r));
        r.attached = now;
      } catch {}
    }
    if (!document.getElementById("turn-stats-style")) {
      try {
        const style = document.createElement("style");
        style.id = "turn-stats-style";
        style.textContent = CSS;
        document.head.appendChild(style);
      } catch {}
    }
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  async function tick() {
    try { await pollOnce(); } catch {}
    attachStats();
  }

  function boot() {
    try {
      const style = document.createElement("style");
      style.textContent = CSS;
      style.id = "turn-stats-style";
      document.head.appendChild(style);
    } catch {}
    setInterval(tick, POLL_MS);
    addEventListener("focus", tick);
    addEventListener("online", tick);
    tick();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

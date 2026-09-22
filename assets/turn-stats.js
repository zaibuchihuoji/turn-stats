/*!
 * turn-stats renderer runtime
 * 由 scripts/auto-patch.mjs 生成并注入 Kimi Code Desktop 的 desktop-dist/index.html。
 *
 * 数据通道：本地 sidecar 服务（hook 拉起，127.0.0.1 + token，端口与凭据在
 * /assets/turn-stats.config.json）。sidecar 监听本地 server 的事件日志
 * （server/events/session_<id>.jsonl），聚合出每回合的真实 token 用量与
 * 服务器计时的回合时长；本脚本每 2 秒拉取一次，把新完成的回合渲染成一行
 * 小字，插在消息区最后一个 [data-turn-id] 元素内。
 *
 * 内容：耗时 / 输入（含缓存读）/ 输出 / 生成速度；悬停看缓存明细与会话名。
 * 诊断：window.__turnStatsState。
 */
(() => {
  if (window.__turnStatsInstalled) return;
  window.__turnStatsInstalled = true;

  const CONFIG_URL = "/assets/turn-stats.config.json";
  const POLL_MS = 2000;
  const ATTACH_RETRY_MS = 2000;
  const ATTACH_TTL = 10 * 60000;
  const FETCH_TIMEOUT = 6000;

  // -------------------------------------------------------------------------
  // sidecar 客户端
  // -------------------------------------------------------------------------
  let client = { at: 0, port: 0, token: "" };

  async function apiClient(force) {
    if (!force && client.port && Date.now() - client.at < 5000) return client;
    try {
      const j = await (await fetch(`${CONFIG_URL}?t=${Date.now()}`)).json();
      client = { at: Date.now(), port: j?.port ?? 0, token: j?.token ?? "" };
    } catch { client = { at: Date.now(), port: 0, token: "" }; }
    return client;
  }

  async function callState(forceCfg, retried) {
    const c = await apiClient(forceCfg);
    if (!c.port) throw new Error("统计服务未运行");
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${c.port}/state`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        headers: { Authorization: `Bearer ${c.token}` },
      });
    } catch (e) {
      throw new Error(/abort|timeout/i.test(String(e?.message ?? e)) ? "服务请求超时" : String(e?.message ?? e));
    }
    if (res.status === 401 && !retried) { await apiClient(true); return callState(true, true); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${res.status}`);
    return j;
  }

  // -------------------------------------------------------------------------
  // 状态与渲染
  // -------------------------------------------------------------------------
  const rendered = new Set();    // 已渲染的回合 key
  const records = [];            // {r: 服务器回合, attached}
  let loadError = null;
  let lastState = null;

  function ingest(state) {
    // 服务器返回按 endT 降序；统一整理成升序（最旧在前），配对逻辑依赖此顺序
    for (const t of state.turns ?? []) {
      const key = `${t.sessionId}|${t.turnId}|${t.endT}`;
      if (rendered.has(key)) continue;
      records.push({ key, t, attached: null });
      rendered.add(key);
    }
    records.sort((a, b) => a.t.endT - b.t.endT);
    while (records.length > 60) records.shift();
    // 只保留最近 60 分钟未挂载的
    const now = Date.now();
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].attached && now - records[i].t.endT > ATTACH_TTL) records.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------
  const CSS = `
.ts-scope{--ts-fg:#c9c9d1;--ts-border:rgba(255,255,255,.12)}
.ts-scope.light{--ts-fg:#3d3d46;--ts-border:rgba(0,0,0,.12)}
@media (prefers-color-scheme: light){.ts-scope:not(.dark):not(.light){
  --ts-fg:#3d3d46;--ts-border:rgba(0,0,0,.12)}}
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

  function buildLine(t) {
    const line = document.createElement("div");
    line.className = `ts-line ${themeClass()}`;
    line.dataset.tsKey = `${t.sessionId}|${t.turnId}|${t.endT}`;
    const put = (k, v) => {
      const span = document.createElement("span");
      const kEl = document.createElement("i"); kEl.className = "ts-k"; kEl.textContent = k;
      const vEl = document.createElement("b"); vEl.className = "ts-v"; vEl.textContent = v;
      span.append(kEl, vEl);
      line.appendChild(span);
    };
    const speed = t.durationMs > 500 ? t.out / (t.durationMs / 1000) : 0;
    put("耗时", fmtDuration(t.durationMs));
    if (t.cacheRead > 0) {
      put("输入", `${fmtTokens(t.in)}（缓存 ${fmtTokens(t.cacheRead)}）`);
    } else {
      put("输入", fmtTokens(t.in));
    }
    put("输出", fmtTokens(t.out));
    if (speed > 0) put("速度", `${Math.round(speed)} tok/s`);
    line.title = [
      `输入合计 ${t.in.toLocaleString()} tok = 新增 ${fmtTokens(t.in - t.cacheRead - t.cacheCreation)} + 缓存读 ${t.cacheRead.toLocaleString()} + 缓存创建 ${t.cacheCreation.toLocaleString()}`,
      `输出 ${t.out.toLocaleString()} tok · 结束原因 ${t.reason || "completed"}`,
      `会话 ${t.sessionId.slice(0, 26)}… · 回合 #${t.turnId}`,
    ].join("\n");
    return line;
  }

  function turnCandidates() {
    return [...document.querySelectorAll("[data-turn-id]")]
      .filter((el) => el.dataset.turnId && !/cron/i.test(el.className));
  }

  function ensureStyle() {
    if (document.getElementById("turn-stats-style")) return;
    try {
      const style = document.createElement("style");
      style.id = "turn-stats-style";
      style.textContent = CSS;
      document.head.appendChild(style);
    } catch {}
  }

  function attachStats() {
    if (!records.length) return;
    ensureStyle();
    const turns = turnCandidates();
    if (!turns.length) return;
    const now = Date.now();
    // records 按结束时间升序追加；最新记录配最后一轮，依次向前
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.attached) continue;
      const idx = turns.length - 1 - (records.length - 1 - i);
      if (idx < 0) break;
      const turnEl = turns[idx];
      let occupied = false, already = false;
      for (const el of turnEl.querySelectorAll(".ts-line")) {
        occupied = true;
        if (el.dataset.tsKey === r.key) already = true;
      }
      if (already) { r.attached = now; continue; }
      if (occupied) continue;
      try {
        turnEl.appendChild(buildLine(r.t));
        r.attached = now;
      } catch (err) {
        diag.lastAttachError = String((err && err.stack) || err).slice(0, 200);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 启动 + 诊断（window.__turnStatsState）
  // -------------------------------------------------------------------------
  const diag = { bootAt: Date.now(), sidecar: "?", polled: 0, lastError: "",
    turnsKnown: 0, lastTurnElements: 0, attachedCount: 0, lastAttachError: "", sampleTail: "" };

  async function tick() {
    try {
      const state = await callState();
      loadError = null;
      lastState = state;
      diag.sidecar = `v${state.version}`;
      ingest(state);
    } catch (e) {
      loadError = String(e?.message ?? e);
      diag.lastError = loadError;
      apiClientForceWhenDown();
    }
    diag.polled++;
    diag.turnsKnown = rendered.size;
    diag.attachedCount = records.filter((r) => r.attached).length;
    diag.lastTurnElements = turnCandidates().length;
    try {
      window.__turnStatsState = { ...diag, loadError,
        lastTurns: records.slice(-3).map((r) => ({ in: r.t.in, out: r.t.out, ms: r.t.durationMs, attached: !!r.attached })) };
    } catch {}
    attachStats();
  }

  function apiClientForceWhenDown() {
    // 服务 404/重启换端口后，下一次强制重读配置
    if (loadError && Date.now() - client.at > 4000) client.at = 0;
  }

  function boot() {
    ensureStyle();
    console.info("[turn-stats] runtime loaded (sidecar mode)");
    setInterval(tick, POLL_MS);
    setInterval(attachStats, ATTACH_RETRY_MS);
    addEventListener("focus", tick);
    addEventListener("online", tick);
    tick();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

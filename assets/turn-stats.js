/*!
 * turn-stats renderer runtime
 * 由 scripts/auto-patch.mjs 生成并注入 Kimi Code Desktop 的 desktop-dist/index.html。
 *
 * 数据通道：本地 server 的 WebSocket（/api/v1/ws?client_id=…，localhost 免鉴权）。
 * 订阅会话后服务器实时推送回合事件：
 *   turn.started          {turnId, time, prompt}
 *   turn.step.completed   {turnId, usage:{inputOther, output, inputCacheRead, inputCacheCreation}}
 *   turn.ended            {turnId, durationMs, reason}   ← 服务器算好的回合时长
 * 一轮可能包含多个 step，统计行聚合该 turnId 的全部 step usage。
 *
 * 渲染：在消息区最后一个 [data-turn-id] 元素内插入统计行；宿主重渲染后 2s 补挂。
 * 会话发现：每 15s 轮询 /api/v1/sessions，对新出现的会话补发订阅。
 * 诊断：window.__turnStatsState 随时可查运行状态。
 */
(() => {
  if (window.__turnStatsInstalled) return;
  window.__turnStatsInstalled = true;

  const SESSIONS_POLL_MS = 15000;
  const ATTACH_RETRY_MS = 2000;
  const ATTACH_TTL = 10 * 60000;
  const WS_RETRY_MIN = 2000;
  const WS_RETRY_MAX = 30000;

  // -------------------------------------------------------------------------
  // 连接参数（app:// 页面 → 本地 server）
  // -------------------------------------------------------------------------
  function serverOrigin() {
    try { return sessionStorage.getItem("kimi-desktop-server-origin"); } catch { return null; }
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------
  let ws = null;
  let wsRetryDelay = WS_RETRY_MIN;
  let wsConnectedAt = 0;
  let wsMsgCount = 0;
  let lastWsError = "";
  const subscribed = new Set();   // 已订阅 session id
  const turns = new Map();        // `${sessionId}|${turnId}` -> {startT, prompt, in, out, cacheRead, cacheCreation, sessionId}
  const records = [];             // 已完成回合，待渲染

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------
  function connectWs() {
    const origin = serverOrigin();
    if (!origin || (ws && ws.readyState <= 1)) return;
    const url = origin.replace(/^http/, "ws") + "/api/v1/ws?client_id=turn-stats-" + Date.now();
    try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
    ws.onopen = () => {
      wsConnectedAt = Date.now();
      wsRetryDelay = WS_RETRY_MIN;
      for (const sid of subscribed) sendSubscribe(sid);
    };
    ws.onmessage = (ev) => {
      wsMsgCount++;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      handleEvent(m);
    };
    ws.onclose = () => { ws = null; scheduleReconnect(); };
    ws.onerror = () => { lastWsError = "ws error " + new Date().toLocaleTimeString(); };
  }

  function scheduleReconnect() {
    setTimeout(connectWs, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, WS_RETRY_MAX);
  }

  function sendSubscribe(sessionId) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "subscribe_v2", id: Date.now(), payload: { session_id: sessionId } }));
  }

  function handleEvent(m) {
    const env = m.envelope ?? m;
    const type = env.type ?? m.type ?? "";
    const payload = env.payload ?? m.payload ?? {};
    const sessionId = env.session_id ?? m.session_id ?? "";
    if (type === "turn.started") {
      turns.set(`${sessionId}|${payload.turnId}`, {
        startT: payload.time ?? Date.now(), prompt: payload.prompt ?? "",
        in: 0, out: 0, cacheRead: 0, cacheCreation: 0, sessionId,
      });
      return;
    }
    if (type === "turn.step.completed") {
      const key = `${sessionId}|${payload.turnId}`;
      const t = turns.get(key);
      if (!t) return;
      const u = payload.usage ?? {};
      t.in += Number(u.inputOther ?? 0) + Number(u.inputCacheRead ?? 0) + Number(u.inputCacheCreation ?? 0);
      t.out += Number(u.output ?? 0);
      t.cacheRead += Number(u.inputCacheRead ?? 0);
      t.cacheCreation += Number(u.inputCacheCreation ?? 0);
      return;
    }
    if (type === "turn.ended") {
      const key = `${sessionId}|${payload.turnId}`;
      const t = turns.get(key);
      turns.delete(key);
      if (!t) return;
      records.push({
        key: `${sessionId}#${payload.turnId}#${payload.time ?? Date.now()}`,
        sessionId, title: "", startT: t.startT,
        endT: (payload.time ?? Date.now()),
        durationMs: Number(payload.durationMs ?? 0) || (payload.time ?? Date.now()) - t.startT,
        in: t.in, out: t.out, cacheRead: t.cacheRead, cacheCreation: t.cacheCreation,
        joinedMid: false, attached: null,
      });
      if (records.length > 40) records.shift();
      attachStats();
    }
  }

  // -------------------------------------------------------------------------
  // 会话发现：新会话补订阅
  // -------------------------------------------------------------------------
  async function pollSessions() {
    const origin = serverOrigin();
    if (!origin) return;
    const res = await fetch(`${origin}/api/v1/sessions?limit=20`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return;
    const body = await res.json();
    for (const s of body?.data?.items ?? []) {
      if (s.id && !subscribed.has(s.id)) {
        subscribed.add(s.id);
        sendSubscribe(s.id);
      }
    }
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

  function buildLine(r) {
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
    const speed = r.durationMs > 500 ? r.out / (r.durationMs / 1000) : 0;
    put("耗时", fmtDuration(r.durationMs));
    put("输入", fmtTokens(r.in));
    put("输出", fmtTokens(r.out));
    if (speed > 0) put("速度", `${Math.round(speed)} tok/s`);
    line.title = [
      `本轮输入 ${r.in.toLocaleString()} tok（其中缓存读 ${r.cacheRead.toLocaleString()} / 缓存创建 ${r.cacheCreation.toLocaleString()}）`,
      `本轮输出 ${r.out.toLocaleString()} tok`,
      `会话：${r.sessionId.slice(0, 20)}…`,
    ].join("\n");
    return line;
  }

  function turnCandidates() {
    return [...document.querySelectorAll("[data-turn-id]")]
      .filter((el) => el.dataset.turnId && !/cron/i.test(el.className));
  }

  function attachStats() {
    if (!records.length) return;
    ensureStyle();
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
      let already = false, occupied = false;
      for (const el of turnEl.querySelectorAll(".ts-line")) {
        if (el.dataset.tsKey === r.key) already = true;
        occupied = true;
      }
      if (already) { r.attached = now; continue; }
      if (occupied) continue;
      try {
        turnEl.appendChild(buildLine(r));
        r.attached = now;
      } catch {}
    }
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

  // -------------------------------------------------------------------------
  // 启动 + 诊断（window.__turnStatsState 随时可查）
  // -------------------------------------------------------------------------
  const diag = { bootAt: Date.now(), ws: "connecting", wsMessages: 0, subscribedCount: 0,
    activeTurns: 0, recordsCount: 0, lastTurnElements: 0, lastError: "" };

  function updateDiag() {
    diag.ws = ws ? (ws.readyState === 1 ? "connected" : "connecting") : "disconnected";
    diag.wsMessages = wsMsgCount;
    diag.subscribedCount = subscribed.size;
    diag.activeTurns = turns.size;
    diag.recordsCount = records.length;
    diag.lastTurnElements = turnCandidates().length;
    try { window.__turnStatsState = { ...diag, records: records.slice(-3).map((r) => ({ endT: r.endT, attached: !!r.attached, in: r.in, out: r.out, ms: r.durationMs })) }; } catch {}
  }

  function tick() {
    try {
      connectWs();
      pollSessions().catch((e) => { diag.lastError = String(e?.message ?? e); });
    } catch (e) { diag.lastError = String(e?.message ?? e); }
    updateDiag();
    attachStats();
  }

  function boot() {
    ensureStyle();
    console.info("[turn-stats] runtime loaded (ws mode)");
    setInterval(tick, SESSIONS_POLL_MS);
    setInterval(updateDiag, ATTACH_RETRY_MS);
    setInterval(attachStats, ATTACH_RETRY_MS);
    addEventListener("focus", tick);
    addEventListener("online", tick);
    tick();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

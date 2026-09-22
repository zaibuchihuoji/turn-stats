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
  const RENDER_SETTLE_MS = 2500;   // turn.ended 后等流式打字动画收尾再出统计行
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
    // 只保留最近 60 分钟的记录（可挂载窗口）
    const now = Date.now();
    for (let i = records.length - 1; i >= 0; i--) {
      if (now - records[i].t.endT > ATTACH_TTL) records.splice(i, 1);
    }
  }

  function currentSessionId() {
    // 会话页 URL 形如 app://renderer/sessions/session_xxx；新建未保存的聊天没有 id
    const m = /sessions\/(session_[\w-]+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function visibleRecords() {
    // 只统计当前打开会话的回合——sidecar 聚合的是所有会话，不过滤就会把别的
    // 会话（甚至重启前遗留的）统计混进当前聊天
    const sid = currentSessionId();
    const mine = records.filter((r) => !sid || r.t.sessionId === sid);
    return mine.length ? mine : records.slice(-1);
  }

  // 统计行宿主：最后一个用户回合（.u-turn）的父容器 = 消息区末尾。
  // 注意：整张消息区里只有用户回合带 data-turn-id，助手回复没有独立锚点，
  // 所以挂在容器末尾（最后一轮回答下方）；composer 若在同容器则插到它前面
  function targetHost() {
    const uTurns = [...document.querySelectorAll(".u-turn[data-turn-id]")];
    const last = uTurns[uTurns.length - 1];
    if (!last) return null;
    const parent = last.parentElement;
    if (!parent) return null;
    const pm = parent.querySelector(".ProseMirror");
    const composerRoot = pm ? (pm.closest('[class*="composer"]') ?? pm.parentElement) : null;
    return { parent, composerRoot };
  }

  function attachStats() {
    const sid = currentSessionId();
    const now = Date.now();
    // 最新完成的一轮回合，且流式展示已收尾（RENDER_SETTLE_MS）——
    // turn.ended 时客户端打字动画常常还在放，过早插入会"消息没显示完就统计了"
    const ready = records
      .filter((r) => (!sid || r.t.sessionId === sid) && now - r.t.endT >= RENDER_SETTLE_MS)
      .sort((a, b) => b.t.endT - a.t.endT)[0];
    const host = targetHost();
    if (!host) return;
    ensureStyle();
    let line = host.parent.querySelector(":scope > .ts-line");
    // 统计行后面出现了新的用户回合 = 用户已发下一条消息，旧统计失效，移除；
    // （否则统计行会被夹在旧回答与新消息之间，看起来像挂在了用户消息上）
    if (line) {
      const next = line.nextElementSibling;
      if (next && (next.matches(".u-turn, [data-turn-id]") || next.querySelector?.(".u-turn"))) {
        line.remove();
        line = null;
      }
    }
    if (!ready) return;
    if (line && line.dataset.tsKey === ready.key) return;
    if (line) line.remove();
    const fresh = buildLine(ready.t);
    if (host.composerRoot) host.parent.insertBefore(fresh, host.composerRoot);
    else host.parent.appendChild(fresh);
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
    const speed = t.decodeMs > 300 ? t.out / (t.decodeMs / 1000) : 0;
    put("耗时", fmtDuration(t.durationMs));
    if (t.cacheRead > 0) {
      put("输入", `${fmtTokens(t.in)}（缓存 ${fmtTokens(t.cacheRead)}）`);
    } else {
      put("输入", fmtTokens(t.in));
    }
    put("输出", fmtTokens(t.out));
    if (speed > 0) put("生成", `${Math.round(speed)} tok/s`);
    line.title = [
      `输入合计 ${t.in.toLocaleString()} tok = 新增 ${fmtTokens(t.in - t.cacheRead - t.cacheCreation)} + 缓存读 ${t.cacheRead.toLocaleString()} + 缓存创建 ${t.cacheCreation.toLocaleString()}`,
      `输出 ${t.out.toLocaleString()} tok · 纯答案解码 ${((t.decodeMs ?? 0) / 1000).toFixed(1)} 秒（速度不含思考，Kimi 事件不含思考 token 计数）`,
      t.firstTokenMs ? `首字延迟 ${(t.firstTokenMs / 1000).toFixed(1)} 秒` : "",
      `结束原因 ${t.reason || "completed"} · 会话 ${t.sessionId.slice(0, 26)}… · 回合 #${t.turnId}`,
    ].filter(Boolean).join("\n");
    return line;
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
    diag.attachedCount = document.querySelectorAll(".ts-line").length;
    diag.lastTurnElements = document.querySelectorAll(".u-turn[data-turn-id]").length;
    try {
      window.__turnStatsState = { ...diag, loadError,
        lastTurns: records.slice(-3).map((r) => ({ in: r.t.in, out: r.t.out, ms: r.t.durationMs, sid: r.t.sessionId.slice(0, 14) })) };
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

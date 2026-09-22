/*!
 * turn-stats renderer runtime
 * 由 scripts/auto-patch.mjs 生成并注入 Kimi Code Desktop 的 desktop-dist/index.html。
 *
 * 展示形态：固定悬浮条（输入框上方右侧），不插入消息流 DOM——
 * 消息区由 Vue 管理，往里插节点会被重渲染/插入行为冲掉或错位（v0.4.x 教训）。
 *
 * 内容：
 *   模型干活中 → 实时统计（耗时 / 已产生 token）
 *   回合结束后 → 最终统计（耗时 / 输入含缓存拆解 / 输出 / 纯生成吞吐）
 * 数据源：本地 sidecar 服务（hook 拉起，127.0.0.1 + token），聚合
 *   server/events/session_<id>.jsonl 的 turn.started/step.completed/ended 事件。
 * 只显示当前打开会话（按页面 URL 会话 id 过滤）。可关闭（记住偏好）。
 * 诊断：window.__turnStatsState。
 */
(() => {
  if (window.__turnStatsInstalled) return;
  window.__turnStatsInstalled = true;

  const CONFIG_URL = "/assets/turn-stats.config.json";
  const POLL_MS = 1500;
  const FETCH_TIMEOUT = 6000;
  const HIDE_KEY = "turn-stats.hidden";

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
  // 会话定位
  // -------------------------------------------------------------------------
  function currentSessionId() {
    // 会话页 URL 形如 app://renderer/sessions/session_xxx；新建未保存的聊天没有 id
    const m = /sessions\/(session_[\w-]+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------
  const CSS = `
.ts-scope{--ts-fg:#c9c9d1;--ts-dim:rgba(201,201,209,.55);--ts-border:rgba(255,255,255,.14);
  --ts-bg:rgba(30,30,34,.92);--ts-card:rgba(255,255,255,.06)}
.ts-scope.light{--ts-fg:#3d3d46;--ts-dim:rgba(61,61,70,.55);--ts-border:rgba(0,0,0,.14);
  --ts-bg:rgba(255,255,255,.94);--ts-card:rgba(0,0,0,.05)}
@media (prefers-color-scheme: light){.ts-scope:not(.dark):not(.light){
  --ts-fg:#3d3d46;--ts-dim:rgba(61,61,70,.55);--ts-border:rgba(0,0,0,.14);
  --ts-bg:rgba(255,255,255,.94);--ts-card:rgba(0,0,0,.05)}}
.ts-chip{position:fixed;right:18px;bottom:118px;z-index:2147483000;display:flex;gap:4px 10px;
  align-items:baseline;padding:6px 12px;border-radius:10px;border:1px solid var(--ts-border);
  background:var(--ts-bg);color:var(--ts-fg);font-size:11px;line-height:1.5;
  box-shadow:0 4px 16px rgba(0,0,0,.25);user-select:text;font-variant-numeric:tabular-nums;
  backdrop-filter:blur(8px)}
.ts-chip .ts-k{opacity:.55;margin-right:3px}
.ts-chip .ts-v{font-weight:600}
.ts-chip .ts-live{color:var(--ts-accent,#4f8cff)}
.ts-chip .ts-x{all:unset;cursor:pointer;opacity:.45;padding:0 2px;margin-left:2px;font-size:11px}
.ts-chip .ts-x:hover{opacity:1}
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

  function chipEl() {
    let chip = document.getElementById("turn-stats-chip");
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "turn-stats-chip";
      chip.className = `ts-chip ${themeClass()}`;
      const x = document.createElement("button");
      x.className = "ts-x";
      x.textContent = "✕";
      x.title = "隐藏回合统计（本次启动）";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        try { sessionStorage.setItem(HIDE_KEY, "1"); } catch {}
        chip.remove();
      });
      chip.appendChild(x);
      document.body.appendChild(chip);
    }
    return chip;
  }

  function span(k, v, cls) {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    const kEl = document.createElement("i"); kEl.className = "ts-k"; kEl.textContent = k;
    const vEl = document.createElement("b"); vEl.className = "ts-v"; vEl.textContent = v;
    s.append(kEl, vEl);
    return s;
  }

  function renderChip(state) {
    if (sessionStorage.getItem(HIDE_KEY) === "1") { document.getElementById("turn-stats-chip")?.remove(); return; }
    const sid = currentSessionId();
    const mine = (state.turns ?? []).filter((t) => !sid || t.sessionId === sid);
    const active = (state.active ?? []).filter((t) => !sid || t.sessionId === sid)
      .sort((a, b) => b.startT - a.startT)[0];
    const chip = chipEl();

    // 保留 ✕ 按钮，其余重建
    const x = chip.querySelector(".ts-x");
    chip.textContent = "";
    chip.appendChild(x);

    if (active) {
      // 模型干活中：实时统计
      chip.appendChild(span("耗时", fmtDuration(active.elapsedMs), "ts-live"));
      chip.appendChild(span("输入", fmtTokens(active.in)));
      chip.appendChild(span("输出", fmtTokens(active.out), "ts-live"));
      chip.appendChild(span("", "统计中…", "ts-live"));
      chip.title = [
        `回合 #${active.turnId} 进行中（实时统计）`,
        `已产生输入 ${active.in.toLocaleString()} tok（含缓存读 ${active.cacheRead.toLocaleString()}）`,
        `已产生输出 ${active.out.toLocaleString()} tok`,
      ].join("\n");
      return;
    }

    const last = mine.sort((a, b) => b.endT - a.endT)[0];
    if (!last) {
      chip.appendChild(span("", "暂无回合统计"));
      chip.title = "发送一条消息后，这里会显示该轮的 token 消耗与耗时";
      return;
    }
    const speed = last.decodeMs > 300 ? Math.round(last.out / (last.decodeMs / 1000)) : 0;
    chip.appendChild(span("耗时", fmtDuration(last.durationMs)));
    if (last.cacheRead > 0) chip.appendChild(span("输入", `${fmtTokens(last.in)}（缓存 ${fmtTokens(last.cacheRead)}）`));
    else chip.appendChild(span("输入", fmtTokens(last.in)));
    chip.appendChild(span("输出", fmtTokens(last.out)));
    if (speed > 0) chip.appendChild(span("生成", `${speed} tok/s`));
    chip.title = [
      `上一轮统计 · 会话 ${last.sessionId.slice(0, 26)}… · 回合 #${last.turnId}`,
      `输入合计 ${last.in.toLocaleString()} tok = 新增 ${fmtTokens(last.in - last.cacheRead - last.cacheCreation)} + 缓存读 ${last.cacheRead.toLocaleString()} + 缓存创建 ${last.cacheCreation.toLocaleString()}`,
      `输出 ${last.out.toLocaleString()} tok · 纯答案解码 ${((last.decodeMs ?? 0) / 1000).toFixed(1)} 秒（速度不含思考，Kimi 事件不含思考 token 计数）`,
      `结束原因 ${last.reason || "completed"}`,
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // 启动 + 诊断（window.__turnStatsState）
  // -------------------------------------------------------------------------
  const diag = { bootAt: Date.now(), sidecar: "?", polled: 0, lastError: "", chip: false };

  async function tick() {
    try {
      const state = await callState();
      renderChip(state);
      diag.sidecar = `v${state.version}`;
      diag.lastError = "";
      diag.chip = !!document.getElementById("turn-stats-chip");
    } catch (e) {
      diag.lastError = String(e?.message ?? e);
      document.getElementById("turn-stats-chip")?.remove();
    }
    diag.polled++;
    try { window.__turnStatsState = { ...diag }; } catch {}
  }

  function boot() {
    console.info("[turn-stats] runtime loaded (chip mode)");
    setInterval(tick, POLL_MS);
    addEventListener("focus", tick);
    addEventListener("online", tick);
    tick();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

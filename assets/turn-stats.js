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
 * 服务不可达时不清空：保留最后成功的数据并标注「离线」，恢复后自动跟上。
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
.ts-scope{--ts-fg:#e8eaf2;--ts-dim:rgba(232,234,242,.6);--ts-border:rgba(96,140,255,.5);
  --ts-bg:rgba(20,22,30,.97);--ts-card:rgba(255,255,255,.08)}
.ts-scope.light{--ts-fg:#26282f;--ts-dim:rgba(38,40,47,.6);--ts-border:rgba(47,84,235,.45);
  --ts-bg:rgba(255,255,255,.98);--ts-card:rgba(0,0,0,.05)}
@media (prefers-color-scheme: light){.ts-scope:not(.dark):not(.light){
  --ts-fg:#26282f;--ts-dim:rgba(38,40,47,.6);--ts-border:rgba(47,84,235,.45);
  --ts-bg:rgba(255,255,255,.98);--ts-card:rgba(0,0,0,.05)}}
.ts-chip{position:fixed;right:18px;top:38%;z-index:2147483000;display:flex;gap:4px 10px;
  align-items:baseline;padding:7px 13px;border-radius:10px;border:1px solid var(--ts-border);
  background:var(--ts-bg);color:var(--ts-fg);font-size:12px;line-height:1.5;
  box-shadow:0 6px 24px rgba(0,0,0,.45);user-select:text;font-variant-numeric:tabular-nums;
  backdrop-filter:blur(10px)}
.ts-chip .ts-k{opacity:.6;margin-right:3px}
.ts-chip .ts-v{font-weight:700}
.ts-chip .ts-live{color:#7aa5ff}
.ts-chip .ts-off{color:var(--ts-dim);font-weight:400}
.ts-chip.ts-offline{opacity:.75}
.ts-chip .ts-x{all:unset;cursor:pointer;opacity:.55;padding:0 2px;margin-left:2px;font-size:12px}
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

  // 贴着输入框的上边缘、两侧与输入框对齐（同宽）；找不到输入框时退回右侧上部。
  // 只读 DOM 位置，不插入消息流（v0.4.x 教训是往里插节点，读 rect 没有副作用）。
  // 候选可能有多个（隐藏的 contenteditable、侧栏搜索框等）：取最底部且足够宽的那个
  function findComposerRect() {
    const cands = [...document.querySelectorAll('.ProseMirror, [contenteditable=true], textarea, [aria-label*="输入"]')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 100 && r.top > 60);
    if (!cands.length) return null;
    return cands.reduce((a, b) => (b.top > a.top ? b : a));
  }

  function positionChip() {
    const chip = document.getElementById("turn-stats-chip");
    if (!chip) return;
    const r = findComposerRect();
    if (r) {
      chip.style.left = Math.round(r.left) + "px";
      chip.style.right = Math.max(12, Math.round(window.innerWidth - r.right)) + "px";
      chip.style.top = Math.max(8, Math.round(r.top - chip.offsetHeight - 6)) + "px";
      return;
    }
    chip.style.left = "";
    chip.style.top = "20%";   // 回退位置故意区别于正常位：肉眼可判"输入框没找到"
    chip.style.right = "18px";
  }

  function span(k, v, cls) {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    const kEl = document.createElement("i"); kEl.className = "ts-k"; kEl.textContent = k;
    const vEl = document.createElement("b"); vEl.className = "ts-v"; vEl.textContent = v;
    s.append(kEl, vEl);
    return s;
  }

  function renderChip(state, offline) {
    if (sessionStorage.getItem(HIDE_KEY) === "1") { document.getElementById("turn-stats-chip")?.remove(); return; }
    const chip = chipEl();
    // 主题每次渲染跟随（应用内切换深浅色立即生效）；离线时整体调暗
    chip.className = `ts-chip ${themeClass()}${offline ? " ts-offline" : ""}`;

    // 保留 ✕ 按钮，其余重建
    const x = chip.querySelector(".ts-x");
    chip.textContent = "";
    chip.appendChild(x);

    // 定位不到会话 id（新建未保存的聊天、或 URL 结构变化）：严格不显示，
    // 绝不回退到"全部会话"，否则会把别的会话的统计串到当前界面
    const sid = currentSessionId();
    if (!sid) {
      chip.appendChild(span("", "暂无回合统计"));
      chip.title = "打开一个已保存的会话后，这里显示该会话的回合统计";
      return;
    }

    const active = (state?.active ?? []).filter((t) => t.sessionId === sid)
      .sort((a, b) => b.startT - a.startT)[0];

    if (active) {
      // 模型干活中：实时统计
      chip.appendChild(span("耗时", fmtDuration(active.elapsedMs), "ts-live"));
      chip.appendChild(span("输入", fmtTokens(active.in)));
      chip.appendChild(span("输出", fmtTokens(active.out), "ts-live"));
      chip.appendChild(span("", "统计中…", "ts-live"));
      if (offline) chip.appendChild(span("", "离线", "ts-off"));
      chip.title = [
        `回合 #${active.turnId} 进行中（实时统计）`,
        `已产生输入 ${active.in.toLocaleString()} tok（含缓存读 ${active.cacheRead.toLocaleString()}）`,
        `已产生输出 ${active.out.toLocaleString()} tok`,
        ...(offline ? ["统计服务暂不可达，以上为最后成功拉取的数据；重开会话可自动恢复"] : []),
      ].join("\n");
      return;
    }

    const last = (state?.turns ?? []).filter((t) => t.sessionId === sid).sort((a, b) => b.endT - a.endT)[0];
    if (!last) {
      chip.appendChild(span("", offline ? "统计服务未连接" : "暂无回合统计"));
      chip.title = offline
        ? "统计服务不可达（重开会话会自动拉起；诊断见 window.__turnStatsState.lastError）"
        : "发送一条消息后，这里会显示该轮的 token 消耗与耗时";
      return;
    }
    const speed = last.decodeMs > 300 ? Math.round(last.out / (last.decodeMs / 1000)) : 0;
    chip.appendChild(span("耗时", fmtDuration(last.durationMs)));
    if (last.cacheRead > 0) chip.appendChild(span("输入", `${fmtTokens(last.in)}（缓存 ${fmtTokens(last.cacheRead)}）`));
    else chip.appendChild(span("输入", fmtTokens(last.in)));
    chip.appendChild(span("输出", fmtTokens(last.out)));
    if (speed > 0) chip.appendChild(span("生成", `${speed} tok/s`));
    if (offline) chip.appendChild(span("", "离线", "ts-off"));
    const tooltip = [
      `上一轮统计 · 会话ID ${last.sessionId.slice(0, 26)}… · 回合 #${last.turnId}`,
      `输入合计 ${last.in.toLocaleString()} tok = 新增 ${fmtTokens(last.in - last.cacheRead - last.cacheCreation)} + 缓存读 ${last.cacheRead.toLocaleString()} + 缓存创建 ${last.cacheCreation.toLocaleString()}（各步累加）`,
      `输出 ${last.out.toLocaleString()} tok · 纯答案解码 ${((last.decodeMs ?? 0) / 1000).toFixed(1)} 秒（速度不含思考，Kimi 事件不含思考 token 计数）`,
    ];
    if (last.firstTokenMs > 0) tooltip.push(`首字延迟 ${((last.firstTokenMs ?? 0) / 1000).toFixed(2)} 秒`);
    tooltip.push(`结束原因 ${last.reason || "completed"}`);
    if (offline) tooltip.push("统计服务暂不可达，以上为最后成功拉取的数据；重开会话可自动恢复");
    chip.title = tooltip.join("\n");
  }

  // -------------------------------------------------------------------------
  // 启动 + 诊断（window.__turnStatsState）
  // -------------------------------------------------------------------------
  const diag = { bootAt: Date.now(), sidecar: "?", polled: 0, lastError: "", offline: false, chip: false };
  let lastGood = null;   // 最后一次成功的 /state：离线时保留旧数据，不把悬浮条删成空白

  async function tick() {
    try {
      const state = await callState();
      lastGood = state;
      diag.offline = false;
      diag.lastError = "";
      renderChip(state, false);
      diag.sidecar = `v${state.version}`;
    } catch (e) {
      diag.lastError = String(e?.message ?? e);
      diag.offline = true;
      renderChip(lastGood, true);
    }
    diag.polled++;
    diag.chip = !!document.getElementById("turn-stats-chip");
    positionChip();
    try { window.__turnStatsState = { ...diag }; } catch {}
  }

  function boot() {
    console.info("[turn-stats] runtime loaded (chip mode)");
    // v0.5.0 重写时弄丢了样式注入：CSS 常量从未进文档，悬浮条以裸 div 布局，
    // 被页面顶栏遮住——肉眼"永远看不到"。样式只挂一次
    if (!document.getElementById("turn-stats-style")) {
      const style = document.createElement("style");
      style.id = "turn-stats-style";
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    setInterval(tick, POLL_MS);
    addEventListener("focus", tick);
    addEventListener("online", tick);
    tick();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

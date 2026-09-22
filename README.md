# turn-stats — Kimi Code Desktop 回合统计

每轮对话结束（模型干完活）后，自动在**最后一轮回答下方**插入一行小字：

```
耗时 1 分 23 秒 · 输入 12.3k · 输出 45.6k · 546 tok/s · $0.042
```

- **耗时**：从你发出指令到模型收尾的完整回合时长
- **输入/输出**：本轮 token 消耗（输入含缓存读取，悬停可看完整明细）
- **速度**：输出 token / 秒——模型生成快不快，一眼可见
- **费用**：本轮美元成本（会话上报了 cost 才显示）

## 原理

会话启动 hook 注入一段渲染脚本到 `desktop-dist/`（`app://` 协议实时读盘，
与 usage-union 同一技术路线）。脚本每 2 秒轮询本地 server 的 `/api/v1/sessions`：

- 检测回合边界：会话 `busy` / `main_turn_active` 双双转 false = 本轮结束
- 本轮消耗 = 回合结束快照 − 回合开始快照（会话级累计 usage 的差值，
  字段：input_tokens / output_tokens / cache_read_tokens / total_cost_usd / turn_count）
- 结束后延迟 1.2s 再取一次终值，避免流式收尾的最后一段 token 漏算
- 渲染锚点是消息区每轮的 `[data-turn-id]` 元素（逆向自宿主 SPA），宿主重渲染后
  2 秒内自动补挂

## 安装

设置 → 插件 → 安装自定义插件，填：

```
https://github.com/zaibuchihuoji/turn-stats
```

github.com 直连超时的话填 codeload 直链（固定版本）：

```
https://codeload.github.com/zaibuchihuoji/turn-stats/zip/refs/tags/v0.1.0
```

装完**重启 Kimi Code Desktop** + 开新会话生效。

## 自动更新

与 usage-union / auto-memory 同款：hook 每 24h 检查一次 `codeload` 默认分支
（国内直连可达），新版本自动原子替换，下一会话生效。开发副本（含 `.git`）
不自更新；`--check-update` 立即检查；`--no-update` 或 `TURN_STATS_NO_UPDATE=1`
关闭。

## 手动管理

```bash
node scripts/auto-patch.mjs --status        # 查看注入状态
node scripts/auto-patch.mjs --force         # 强制重注入
node scripts/auto-patch.mjs --uninstall     # 还原 desktop-dist
```

## 已知限制

- 挂机期间错过回合开始（应用开着但脚本中途才注入）时，该轮数值只覆盖观察窗口，
  耗时前带 `≈` 标记
- 统计跟随"正在干活的会话"；如果你在模型干活时切到别的会话查看，统计行会插在
  当前打开的会话的最后一轮下方（悬停可看会话名核对）
- 依赖逆向的非公开契约（`/api/v1/sessions` 字段、`[data-turn-id]` 锚点），应用
  大版本更新后可能静默失效——`--status` 可查注入状态，重开一次会话会自动重注入

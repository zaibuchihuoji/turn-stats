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

会话启动 hook 注入渲染脚本到 `desktop-dist/`（`app://` 协议实时读盘，
与 usage-union 同一技术路线），并拉起一个本地统计服务（sidecar）：

- **数据源**：本地 server 落盘的事件日志 `~/.kimi-code/server/events/session_<id>.jsonl`。
  事件 `turn.started` / `turn.step.completed` / `turn.ended` 携带每步真实 token 用量
  （`inputOther` 非缓存输入 / `output` / `inputCacheRead` / `inputCacheCreation`）、
  服务器计时的回合时长（`durationMs`）与纯生成解码时间（`llmServerDecodeMs`）
- **聚合**：sidecar 增量监听事件文件（只消费完整行，半行等补全），按回合累加；
  Task 子代理（agent-N）的消耗按发生时间归入当时进行中的主回合
- **渲染**：脚本每 2 秒拉取 sidecar 的已完成回合，只取**当前打开会话**的记录
  （按页面 URL 里的会话 id 过滤，防跨会话串数据），插入最后一个
  `[data-turn-id]` 元素；宿主重渲染后 2 秒内幂等重挂

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

- sidecar 冷启动只回读每个事件文件的末尾 256KB——特别长的历史回合可能聚合不全
  （只影响"补显示旧回合"，新回合永远完整）
- 统计行只挂**当前打开会话**的回合；如果你在模型干活时切到别的会话查看，那轮
  统计不显示（悬停明细里有会话名可核对）
- Task 子代理的生成时间与主回合并行，"生成 tok/s"按主回合 wall-clock 内的
  总输出 / 总解码时间计算
- 依赖逆向的非公开契约（事件日志字段、`[data-turn-id]` 锚点），应用大版本更新
  后可能静默失效——`--status` 可查注入状态，重开一次会话会自动重注入

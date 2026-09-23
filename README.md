# turn-stats — Kimi Code Desktop 回合统计

模型每轮干完活，统计这一轮消耗了多少 token、用了多久、生成多快。
展示为聊天区右侧的**固定悬浮条**（不插消息流，不受界面重渲染影响）：

```
模型干活中： 耗时 12 秒 · 输入 1.2k · 输出 340 · 统计中…
回合结束后： 耗时 6.9 秒 · 输入 39.6k（缓存 39.6k）· 输出 103 · 生成 47 tok/s
```

- **耗时**：服务器计时的回合时长（从你发出指令到收尾）
- **输入**：本轮输入 token（悬停拆解：新增 / 缓存读 / 缓存创建——缓存部分计价约 0.1 折；
  输入为各步累加值，每步都携带完整上下文）
- **输出**：本轮输出 token
- **生成**：纯答案解码吞吐 = 输出 / 服务端解码时间（不含思考等待；Kimi 事件不含思考 token 计数）
- 模型干活时悬浮条**实时更新**，能直接观察思考/输出阶段的流量差异

## 原理

会话启动 hook 注入渲染脚本到 `desktop-dist/`（`app://` 协议实时读盘，
与 usage-union 同一技术路线），并拉起一个本地统计服务（sidecar）：

- **数据源**：本地 server 落盘的事件日志 `~/.kimi-code/server/events/session_<id>.jsonl`。
  事件 `turn.started` / `turn.step.completed` / `turn.ended` 携带每步真实 token 用量
  （`inputOther` 非缓存输入 / `output` / `inputCacheRead` / `inputCacheCreation`）、
  服务器计时的回合时长（`durationMs`）与纯生成解码时间（`llmServerDecodeMs`）
- **聚合**：sidecar 在统计脚本每次拉取（`GET /state`）时增量扫描事件文件
  （只消费完整行，半行等补全），按 epoch+seq 去重（文件截断/重写后的重放不会
  重复计数；server 重启后 epoch 轮换、seq 重新从小值开始时自动作废旧基线不漏计），
  行处理逐行隔离（单行异常只丢该行），按回合累加；Task 子代理（agent-N）的
  消耗按发生时间归入当时进行中的主回合
- **渲染**：脚本每 1.5 秒拉取 sidecar，悬浮条只显示**当前打开会话**的最新回合
  （按页面 URL 里的会话 id 过滤；定位不到会话 id 时显示"暂无回合统计"，
  绝不串别的会话的数据）。统计服务不可达时**不清空**：保留最后一次成功的数据
  并标注「离线」，恢复后自动跟上
- **存活**：sidecar 看门狗按 config 里的 pid 判断——被新版本实例接管就让位、
  config 意外丢失就重写夺回（连续两轮仍丢才算卸载兜底退出）；30 分钟没有
  `/state` 拉取（应用已关闭）自退，不留后台进程。sidecar 崩溃后由下一次
  会话启动的 hook 重新拉起

## 安装

设置 → 插件 → 安装自定义插件，填：

```
https://github.com/zaibuchihuoji/turn-stats
```

github.com 直连超时的话填 codeload 直链（固定版本）：

```
https://codeload.github.com/zaibuchihuoji/turn-stats/zip/refs/tags/v0.6.3
```

装完**重启 Kimi Code Desktop** + 开新会话生效。

## 自动更新

与 usage-union / auto-memory 同款：hook 每 24h 检查一次 `codeload` 默认分支
（国内直连可达），新版本自动原子替换，下一会话生效。检查失败走 1 小时短退避
（瞬时网络故障不会压制一整天）；带目录锁，多窗口同时开会话不会互相踩交换过程。
开发副本（含 `.git`）不自更新；`--check-update` 立即检查；`--no-update` 或
`TURN_STATS_NO_UPDATE=1` 关闭。

## 手动管理

```bash
node scripts/auto-patch.mjs --status        # 只读诊断：注入版本 / sidecar 与 config 一致性 / 自更新状态
node scripts/auto-patch.mjs --force         # 强制重注入
node scripts/auto-patch.mjs --uninstall     # 还原 desktop-dist
```

## 已知限制

- sidecar 冷启动只回读每个事件文件的末尾 256KB——特别长的历史回合可能聚合不全
  （只影响"补显示旧回合"，新回合永远完整）
- 统计行只挂**当前打开会话**的回合；新建未保存的聊天（URL 里没有会话 id）显示
  "暂无回合统计"；如果你在模型干活时切到别的会话查看，那轮统计不显示（悬停
  明细里有会话 ID 可核对）。`/state` 窗口按会话分组各保留最近 10 个回合，切换
  回旧会话不会因其他会话高产而被挤成"暂无"
- 应用崩溃/断电残留的未结束回合：事件文件超过 10 分钟没有新增就不再当
  "统计中"显示（正常回合期间事件持续落盘，不会误伤）
- Task 子代理的生成时间与主回合并行，"生成 tok/s"按主回合 wall-clock 内的
  总输出 / 总解码时间计算
- sidecar 崩溃后当前会话内无法自动重生（渲染进程没有拉起进程的能力）：
  悬浮条会保留最后数据并标注「离线」，**重开一次会话**即恢复；应用关闭后
  sidecar 空闲 30 分钟自动退出，不留后台进程
- 依赖逆向的非公开契约（事件日志字段），应用大版本更新后可能静默失效——
  `/state` 返回的 `parsed` 计数可诊断漂移（事件数多但缺字段占比高 = 字段改名），
  `--status` 可查注入状态，重开一次会话会自动重注入
- hook 依赖 `node` 在 PATH 中；找不到时 hook 静默失败，用 skill / 手动
  `--force` 兜底

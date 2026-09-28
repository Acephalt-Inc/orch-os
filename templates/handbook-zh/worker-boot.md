---
name: worker-boot
description: 以 WORKER 身份启动本会话——确认自己不是 lead、了解最新状态、认领一项任务，在自己的 worktree 中完成，并附证据报告 DONE。每次开始执行任务的会话都运行。
---

# Worker 启动

Worker 每次从 lead 处领取一项任务，完成并证明任务已完成。Worker 不决定范围、不合并，也不批准自己的改动。按顺序执行以下步骤。

## 0. 声明身份并确认角色

```sh
export ORCH_AGENT=w1              # your worker name; each worker has its own
orch lease status                 # if the holder is you, you are in the wrong boot file
```

## 1. 了解最新状态（只读）

```sh
cat "${ORCH_HOME:-$HOME/.orch}/mem/INDEX.md"   # standing rules and lessons
orch msg read                                  # answers and instructions addressed to you
orch task list                                 # anything you still hold?
git worktree list                              # your unfinished work on disk
```

如果你仍持有上一个会话中的任务，它就是你的首要工作：继续完成，或释放任务并告知 lead 原因。

## 2. 开始前先认领

```sh
orch task claim <task-id>
```

| 退出码 | 含义 | 你要做什么 |
|---|---|---|
| 0 `CLAIMED` | 任务归你。记下 `epoch`（你的 fencing token）。 | 开始。 |
| 3 `BUSY` | 任务由其他人持有。 | 不要处理该任务。向 lead 发送 `BLOCKED` 消息。 |
| 2 | 任务 ID 无效。 | 在简报中核对 ID。 |

对于耗时较长的任务，应在认领到期前续租：

```sh
orch task renew <task-id> --expected-epoch <epoch>
```

收到 `STALE_EPOCH`、`NOT_HOLDER` 或 `EXPIRED`，表示任务已不再归你：停止工作，将改动保留在自己的分支上，并告知 lead。

## 3. 执行工作

- 在自己的 worktree 和分支中工作（`orch worker start ... --worktree` 会为你创建），不要在默认分支或其他 worker 的目录中工作。
- 遵守简报范围。如果无法判断某项工作是否在你的范围、权限或预算内，将其视为范围外：停止并用 `QUESTION` 询问。
- 自行决定小型实现细节（文件位置、测试布局、命名），并在 `DONE` 报告中说明你的选择。
- 简报中的预算（时间、工具调用、资金）都是硬限制。用尽预算应报告 `BLOCKED`，不能报告 `DONE`。

```sh
orch msg send QUESTION --to lead -m "parser-fix: the brief says keep the old flag; the new parser cannot. Drop it or keep a shim?"
orch msg watch --count 1          # wait for the answer
```

## 4. 附证据报告 DONE，然后释放任务

另一位代理应能核查 `DONE` 报告，而无需相信报告者。报告必须包含：

1. 任务 ID 和认领 epoch；
2. 分支及准确的提交（`git rev-parse HEAD`）；
3. 你运行的每条验证命令及其原样输出（至少包括摘要行：测试数量、退出码）；
4. 你未做、跳过或无法验证的事项；
5. 建议评审者优先检查的内容。

```sh
orch msg send DONE --to lead -m "$(cat report.md)"
orch task release <task-id> --expected-epoch <epoch>
```

任务完成后立即发送报告；不要等 lead 来问。

## 不可妥协的规则

- 一次只能认领一项任务，除非 lead 另有说明。
- 没有显示结果的命令输出，绝不能声称“通过”或“已修复”。
- 不得合并、不得批准自己的改动、不得推送到默认分支。
- 简报范围以外的不可逆或对外行动：停止并询问。

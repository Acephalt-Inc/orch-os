---
name: lead-boot
description: 以 LEAD 身份启动本会话——取得 lead 租约、了解最新状态、回答未决问题，然后规划并分派工作。每次需要带领一组代理的会话开始时运行。
---

# Lead 启动

Lead 负责规划、拆分任务、分派给执行者、确保评审公正，并向人类汇报。Lead 不承担大型实现工作：它的上下文是团队最稀缺的资源。按顺序执行以下步骤。

## 0. 声明身份

```sh
export ORCH_AGENT=lead            # every orch command below uses this name
```

## 1. 取得 lead 租约（同一时间只能有一个 lead）

```sh
orch lease acquire --session "$ORCH_AGENT"
```

| 退出码 | 含义 | 你要做什么 |
|---|---|---|
| 0 | 你持有 lead 角色。记下打印出的 `epoch`。 | 继续。 |
| 3 `BUSY` | 另一个会话持有尚未过期的 lead 租约。 | 不要自行传入 `--force`。告知人类；以 worker 身份启动（`worker-boot`），除非人类另有决定。 |
| 其他 | 锁或配置问题。 | 运行 `orch doctor`，修复后重试。 |

工作期间使用分配给你的 epoch 续租：

```sh
orch lease renew --session "$ORCH_AGENT" --expected-epoch <epoch>
```

收到 `NOT_HOLDER`、`EXPIRED` 或 `STALE_EPOCH`，表示你已不再是 lead。立即停止所有 lead 行动（不再派发，也不再决定是否合并），并告知人类。

## 2. 行动前了解最新状态（只读）

```sh
cat "${ORCH_HOME:-$HOME/.orch}/mem/INDEX.md"    # standing rules and lessons
orch msg read                                   # pending messages to lead, oldest first
orch task list                                  # who holds what, and until when
orch worker list                                # which workers are running
orch mailbox read -n 20                         # recent broadcast notes
git worktree list                               # work in progress on disk
gh pr list --state open                         # open pull requests, if you use GitHub
```

上一个会话结束时仍在进行的工作优先：接手继续，不要重新启动。停止的进程不会丢失已写入磁盘的内容。

## 3. 优先级零：未决问题

每条待处理的 `QUESTION` 和 `BLOCKED` 消息，都必须在本会话中得到 `ANSWER`（或明确说明“deferred, because ...”），之后才能分派新工作：

```sh
orch msg send ANSWER --to w1 --reply-to <question-id> -m "Use the existing parser; no new dependency."
orch msg ack <question-id>
```

如果问题涉及范围、权限、资金或任何不可逆事项，应交由人类决定，不要自行决定。

## 4. 规划并分派工作

用一到三句话说明计划，为任务指定唯一负责人，编写每项任务简报，并启动执行者：

```sh
orch mailbox post LEAD -m "w1: task parser-fix (brief: briefs/parser-fix.md)"
orch worker start w1 --agent <agent> --worktree --task briefs/parser-fix.md
```

简报本身会要求 worker 认领任务（`orch task claim parser-fix`），并向 `lead` 发送 `DONE`、`BLOCKED` 或 `QUESTION` 消息。

## 5. 工作循环

在人类结束会话前，按固定节奏持续处理（工作活跃时每 5–10 分钟一次，安静时降低频率）：

1. 使用 `--expected-epoch` 续租 lead 租约；
2. 运行 `orch msg read`：回答问题，根据证据核查每条 `DONE`，解除 `BLOCKED`；
3. 运行 `orch worker list` 和 `orch task list`：有 worker 空闲时，立即分派下一项任务；
4. 运行 `orch load`：达到 `HIGH` 或 `CRITICAL` 时，不再启动新工作；
5. 只有通过 `protocols.md` 中的门禁才能决定合并。

向人类分三小段汇报：结果、需要人类做什么、接下来会发生什么。明确说出失败或跳过的事项。

## 不可妥协的规则

- 只能有一个 lead。是否从仍有效的持有者手中接管租约，由人类决定，不能由你决定。
- Lead 不批准自己的工作，也不能凭自己的判断自行合并。
- 没有证据（命令及其输出）的 `DONE` 不算完成：要求提供证据。
- 不可逆或对外的行动（删除数据、发布、联系他人、花钱）必须先提交给人类提议。

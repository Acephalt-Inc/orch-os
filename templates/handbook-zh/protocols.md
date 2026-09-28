---
name: protocols
description: 所有角色共同遵守的规则——身份、四种消息类型、任务认领、附命令输出的 DONE 报告、合并规则（当前 head commit 上需有 N 个非作者批准）、备忘和安全边界。无论你担任什么角色，每个会话都读一次。
---

# 协议

这些规则是 lead、worker、reviewer 和人类之间的约定。这里的每条命令都是 `orch` 命令；参见 `orch <command> --help`。

## 身份与角色

- 每个会话只设置一次名称：`export ORCH_AGENT=<name>`（例如 `lead`、`w1`、`r1`）。消息、认领和报告都使用该名称。
- 角色代表工作，不代表供应商或模型。任何代理 CLI 都可以承担任何角色。
- `orch lease` 强制同一时间只能有一个 lead。lead 收到 `NOT_HOLDER` 或 `STALE_EPOCH` 后，必须立即停止以 lead 身份行动。

## 消息

定向消息通过 `orch msg` 发送。每条消息都有发送者、接收者（`--to NAME`，或向所有人发送时用 `*`）、类型和正文。每位读者都有自己的游标：在该读者确认之前，消息会一直处于待处理状态。

| 类型 | 适用情形 | 必须包含 | 接收者要做什么 |
|---|---|---|---|
| `QUESTION` | 你需要一个决定才能继续。 | 所需决定、可选方案、你的建议。 | 在看到该消息的处理轮次中回答（或明确延期）。 |
| `ANSWER` | 你决定了某个 `QUESTION`。 | `--reply-to <question id>`；决定内容。 | 确认该消息并继续。 |
| `DONE` | 任务已完成。 | DONE 报告（见下文）。 | 核查证据，然后确认消息。 |
| `BLOCKED` | 你无法继续，等待也不会解决问题。 | 阻碍、已尝试的办法、解除阻碍所需条件。 | 排除阻碍、重新分派或升级处理。 |

```sh
orch msg send QUESTION --to lead -m "Keep the old flag or drop it? Recommend: drop, it has no callers."
orch msg read                        # my pending messages
orch msg ack <id>                    # done with it
orch msg watch --count 1             # wait for the next one
```

团队中最昂贵的问题就是无人回答的问题：lead 每轮都会最先读取待处理消息，然后才处理其他事。

共享邮箱（`orch mailbox`）用于发布无需回复的广播备注：任务分派、状态、交接。它只允许追加；任何人都不得编辑已有条目。

## 任务认领

- 开始前先认领：`orch task claim <id>`。退出码 3（`BUSY`）表示任务由其他人持有；不要处理该任务。
- 认领的 epoch 是你的 fencing token。用 `orch task renew <id> --expected-epoch <epoch>` 续租；若返回 `STALE_EPOCH`，表示任务已转交处理。
- 完成后释放：`orch task release <id> --expected-epoch <epoch>`。
- 沉默和过期的心跳都不会转移任务。只有释放、到期或 lead 的明确决定才会改变任务持有人。

## DONE 报告

DONE 报告应当附有证据，使另一位代理无需信任作者也能核查：

```text
DONE <task-id> epoch=<n>
branch=<branch> commit=<full sha>
ran:
  $ <command>
  <its output, verbatim, at least the summary lines>
not done / skipped: <list, or "none">
look first at: <file:line or topic>
```

只说“测试通过”而不提供命令及其输出，不算证据。部分完成的报告必须在第一行说明这一点。

## 合并规则

只有在以下条件同时满足时，改动才能合并：

1. CI 在该改动的**当前 head commit**上为绿色；
2. 至少有 **N** 个来自**非作者**评审者、针对该**当前 head commit**的批准（默认值为 1，`[merge] required_approvals`）；
3. 没有评审者的最新评审要求修改。

将此作为单独步骤检查，并在采取任何行动前读取结果：

```sh
orch merge-gate <pr> --head <sha-you-reviewed>
```

- 任何推送都会使先前批准过期；新的 head 需要新的批准。
- “修复后批准”不算批准。
- 如果所有代理使用同一个代码托管账户，则改用评审评论：`orch review approve <pr> --as <you> --head <sha>` 会发布一条；`orch merge-gate <pr> --reviews comments --task <id>` 会检查评论。规则相同，但用代理名称代替账户；评审评论是协作代理之间的流程规则，账户令牌可以使用任意名称发评论，因此绝不能代替他人发布评审。
- 由谁执行合并由人类决定。只有人类明确同意合并此项改动或此类改动，且结果为 `PASS` 时，代理才能合并。

## 跨会话保留的备忘

`orch mem` 保存团队下周仍需了解的信息：规则、经验、事实和指引。

- 每个条目只记录一项事实或规则：`orch mem add <name> --type rule -d "<one line>" -m "<why, and how to apply it>"`。
- 每个会话开始时都要读取 `mem/INDEX.md`。该文件有行数上限，因为每次读取都会占用上下文；若 `add` 提示达到上限，应归档或合并条目。
- 信息不再有效时，将其归档：`orch mem retire <old> --superseded-by <new>`。文件会保留并标记为已归档，同时从索引中移除。

## 安全边界

- 不可逆或对外的行动（删除数据、对共享分支强制推送、发布、联系团队外人员、花钱）必须先提交给人类提议，再执行。
- 简报中的预算是硬限制。
- 绝不能把秘密放入消息、邮箱、备忘或报告。
- 不确定某项行动是否获准时，就视为不获准：用 `QUESTION` 询问。

## 将这些文件载入代理

`orch init` 会将本手册写入 `~/.orch/handbook/`（或 `--dir` 指定的目录）。根据角色为每个会话指定对应文件：

- 能加载 skill 文件夹的代理 CLI：`orch init --layout skills --dir <skills dir>` 会写入 `<name>/SKILL.md` 文件夹；启动会话并调用 `lead-boot`、`worker-boot` 或 `review-boot`。
- 使用指令文件的代理 CLI（例如 `AGENTS.md` 或 `CLAUDE.md`）：添加一行类似“在会话开始时，读取 ~/.orch/handbook/protocols.md 以及对应角色的启动文件，然后遵循其中说明。”
- 用 `orch worker start` 启动的无头 worker：在任务文件开头写入“遵循 ~/.orch/handbook/worker-boot.md”。

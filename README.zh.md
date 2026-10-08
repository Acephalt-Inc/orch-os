<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/acephalt-logo-white-text.png">
    <img src="assets/acephalt-logo-dark-text.png" alt="Acephalt" width="360">
  </picture>
</p>

<h3 align="center">ORCH-OS：命令行编程代理的团队协作层</h3>

<p align="center"><a href="docs/concepts.md">文档</a> · <a href="docs/commands.md">命令</a> · <a href="docs/faq.md">常见问题</a> · <a href="README.md">English</a></p>

<p align="center">
  <a href="https://github.com/Acephalt-Inc/orch-os/actions/workflows/ci.yml"><img src="https://github.com/Acephalt-Inc/orch-os/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a>
  <a href="https://www.npmjs.com/package/orch-os"><img src="https://img.shields.io/npm/v/orch-os" alt="npm 版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20dual-blue" alt="PolyForm 双许可证"></a>
</p>

ORCH-os 协调同一仓库中的多个命令行编程代理。由租约确定的负责人、共享信箱、支持独占认领的任务板、基于评审的合并闸门和后台工作进程，为团队提供共同的运行层。它与 Claude Code、Codex CLI 等命令行代理配合使用。

作者：[Winnicent Zuo](https://www.linkedin.com/in/winnicent-zuo/)

## 安装

需要 Node.js 22 或更高版本（推荐 24 LTS），以及 macOS 或 Linux。可以全局安装 `orch`，也可以用 `npx` 临时运行：

```sh
npm i -g orch-os
# 或：npx orch-os init
```

## 为什么选择 ORCH-os

一个编码代理只需要一段提示词。一组代理需要一层操作系统：有人负责，每项工作只有一个归属者，消息能送达并得到回复，合并要等独立评审，团队学到的东西在会话结束后仍然保留。ORCH-os 把这一层划分为 14 个子系统，每个子系统只负责一件事，并执行一小组规则。

| # | 子系统 | 职责 | 组成 | 状态 |
|---|---|---|---|---|
| 1 | 控制平面 | 同一时间只有一位负责人；团队保持运转 | 带纪元隔离的角色租约 · 租约续期 · 定时后台任务 · 存活监视 · 推导出的运行模式 | 租约：已提供 · 定时任务：审查中（[#6](https://github.com/Acephalt-Inc/orch-os/pull/6)）· 监视、模式：Coming soon |
| 2 | 目标与验证 | 目标只写一次；“完成”是一条可运行的检查 | 目标登记 · 任务模板 · 完成检查 | Coming soon |
| 3 | 工作执行 | 每个任务只有一个归属者，工作进程生命周期完整 | 独占任务认领 · 后台工作进程 · 时限 · 每个工作进程独立的 Git worktree · 带有序终态的运行历史 | 认领、工作进程、worktree：已提供 · 运行历史：Coming soon |
| 4 | 代理间通信 | 问题能送达、得到回复并被确认 | 带类型的定向消息 · 每位读者的游标 · 确认 · 等待回复 · 共享信箱 | 已提供 |
| 5 | 评审与合并闸门 | 只有对确切提交的独立评审通过才可合并 | 当前提交的 CI · 非作者批准 · 评审者强度分级 · CI 变绿时派发评审者 | 已提供 |
| 6 | 策略与审批 | 哪些决定代理可自行做出，哪些需要人来定 | 必需标签 · 基于档案的评审规则 · 带范围与取代关系的规则登记 · 暂停令 | 标签、档案规则：已提供 · 规则登记、暂停令：Coming soon |
| 7 | 资源与账号 | 工作不超出机器和账号的限制 | 带迟滞的负载调节 · 工作进程准入 · 账号与人员档案 · 工作进程上限 | 已提供 |
| 8 | 记忆 | 团队的经验，带完整生命周期 | 记录 · 索引 · 召回 · 核验 · 取代 · 过期 · 归档 | 记录、有上限的索引、召回、带继任者的取代、归档：已提供 · 召回时核验、按时间过期：Coming soon |
| 9 | 知识库 | 覆盖团队所有文档的统一登记 | 跨存储的稳定 ID · 每项的状态 · 会说明哪些没搜的搜索 | Coming soon |
| 10 | 学习与自我改进 | 把事故和纠正变成真正落地的改动 | 事故收集 · 带回滚路径的提案 · 前后指标对比 · 从笔记逐级升级为检查 | Coming soon |
| 11 | 度量 | 关于团队自身的数字 | 负载采样 · 每任务成本 · trace ID · 回归重放 | 负载采样：已提供 · 成本、追踪、重放：Coming soon |
| 12 | 身份与隔离 | 限定每个代理能碰到的范围 | 代理发现 · worktree 隔离 · 每个代理的身份 · 沙箱与外发检查 | 发现、worktree：已提供 · 身份、沙箱：Coming soon |
| 13 | 人机界面 | 人能看到团队状态，并决定只有人能决定的事 | 生成的角色手册 · 共享信箱 · 决策收件箱 · 摘要 | 手册、信箱：已提供 · 收件箱、摘要：Coming soon |
| 14 | 基础层 | 其余一切的底座 | 纯文件 · 加锁的原子写入 · 工作进程日志 · 统一证据历史 | 文件、锁、日志：已提供 · 证据历史：Coming soon |

## ORCH-os 提供什么

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/orch-os-architecture-dark.svg">
    <img src="assets/orch-os-architecture-light.svg" alt="ORCH-OS 架构：代理命令行工具、角色租约、信箱、任务板与认领、合并闸门、Git worktree 中的工作进程" width="860">
  </picture>
</p>

下表区分当前 `main` 分支已有的命令、仍在审查中的改动和未来方向。“Coming soon”表示尚未发布。

### 工作流与任务分配

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 由纪元隔离的一位负责人及其租约 | `orch lease` | 已提供 |
| 独占任务认领和后台工作进程 | `orch task`、`orch worker` | 已提供 |

### 评审与合并闸门

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 检查 CI 与 PR 当前提交的评审 | `orch merge-gate` | 已提供 |
| 多个代理共用一个 GitHub 账号时使用评审评论 | `orch review`、`orch merge-gate --reviews comments --task ID` | 已提供 |
| PR 当前提交 CI 通过后启动一个非作者评审代理 | `orch review watch` | 已提供 |

评论模式是合作代理之间的流程闸门，不是安全边界：持有账号令牌的人可以用任何代理名发表评论。闸门只报告结果，不会合并 PR。

### 调度与存活状态

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 续约负责人租约、等待定向消息 | `orch lease renew`、`orch msg watch` | 已提供 |
| 安装操作系统定期任务 | `orch schedule` | 审查中（[PR #6](https://github.com/Acephalt-Inc/orch-os/pull/6)） |

### 资源

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 采样机器负载，并在配置的负载档位拒绝新工作进程 | `orch load`、`orch worker start` | 已提供 |

### 工作记录与日志

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 工作进程的输出和进程记录 | `orch worker`、`~/.orch/workers/` | 已提供 |
| 汇总任务结果的统一历史 | — | Coming soon |

### 代理通信

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 共享条目、定向消息和确认记录 | `orch mailbox`、`orch msg` | 已提供 |

### 配置档：账号与人数

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 单人和团队账号配置设计 | `docs/profiles.md` | 已提供 |
| 配置档命令和评审强度规则 | `orch profile`、`src/profile.ts` | 已提供 |

### 笔记生命周期

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 新增、搜索和退役文件笔记 | `orch mem` | 已提供 |

### 学习与改进

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 从已完成的工作中提出可复用经验 | — | Coming soon |

### 策略与批准

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 闸门通过前要求标签和针对当前提交的批准 | `orch merge-gate --label NAME` | 已提供 |
| 根据账号和人数配置档选择评审规则 | `src/profile.ts` | 已提供 |

### 目标与验证

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 检查本地运行前提 | `orch doctor` | 已提供 |
| 跟踪目标及完成条件 | — | Coming soon |

### 遥测与成本

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 读取本地负载采样 | `orch load` | 已提供 |
| 记录每项任务的成本 | — | Coming soon |

### 代理发现与隔离

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 发现已安装代理 CLI，并将工作进程放到独立 Git worktree | `orch agents`、`orch worker start --worktree` | 已提供 |
| 验证代理身份和沙箱边界 | — | Coming soon |

### 版本与配置

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 显示已安装版本与解析后的配置 | `orch --version`、`orch config` | 已提供 |

## 开始使用

在你的仓库里初始化 ORCH-os，然后让 Claude Code 或 Codex CLI 中的负责人会话和工作进程会话分别读取生成的角色文件：

```sh
cd /path/to/repository
orch init
orch doctor
orch lease acquire --session lead
orch task claim first-task --as w1
```

角色文件是 `~/.orch/handbook/lead-boot.md` 和 `~/.orch/handbook/worker-boot.md`。如何在两种代理中加载文件，请看[常见问题](docs/faq.md)。临时安装时，把 `orch` 换成 `npx orch-os`。

## 命令

```sh
orch init                                   # 创建配置、信箱和角色手册
orch agents                                 # 查看已发现和已配置的代理 CLI
orch doctor                                 # 检查运行前提
orch load                                   # 记录一次新的负载采样（就绪检查要求采样不超过 120 秒）
orch doctor --ready --agent claude          # 打印 worker start 必须通过的检查；有一行不是 OK 即 NOT READY（退出码 1）
orch lease status                           # 查看负责人租约
orch lease acquire --session lead           # 获取负责人租约
orch mailbox read                           # 读取共享信箱
orch msg send QUESTION --as w1 --to lead -m "需要决定"  # 发送定向问题
orch msg read --as lead                     # 读取负责人的待处理消息
orch task claim first-task --as w1          # 独占认领任务
orch worker start w1 --agent claude --worktree --task task.md  # 启动后台工作进程；就绪检查为 NOT READY 时拒绝（退出码 2）
orch worker list                            # 查看工作进程
orch merge-gate 101 --fixture approved      # 使用离线样例试运行闸门
orch load                                   # 采样机器负载
orch mem search review                      # 搜索长期笔记（没有匹配时退出码为 1）
```

不带 `--force` 的每一次 `orch worker start`，无论是否在终端中，都会先运行就绪检查。刚执行完 `orch init` 时，上面的启动命令会被拒绝，输出 `worker: readiness failed: ...`（退出码 2）。`orch doctor --ready --agent claude` 输出 `ready-for-live: READY` 后，此命令可以通过准入，但工作进程名称重复或档案工作进程上限仍可拒绝启动。就绪检查要求：工作进程和 `[review.agents.NAME]` 评审者的可执行文件名为 `claude` 或 `codex` 且已登录，已设置 `[merge] repo = "owner/name"`，工作目录是带 `origin` 的 Git 仓库，`gh` 已登录，已安装 `timeout` 或 `gtimeout`，并且 `orch load` 在 120 秒内运行过。其他代理 CLI 或包装命令显示为 `UNVERIFIED` 并被拒绝；在终端中加 `--force` 可以带警告启动。

完整参数和退出码见[命令参考](docs/commands.md)。

## 为多代理协作而建

上面的子系统建立在几条不变式上。每条都写明由哪个机制执行。

| 不变式 | 执行机制 | 状态 |
|---|---|---|
| 同一时间只有一位负责人。新持有者会让纪元加一，被隔离的旧持有者续期会被拒绝。 | `orch lease` | 已提供 |
| 每个任务只有一个归属者。已认领的任务在释放或到期前不能被他人拿走。 | `orch task` | 已提供 |
| 消息是数据，不是授权。发送者和类型存在正文之外，正文无法伪造它们。 | `orch msg` | 已提供 |
| 批准绑定到提交。只有 PR 当前提交上的评审、且该提交 CI 通过后才算数。 | `orch merge-gate` | 已提供 |
| 闸门只报告，由人合并。没有任何 `orch` 命令会合并 PR。 | `orch merge-gate` | 已提供 |
| 评审者强度明确。每位评审者相对作者分级（不同厂商、不同账号，或同一代理的全新上下文）；设置了档案时，不会用更弱的评审者顶替，而是直接阻塞。厂商和账号是声明值，未经核验。 | `orch review watch`、`orch profile` | 已提供 |
| 未知即关闭。缺失或无法识别的风险档一律按高风险处理。 | `orch profile` | 已提供 |
| 保护机器，从不杀掉工作。负载高时拒绝新工作进程，正在运行的不动。 | `orch load`、`orch worker start` | 已提供 |
| 清理从不毁掉工作。只有 Git 报告没有改动、未跟踪或被忽略的文件时才删除 worktree。 | `orch worker stop` | 已提供 |
| 知识被取代，而不是被删除。退役一条笔记会记录继任者并保留文件。 | `orch mem retire` | 已提供 |
| 每个任务都有记录在案的终态；“未知”是一种状态，不是猜测。 | 运行历史 | Coming soon |
| 学习者不给自己打分。学习过程不能修改衡量它的检查。 | 学习与度量 | Coming soon |

## 文档

- [概念](docs/concepts.md) — 角色、租约、消息、认领、工作进程和笔记。
- [命令](docs/commands.md) — 子命令、参数、退出码和配置。
- [配置档](docs/profiles.md) — 设计稿（尚未实现）：按账号与人员划分的配置档、按风险档位的评审策略、每次判定报告实际达到的评审强度。
- [常见问题](docs/faq.md) — Claude Code 与 Codex CLI 的设置、GitHub 身份和常见疑问。
- [架构](docs/architecture.md) — 模块、本地状态文件和进程模型。
- [迁移](docs/migration.md) — 从 v1.1 迁移到 v2。
- [测试对应表](docs/tests-map.md) — v1.1 与 v2 测试的对应关系。
- [演示](docs/DEMO.md) — 离线演示脚本。

## 许可证

ORCH-os 源码公开(source-available)。你可以在以下两份许可证中任选一份适合你的来使用([LICENSE](LICENSE)):

- **个人:免费。** 个人的非商业使用(学习、业余项目、研究)免费,依据 [PolyForm Noncommercial License 1.0.0](LICENSE-NONCOMMERCIAL)。
- **公司:内部使用免费。** 任何公司或组织都可以在自己内部使用,包括作为本团队的工程工具,依据 [PolyForm Internal Use License 1.0.0](LICENSE-INTERNAL-USE)。
- **未取得商业许可不得:** 出售 ORCH-os、把它作为服务托管给他人,或把它做进你提供给他人的产品。商业许可:winnicent.zuo@acephalt.com。

以上仅为便于理解的摘要;以两份许可证原文为准。

另见 [NOTICE](NOTICE) 和 [AUTHORS](AUTHORS)。参与贡献请先读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CLA.md](CLA.md)。

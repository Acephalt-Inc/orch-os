<h1 align="center">ORCH-os</h1>

<p align="center">为命令行编程代理提供团队协作层。</p>

<p align="center"><a href="docs/concepts.md">文档</a> · <a href="docs/commands.md">命令</a> · <a href="docs/faq.md">常见问题</a> · <a href="README.md">English</a></p>

<p align="center">
  <a href="https://github.com/Acephalt-Inc/orch-os/actions/workflows/ci.yml"><img src="https://github.com/Acephalt-Inc/orch-os/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a>
  <a href="https://www.npmjs.com/package/orch-os"><img src="https://img.shields.io/npm/v/orch-os" alt="npm 版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20dual-blue" alt="PolyForm 双许可证"></a>
</p>

ORCH-os 协调同一仓库中的多个命令行编程代理。由租约确定的负责人、共享信箱、支持独占认领的任务板、基于评审的合并闸门和后台工作进程，为团队提供共同的运行层。它与 Claude Code、Codex CLI 等命令行代理配合使用。

作者：Winnicent Zuo

## 安装

需要 Node.js 20 或更高版本，以及 macOS 或 Linux。可以全局安装 `orch`，也可以用 `npx` 临时运行：

```sh
npm i -g orch-os
# 或：npx orch-os init
```

## 为什么选择 ORCH-os

- **一位负责人：** 角色租约记录持有者，并用纪元隔离失去租约的旧持有者。
- **明确归属：** 每个任务在释放或到期前只有一个认领者。
- **等待处理的消息：** 定向问答有每位读者自己的游标和确认记录。
- **共享上下文：** Markdown 信箱和生成的角色手册让团队状态可见。
- **独立工作区：** 工作进程可在各自的 Git worktree 和分支中运行。
- **只看当前提交的评审：** 合并闸门检查 PR 当前提交的 CI 与非作者批准。
- **长期笔记：** 规则与经验保存在文件中；退役不会抹去历史。

## ORCH-os 提供什么

下表区分当前 `main` 分支已有的命令、仍在审查中的改动和未来方向。“规划中”表示类别，不表示已有对应命令。

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
| 汇总任务结果的统一历史 | — | 规划中 |

### 代理通信

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 共享条目、定向消息和确认记录 | `orch mailbox`、`orch msg` | 已提供 |

### 配置档：账号与人数

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 单人和团队账号配置设计 | `docs/profiles.md` | 已提供 |
| 配置档命令和评审强度规则 | `orch profile`、`src/profile.ts` | 审查中（[PR #7](https://github.com/Acephalt-Inc/orch-os/pull/7)） |

### 笔记生命周期

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 新增、搜索和退役文件笔记 | `orch mem` | 已提供 |

### 学习与改进

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 从已完成的工作中提出可复用经验 | — | 规划中 |

### 策略与批准

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 闸门通过前要求标签和针对当前提交的批准 | `orch merge-gate --label NAME` | 已提供 |
| 根据账号和人数配置档选择评审规则 | `src/profile.ts` | 审查中（[PR #7](https://github.com/Acephalt-Inc/orch-os/pull/7)） |

### 目标与验证

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 检查本地运行前提 | `orch doctor` | 已提供 |
| 跟踪目标及完成条件 | — | 规划中 |

### 遥测与成本

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 读取本地负载采样 | `orch load` | 已提供 |
| 记录每项任务的成本 | — | 规划中 |

### 代理发现与隔离

| 功能 | 命令或文件 | 状态 |
|---|---|---|
| 发现已安装代理 CLI，并将工作进程放到独立 Git worktree | `orch agents`、`orch worker start --worktree` | 已提供 |
| 验证代理身份和沙箱边界 | — | 规划中 |

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
orch lease status                           # 查看负责人租约
orch lease acquire --session lead           # 获取负责人租约
orch mailbox read                           # 读取共享信箱
orch msg send QUESTION --as w1 --to lead -m "需要决定"  # 发送定向问题
orch msg read --as lead                     # 读取负责人的待处理消息
orch task claim first-task --as w1          # 独占认领任务
orch worker start w1 --agent claude --worktree --task task.md  # 启动后台工作进程
orch worker list                            # 查看工作进程
orch merge-gate 101 --fixture approved      # 使用离线样例试运行闸门
orch load                                   # 采样机器负载
orch mem search review                      # 搜索长期笔记
```

完整参数和退出码见[命令参考](docs/commands.md)。

## 为多代理协作而建

- **负责人和工作进程角色：** 生成的手册提供各自的启动协议；CLI 记录负责人租约与任务认领。
- **定向协调：** `msg` 支持分类消息、确认和等待答复；`mailbox` 保存共享条目。
- **工作进程控制：** 后台进程有日志；安装 `timeout` 或 `gtimeout` 后可设置时限；可选 Git worktree 隔离文件改动。
- **由人控制合并：** `merge-gate` 只报告评审条件是否通过，不会合并 PR。
- **单账号评审流程：** `orch review approve` 发布评审评论，`orch merge-gate --reviews comments --task ID` 根据当前提交和任务持有者核查评论。

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

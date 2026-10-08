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

一个编码代理只需要一段提示词。一组代理需要一个运行层：有人负责，每项工作只有一个归属者，消息能送达并得到回复，合并要等作者以外的人评审，笔记在会话结束后仍然保留。ORCH-os 用一组操作本地纯文件的命令提供这一层。代理账号由你提供，最终是否接受和合并由你决定。

## ORCH-os 提供什么

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/orch-os-architecture-dark.svg">
    <img src="assets/orch-os-architecture-light.svg" alt="ORCH-OS 架构：代理命令行工具、角色租约、信箱、任务板与认领、合并闸门、Git worktree 中的工作进程" width="860">
  </picture>
</p>

### 工作流与任务分配

| 功能 | 命令或文件 |
|---|---|
| 由纪元隔离的一位负责人及其租约 | `orch lease` |
| 独占任务认领和后台工作进程 | `orch task`、`orch worker` |

### 评审与合并闸门

| 功能 | 命令或文件 |
|---|---|
| 检查 CI 与 PR 当前提交的评审 | `orch merge-gate` |
| 多个代理共用一个 GitHub 账号时使用评审评论 | `orch review`、`orch merge-gate --reviews comments --task ID` |
| PR 当前提交 CI 通过后启动一个非作者评审代理 | `orch review watch` |

评论模式是合作代理之间的流程闸门，不是安全边界：持有账号令牌的人可以用任何代理名发表评论。闸门只报告结果，不会合并 PR。

### 租约续期与等待

| 功能 | 命令或文件 |
|---|---|
| 续约负责人租约、等待定向消息 | `orch lease renew`、`orch msg watch` |

### 资源

| 功能 | 命令或文件 |
|---|---|
| 采样机器负载，并在配置的负载档位拒绝新工作进程 | `orch load`、`orch worker start` |

### 日志

| 功能 | 命令或文件 |
|---|---|
| 工作进程的输出和进程记录 | `orch worker`、`~/.orch/workers/` |

### 代理通信

| 功能 | 命令或文件 |
|---|---|
| 共享条目、定向消息和确认记录 | `orch mailbox`、`orch msg` |

### 本地配置

| 功能 | 命令或文件 |
|---|---|
| 声明的评审背景：你自己写的账号、厂商和队友标签。只是声明，未经核验 | `config.toml` 中的 `[profile]`、[docs/profiles.md](docs/profiles.md) |
| 查看和修改配置档；按作者声明的账号和厂商给每条评审打标签 | `orch profile` |

### 笔记生命周期

| 功能 | 命令或文件 |
|---|---|
| 新增、搜索和退役文件笔记 | `orch mem` |

### 策略与批准

| 功能 | 命令或文件 |
|---|---|
| 闸门通过前要求标签和针对当前提交的批准 | `orch merge-gate --label NAME` |
| 选用 `human-merge` 示例策略：你要求的评审标签，且每次合并都由人执行 | `orch profile update --policy human-merge` |

### 本地检查

| 功能 | 命令或文件 |
|---|---|
| 检查本地运行前提 | `orch doctor` |

### 负载采样

| 功能 | 命令或文件 |
|---|---|
| 读取本地负载采样 | `orch load` |

### 代理发现与 worktree

| 功能 | 命令或文件 |
|---|---|
| 发现已安装代理 CLI，并将工作进程放到独立 Git worktree | `orch agents`、`orch worker start --worktree` |

### 版本与配置

| 功能 | 命令或文件 |
|---|---|
| 显示已安装版本与解析后的配置 | `orch --version`、`orch config` |

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

上面的命令执行几条规则。每行写明由哪个命令执行。这些是同一台机器上合作代理之间的规则，不是沙箱：有 shell 权限的代理可以写到自己的 worktree 之外，账号和厂商名称只是声明，未经核验。

| 规则 | 执行命令 |
|---|---|
| 同一时间只有一位负责人。新持有者会让纪元加一，被隔离的旧持有者续期会被拒绝。这项检查只对调用 `orch` 的一方生效，不会停止不调用它的进程。 | `orch lease` |
| 每个任务只有一个归属者。已认领的任务在释放或到期前不能被他人拿走。认领到期不会停止原持有者的进程，也不会阻止它写入 Git。 | `orch task` |
| 消息是数据，不是授权。发送者和类型存在正文之外，正文无法伪造它们。 | `orch msg` |
| 批准绑定到提交。只有 PR 当前提交上的评审、且该提交 CI 通过后才算数。 | `orch merge-gate` |
| 闸门只报告，由人合并。没有任何 `orch` 命令会合并 PR。 | `orch merge-gate` |
| 评审标签明确。每位评审者按声明的表格相对作者打标签（不同厂商、不同账号，或同一账号的全新上下文）；设置了配置档时，不会用低于 `required_review` 的评审者顶替，而是直接阻塞。标签不代表评审质量。 | `orch review watch`、`orch profile` |
| 未知即关闭。缺失或无法识别的风险档一律按高风险处理；为已移除的内置策略表编写的配置档会被拒绝，不会被自动转换。 | `orch profile` |
| 保护机器，从不杀掉工作。负载高时拒绝新工作进程，正在运行的不动。 | `orch load`、`orch worker start` |
| 清理从不毁掉工作。只有 Git 报告没有改动、未跟踪或被忽略的文件时才删除 worktree。 | `orch worker stop` |
| 知识被取代，而不是被删除。退役一条笔记会记录继任者并保留文件。 | `orch mem retire` |

## 文档

- [概念](docs/concepts.md) — 角色、租约、消息、认领、工作进程和笔记。
- [命令](docs/commands.md) — 子命令、参数、退出码和配置。
- [配置档](docs/profiles.md) — 声明的评审背景、`human-merge` 示例策略、每次判定报告的评审标签，以及如何迁移为已移除的内置策略表编写的配置档。
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

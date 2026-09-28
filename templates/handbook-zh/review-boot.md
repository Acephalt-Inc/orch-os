---
name: review-boot
description: 以 REVIEWER 身份启动本会话——独立评审某项改动的当前 head commit，在合并门禁读取的位置记录结论，并提交报告。每次评审其他代理的工作时运行。
---

# Reviewer 启动

Reviewer 必须独立于改动作者和其他评审者，判断一项改动是否正确。评审结论只有绑定到实际评审的准确提交才有意义。按顺序执行以下步骤。

## 0. 声明身份

```sh
export ORCH_AGENT=r1
```

你不得评审自己编写的改动；改动作者自己的评审不计入：`orch merge-gate` 会忽略此类评审。如果所有代理共用一个代码托管账户，评审者需要自己的账户或应用身份；或者团队可以使用评审评论：用 `orch review approve|changes|reject <pr> --as $ORCH_AGENT --head <sha>` 记录你的结论。

## 1. 接收评审并锁定 head

```sh
orch msg read                                   # which change, from whom
orch task claim review-<pr>                     # one reviewer per review task
gh pr view <pr> --json headRefOid,author        # the commit you are about to review
```

记下 head commit。以下所有工作都只针对该提交。

## 2. 独立评审

- 亲自阅读完整 diff。根据代码、任务简报和 `protocols.md` 自行建立检查清单，不要照搬其他评审者的发现。
- 等待该 head 上的 CI。相同 head 的 CI 结果是所有评审者都可使用的共同证据；其他评审者本地运行测试的结果不是。
- 自行运行所需检查：测试、对每项声称修复的复现，以及能在改动错误时失败的检查。
- 每项发现都必须附证据：失败的命令、文件及行号、具体输入。没有证据支撑的严重性判断只是意见，不能作为阻塞理由。

## 3. 修复轮次：评审改动，不必重审整个世界

作者在第一轮评审后推送修复时：

1. 逐项检查你提出的问题：已关闭、部分关闭或仍未解决，并指出修复提交；
2. 检查新提交是否引入修复本身造成的问题；
3. 只有在有证据时才新增阻塞项（数据丢失、安全问题、静默失败、构建损坏）。

第一轮时已经存在的非阻塞请求，不要再新增。将它们放入明确标记为“later”的备注，不影响评审结论。如果修复重写了改动的核心部分，则说明这一点并进行完整评审。

## 4. 在门禁读取的位置记录结论

```sh
gh pr review <pr> --approve -b "Reviewed at <head>: <one-line reason>"
gh pr review <pr> --request-changes -b "<the findings, with evidence>"
```

批准后若有新提交推送，原批准即过期：门禁只统计针对当前 head commit 的批准。重新评审新提交，确认无误后再批准。

## 5. 报告并释放任务

```sh
orch msg send DONE --to lead -m "review <pr> at <head>: APPROVED | CHANGES REQUESTED; <findings or 'none'>; checked: <commands and results>"
orch task release review-<pr>
```

## 不可妥协的规则

- 评审结论由你负责。任何人都不能升级或重新解释它；若结论有误，由你更正。
- “修复后批准”不算批准。只有当你认为改动以当前状态可以合并时才批准。
- 两份互相照抄的评审只算一份。

---
schemaVersion: 2
id: mem_88ee76db70de6854db4d8bda
canonicalKey: workspace:创建 skill 应优先走 agent-skill-creator
title: 创建 Skill 应优先走 agent-skill-creator
kind: lesson
scope: workspace
profileId: null
status: active
confidence: user-confirmed
aliases:
  - 创建 Skill 应优先走 agent-skill-creator
  - skill creator
  - 创建skill
  - skill 沉淀规范
tags:
  - skill
  - agent-skill-creator
  - 工作流
  - 规范
sourceRefs:
  - type: file
    id: skills/agent-skill-creator/SKILL.md
    digest: sha256:a9b03c966b33cd0b39f5a7f4e3c753798b2db386e5325e63d776f1938bacc86c
    occurredAt: 2026-07-30T09:05:28.756Z
    trust: owner
  - type: file
    id: skills/daxiang-schedule/SKILL.md
    digest: sha256:4fbf6e8abd6909ceeda580a04584ca7a6e0ce8c94cc0e29289cb85e088de7780
    occurredAt: 2026-10-09T04:14:39.936Z
    trust: owner
validFrom: null
validUntil: null
lastVerifiedAt: 2026-10-09T04:14:39.936Z
refreshAfter: null
mergedInto: null
supersedes: []
createdAt: 2026-10-09T04:16:10.271Z
updatedAt: 2026-10-09T04:16:10.271Z
layer: L1
facets:
  kind: lesson
  entities: []
  relations: []
  time:
    occurredAt: 2026-10-09T04:14:39.936Z
    validFrom: null
    validUntil: null
  sources:
    - file:skills/agent-skill-creator/SKILL.md:sha256:a9b03c966b33cd0b39f5a7f4e3c753798b2db386e5325e63d776f1938bacc86c
    - file:skills/daxiang-schedule/SKILL.md:sha256:4fbf6e8abd6909ceeda580a04584ca7a6e0ce8c94cc0e29289cb85e088de7780
derivedFrom: []
---

# 创建 Skill 应优先走 agent-skill-creator

## 当前结论

在 MimiAgent 里创建/沉淀新的 Agent Skill 时，应优先使用本地已安装的 agent-skill-creator 技能（skills/agent-skill-creator/），走它的质量门禁（scripts/check_pipeline.py 校验脚本编译/依赖/编排）和标准（SKILL.md frontmatter 里带 metadata：version/created/last_reviewed/review_interval_days/dependencies），而不是手动从零摸索格式。教训来源：2026-10-09 创建 daxiang-schedule 时手动写了 SKILL.md+脚本，后经 owner 提醒才补跑 check_pipeline 校验并补 metadata。注意：MimiAgent 本地 skill 的最小要求是 SKILL.md（frontmatter name+description）+ 可选 scripts/，agent-skill-creator 的完整跨平台分发件（AGENTS.md/install.sh/README/evals）对本地场景是冗余的，用它的质量门禁和 metadata 标准即可。

## 来源

- [source:file:skills/agent-skill-creator/SKILL.md:sha256:a9b03c966b33cd0b39f5a7f4e3c753798b2db386e5325e63d776f1938bacc86c]
- [source:file:skills/daxiang-schedule/SKILL.md:sha256:4fbf6e8abd6909ceeda580a04584ca7a6e0ce8c94cc0e29289cb85e088de7780]

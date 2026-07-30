---
name: research
description: Use when investigating a topic that requires evidence from multiple sources, comparing claims, or producing a conclusion backed by verifiable references
---

# Research

## Overview

Research is not search. You gather claims from multiple independent sources, cross-validate, identify conflicts, and produce a conclusion with traceable evidence. No conclusion without at least two independently confirming sources.

## When to Use

- Comparing competing claims or products
- Building a recommendation backed by data
- Investigating a problem where facts are disputed
- Owner asks "look into X" or "what do we know about Y"

**Don't use for:** Single-fact lookups ("what's the weather"), opinion questions, or anything answerable from Memory alone.

## Methodology

### 1. Define the Question
State the exact question in one sentence. If it has multiple parts, split them. Vague questions produce shallow answers.

### 2. Source Triage
| Tier | Type | Trust |
|------|------|-------|
| 1 | Primary (official docs, source code, raw data, research papers) | Highest |
| 2 | Secondary (respected analysis, industry reports, curated knowledge) | Moderate, cross-validate |
| 3 | Tertiary (blog posts, forums, aggregations) | Lowest, confirm with Tier 1-2 |

Prefer Tier 1. Never build a conclusion on Tier 3 alone.

### 3. Cross-Validation
- Every key claim needs at least 2 independent sources
- Track conflicts explicitly — don't silently pick a winner
- When sources disagree, state which you trust and why

### 4. Time Scoping
- Default to last 12 months for fast-moving topics (tech, AI, markets)
- For foundational topics, include original sources regardless of age
- State your date range in the output

### 5. Bias Check
Before concluding, ask:
- Am I only reading sources that agree with each other?
- Did I skip a major viewpoint?
- Is there a commercial incentive behind any source?

## Output Format

```markdown
## Question
[One sentence]

## Key Findings
- [Finding 1] — sources: [ref], [ref]
- [Finding 2] — sources: [ref], [ref]

## Conflicts & Uncertainty
- [Topic]: Source A says X, Source B says Y. Resolved by [reason].

## Sources
1. [Title] ([Tier 1/2/3]) — URL or reference
2. ...

## Answer
[Concise conclusion, no hedging. State confidence level if uncertain.]
```

## When to Stop

- All key claims have 2+ independent Tier 1-2 sources
- New sources are adding noise, not evidence
- Owner's question is answered
- You've spent 3 rounds without finding new Tier 1-2 data

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Accepting first answer | Cross-validate. First result is often wrong or biased. |
| Citing blogs as fact | Upgrade to official docs or data. |
| Hiding disagreement | Surface conflicts. Uncertainty is information. |
| Researching infinitely | Stop when evidence converges or plateaus. |

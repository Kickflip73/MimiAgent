---
name: web-research
description: Use when researching information that requires current internet data — news, recent events, live prices, latest documentation, or topics beyond your knowledge cutoff
---

# Web Research

## Overview

Extend your knowledge with live internet data. This is a source-gathering skill, not a reasoning skill — your job is to find, evaluate, and synthesize what's online, then deliver a conclusion grounded in that evidence.

## When to Use

- Question is about events after your knowledge cutoff
- Topic changes rapidly (prices, APIs, regulations, products)
- Owner asks for "latest", "current", "news about", or "what's happening with"
- Internal/private knowledge search is exhausted and the answer is public

**Don't use for:** Things already in your Memory, topics with known stable answers, or internal-only information.

## Search Strategy

### 1. Query Design
- Start with specific, narrow queries — broad searches return noise
- Use exact phrases in quotes for technical terms
- Add `site:` to scope to authoritative domains when known
- If first search returns nothing useful, change angle, not just keywords

### 2. Source Evaluation
Accept a result as evidence only when:
- **Attribution**: Author/organization is identifiable
- **Currency**: Published or updated within a relevant timeframe
- **Corroboration**: At least one other independent source agrees on the key claim
- **No obvious commercial or ideological conflict**

**Red flags**: No author, no date, sensational language, "sponsored" markers, circular citations.

### 3. Result Triage
```
Search results → Scan titles/snippets → Open promising 3-5 → Read → Extract claims
Don't open results beyond page 2 unless the first page was entirely wrong.
```

### 4. Cross-Reference
- Search with different terms to confirm the same finding
- If sources disagree, search specifically for the disagreement
- State contradictions in output with your resolution reasoning

## Synthesis Rules

- Lead with the conclusion, not the search process
- Every factual claim links to a specific source
- Distinguish fact from opinion: "X announced" vs "analyst Y believes"
- If you couldn't verify, say so: "Could not confirm from independent sources"

## Output Format

```markdown
## [Question]

### Answer
[1-3 sentence direct answer, with confidence level]

### Key Evidence
- [Claim] — [Source](URL), [date]
- [Claim] — [Source](URL), [date]

### Uncertainty / Conflicts
[If any sources disagree, state the conflict and your resolution]

### Sources
1. [Title] — [URL]
2. [Title] — [URL]
```

## Token & Context Budget

- Don't read full articles when snippets answer the question — save full reads for critical evidence
- Stop after 3 rounds of searches if findings converge
- If page requires login/paywall, note it and look for alternative sources

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Searching once and stopping | Cross-validate with different query angles |
| Trusting snippet text alone | Open and read the actual page for key claims |
| Accepting SEO spam as fact | Check attribution, date, and corroboration |
| Ignoring date of publication | State article dates. Old articles on fast-moving topics are misleading. |
| Scrolling past page 2 | Change query, don't scroll deeper. |

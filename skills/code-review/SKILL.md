---
name: code-review
description: Use when reviewing code changes before merge or deployment — covers bug detection, security vulnerabilities, test coverage gaps, and architectural risks
---

# Code Review

## Overview

Review code changes systematically: bugs first, then security, then tests, then style. Don't narrate every diff — focus on what will break or be exploited.

## When to Use

- Before merging a PR or branch
- When asked "review this code" or "check for issues"
- Before deploying to production
- After significant refactoring

**Skip when:** One-line typo fixes, dependency version bumps with changelog confirmation, or generated code you didn't author.

## Review Order (Strict)

```
1. Logic bugs (incorrect behavior, edge cases, race conditions) — highest priority
2. Security (injection, auth bypass, secret exposure, unsafe deserialization)
3. Test coverage (missing cases for changed paths, boundary conditions)
4. Error handling (swallowed exceptions, ambiguous messages, missing cleanup)
5. Architecture/design (circular deps, wrong abstraction, N+1 queries)
6. Style/naming (lowest priority — only flag if actively harmful)
```

**Stop after 3 rounds.** If the same issue class reoccurs, flag it as systemic and move on.

## How to Review

### 1. Scope First
```
inspect_changes → understand what changed and why
Read related tests to understand expected behavior
Check if the change matches what the commit/PR claims
```

### 2. Bug Detection Patterns
- **Null/empty handling**: What happens when input is missing?
- **Concurrency**: Shared mutable state across goroutines/threads?
- **Off-by-one**: Loop boundaries, slice indices, string lengths
- **Time**: Clock-dependent logic, expiration, TTL without margin
- **State**: Is cleanup guaranteed on every exit path?

### 3. Security Patterns
- **Injection**: User input reaching SQL/Shell/HTML/JSON without sanitization
- **Secrets**: Hardcoded keys, tokens in logs, .env committed
- **Auth**: Missing permission checks on new endpoints
- **Deserialization**: Untrusted data feeding unmarshal/parse
- **Dependencies**: New transitive deps, version drift, known CVEs

### 4. Test Gap Detection
- New code paths without corresponding test cases
- Boundary values not exercised (empty, max, null, negative)
- Error paths stubbed but not triggered
- Mocks hiding real failure modes

## Output Format

```markdown
## Review: [branch/PR name]

### Critical (must fix before merge)
- [file:line] What breaks + how to reproduce
- [file:line] Security vulnerability + attack vector

### Important (should fix)
- [file:line] Missing test for [condition]
- [file:line] Error swallowed without log

### Advisory (consider)
- [file:line] N+1 query pattern
- Architectural observation

### Verified Safe
- [file:line] — change is correct because [evidence]
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Reviewing style before logic | Follow the order: bugs → security → tests → design → style |
| Reviewing file-by-file in isolation | Trace data flow across files |
| Flagging every style nit | Only flag style that causes confusion or bugs |
| Trusting test names | Read test assertions — names lie |
| Skipping dependency changes | New deps are the #1 supply chain risk |

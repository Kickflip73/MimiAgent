---
name: computer-use
description: Use when a task requires operating a macOS application GUI directly — filling forms, clicking buttons, reading screens, or navigating native app windows that Shell, Browser, or API tools cannot reach
---

# Computer Use

## Overview

Operate macOS applications through screen observation and simulated input. This is the last-resort path — use only when Shell, Browser, Connector, Shortcuts, or an official API cannot complete the work.

## When to Use

- Native macOS app with no API, CLI, or Browser equivalent
- Multi-window workflows where window context matters
- Accessibility-element-level interaction (buttons, menus, text fields)
- Dialog or system prompt that blocks other tools
- Post-action visual verification (did the UI actually change?)

**Don't use for:** Anything achievable through Shell, Browser navigation, or Connector capabilities. Always check those first.

## Rules

### Observe → Act → Verify
Never chain actions without observing. One action, one observation, one confirmation. If the observation doesn't match expectation, stop and diagnose — don't retry blindly.

### Background Execution
All Computer Use runs in the background by default. Don't steal keyboard/mouse focus. Window-local actions only — don't interact with elements outside the target window unless the task demands it.

### Scope Discipline
Only interact with what the task requires. If the task is "check the notification in Slack," don't also read other channels. If you notice unrelated issues, flag them but don't act.

### Post-Action Verification
After any write action (click, type, menu select), observe the screen to confirm the expected change occurred. "Action returned success" is not verification.

## Session Patterns

### Single Window
```
observe window → identify target element → act on element → observe result → verify
```

### Multi-Window
```
observe all windows → select correct one → bring to front → interact → verify
```

### Dialog Handling
```
detect dialog → read content → determine action (confirm/dismiss/input) → execute → verify dialog closed
```

### Accessibility Tree
Prefer accessibility-element interaction over pixel/screen coordinates. Use element labels, roles, and hierarchy. Fall back to window-local visual only when accessibility tree is unavailable or broken.

## Handoff to Owner

When owner needs to see, interact, or take over:
- Use explicit handoff: describe what's visible and what action is needed
- After handoff, re-observe to confirm the window is frontmost (`frontmost=true`)
- Process existence or launch signal is not evidence of visible delivery

## Quick Reference

| Situation | Action |
|-----------|--------|
| App not running | Launch it, wait for window, observe |
| Wrong window focused | Bring target window to front |
| Element not found in accessibility tree | Retry with visual fallback |
| Dialog blocking | Read dialog, decide action, execute |
| Action returned success but UI unchanged | Re-observe. If truly unchanged, diagnose before retrying. |
| Owner needs to see/interact | Handoff, then verify frontmost |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Retrying a failed action without diagnosis | Observe first. Determine why it failed. Then decide. |
| Assuming "launched" = "ready" | Wait for window to appear and stabilize. |
| Interacting with background windows | Always verify target window is frontmost or explicitly scoped. |
| Using pixel coordinates over accessibility elements | Prefer labels, roles, and element IDs. Coordinates break on layout changes. |
| Doing extra tasks "while I'm here" | Stick to the requested scope. Flag unrelated issues, don't fix them. |

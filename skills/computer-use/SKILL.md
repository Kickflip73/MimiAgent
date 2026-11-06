---
name: computer-use
description: Use when a task requires operating a macOS application GUI directly — filling forms, clicking buttons, reading screens, or navigating native app windows that Shell, Browser, or API tools cannot reach
---

# Computer Use

## Overview

Operate macOS applications through screen observation and simulated input. Prefer official APIs, Browser DOM or dedicated business Connectors when they fit. Generic GUI writes use only computer_act; never bypass its boundaries with Shell, AppleScript or desktop Connector injection.

## When to Use

- Native macOS app with no API, CLI, or Browser equivalent
- Multi-window workflows where window context matters
- Accessibility-element-level interaction (buttons, menus, text fields)
- Dialog or system prompt that blocks other tools
- Post-action visual verification (did the UI actually change?)

**Don't use for:** Anything achievable through Shell, Browser navigation, or Connector capabilities. Always check those first.

## Rules

### Observe → Act → Verify
Use `computer_observe(app=...)` or the fresh `state` returned by `computer_act`. Every UI action must include that state's `viewRef`. The Host rejects stale, consumed, cross-run or geometrically changed views. Do not add an extra observation when the returned state is sufficient.

Use AX `elementIndex` from the referenced view when available. Coordinates are **pixels in that view's full-window screenshot** (`coordinateSpace=image_px`, `imageSize`), with a top-left origin. Never divide by Retina scale, add screen/window offsets, use AX frame coordinates, or reuse crop coordinates. Do not combine an element index with coordinates.

`screenshotScope=window` means the image contains the target window, with origin `(0,0)`, even when resized to a non-integer scale. Do not ask vision to reinterpret it as a full-screen image. Ask for the next target's coordinates in the initial observation. A click receipt confirms dispatch, not keyboard focus.

For keyboard shortcuts use `keys:["cmd","a"]` (Select All) or `keys:["Enter"]`; `keys:["cmd+a"]` is normalized by the Host. One call is one chord, not a sequence. Pixel `type_text` clicks its target before inserting, which can change an existing selection: when replacing text, confirm focus, select all and delete, then type and read back the actual field contents before submitting.

### Background Execution
Prefer background delivery. If a fresh readback confirms that a harmless navigation/focus action had no effect, do not repeatedly issue the same background click. When `availableDelivery` includes `foreground`, request `dispatch:"foreground"` for one bounded attempt, then check its result. This requests a transport mode, never grants permission: the Host still enforces current Run access and the same bound window. If foreground is unavailable, report the limitation. Never switch delivery after `action_uncertain`, or replay a potentially completed submission/transaction. Window-local actions only — don't interact with elements outside the target window unless the task demands it.

### Scope Discipline
Only interact with what the task requires. If the task is "check the notification in Slack," don't also read other channels. If you notice unrelated issues, flag them but don't act.

### Post-Action Verification
`delivery` confirms transport only. Use `verify: {role, identifier?, label?, equals}` on observe or act to compare the value of one uniquely identified semantic element. `verified=true` covers only that condition. Missing, ambiguous or truncated evidence is unavailable, not success. Visual/dynamic tasks still require actual image evidence; AX text cannot prove playback or animation.

An `action_uncertain` result permits only read-only diagnosis; never replay via a fresh view, another action kind, Connector or Shell. `no_progress` stops repeated unchanged actions. If a screenshot budget cannot support the action readback, the action is refused before dispatch.

The Computer uncertainty fence covers **all writes to the same window**, including other action kinds. Waiting does not automatically clear it. Report the preserved cause; do not promise that waiting or asking the user to click once will resolve an uncertain action.

## Session Patterns

### Single Window
```
observe window → identify target element → act on element → observe result → verify
```

### Multi-Window
```
observe app → select exact viewRef → interact within current authorization → verify
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
| Wrong window focused | Re-observe the intended app; foreground use requires current Run authorization |
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

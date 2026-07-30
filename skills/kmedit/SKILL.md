---
name: kmedit
description: Compatibility trigger for editing an existing 学城/KM document. Uses the official oa-skills citadel XML workflow; never the legacy km or kmedit CLI.
---

# 学城编辑 compatibility route

This Skill exists for the legacy `kmedit` trigger name. The executable route is
always the official Citadel CLI:

```bash
command -v oa-skills
oa-skills citadel listTools
oa-skills citadel getDocumentXml --contentId <id> --output <absolute-xml>
oa-skills citadel updateDocumentByXml --contentId <id> --file <absolute-xml> --step-version <version>
```

Do not execute `km`, `kmedit`, browser automation, or guessed 学城 endpoints.

For each edit:

1. Extract `contentId` from the user's `collabpage/<id>` or `page/<id>` URL.
2. Fetch fresh XML immediately before editing.
3. Preserve the root, `<km-title>`, existing `nodeId`, unrelated nodes,
   attributes, ordering, and styles.
4. Apply only the requested change to the local XML file.
5. Update with `updateDocumentByXml`, using the current step version.
6. Return the confirmed 学城 link from the tool receipt.

If `oa-skills` is missing or Citadel rejects the document type, report the
official capability as unavailable. Do not fall back to another execution
surface.

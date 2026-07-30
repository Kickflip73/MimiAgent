---
name: meituan-km
description: Use the official Citadel CLI for 学城/KM document search, read, create, edit, hierarchy, permissions, comments, attachments, versions, charts, and Drawio. Trigger for km.sankuai.com links, 学城, KM, collabpage, contentId, parentId, pageId, 知识库, or 文档 operations.
---

# Meituan 学城（official Citadel）

All 学城 operations use the official `oa-skills citadel` entrypoint. Do not call
`km`, `kmedit`, browser automation, or guessed HTTP endpoints.

## Preflight

Run once before the first operation:

```bash
command -v oa-skills
oa-skills citadel listTools
```

If `oa-skills` is absent, report that the official Citadel dependency is
unavailable. Do not silently switch to another route.

## IDs

Extract the numeric ID directly:

- `https://km.sankuai.com/collabpage/123` → `contentId=123`
- `https://km.sankuai.com/page/123` → `contentId=123`
- `https://km.sankuai.com/template-center/123` → `templateId=123`

## Common operations

```bash
# Read/search
oa-skills citadel getSimpleMarkdown --contentId <id>
oa-skills citadel getChildContent --contentId <id>
oa-skills citadel searchContent --keyword "<keyword>"

# Create from a local Markdown or XML file
oa-skills citadel createDocument --title "<title>" --file <absolute-file>

# Create under an explicitly named parent
oa-skills citadel createDocument --title "<title>" --file <absolute-file> --parentId <id>

# Edit an existing document
oa-skills citadel getDocumentXml --contentId <id> --output <absolute-xml>
oa-skills citadel updateDocumentByXml --contentId <id> --file <absolute-xml> --step-version <version>
```

Use `oa-skills citadel listTools` and the command's returned parameter errors as
the current capability contract for less common operations.

## Write rules

- Read the current document XML immediately before every edit.
- Preserve existing `nodeId`, structure, unrelated content, and `<km-title>`.
- Make the smallest requested change in a local file; pass substantial content
  through `--file`, never a large inline shell argument.
- Never use simplified Markdown output as the source for an XML overwrite.
- Create without `--parentId` or `--spaceId` when the user did not explicitly
  specify a location.
- Return the actual `contentId` and `https://km.sankuai.com/collabpage/<id>`
  from the successful receipt. A zero exit code without an ID/link is not proof
  of document creation.

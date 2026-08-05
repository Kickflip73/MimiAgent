---
name: docx
description: Use when creating, reading, editing, or analyzing Word documents (.docx) — generating reports, filling templates, extracting text, or manipulating document structure
---

# Word Documents (docx)

## Overview

Create, read, and modify `.docx` files using `python-docx`. This covers document generation from templates, text extraction, formatting, and structural manipulation.

## When to Use

- Generating reports, proposals, contracts, or formal documents
- Reading/extracting text, tables, or images from existing `.docx` files
- Filling document templates with data
- Batch editing document styles, headers, footers

**Don't use for:** Simple text files (use write_file), PDF output (use pdf skill), or Markdown rendering (keep it as .md).

## Quick Start

```python
from docx import Document

# Create
doc = Document()
doc.add_heading('Report Title', level=1)
doc.add_paragraph('Content here.')
doc.save('output.docx')

# Read
doc = Document('input.docx')
for p in doc.paragraphs:
    print(p.text)

# Template fill
doc = Document('template.docx')
for p in doc.paragraphs:
    if '{{NAME}}' in p.text:
        p.text = p.text.replace('{{NAME}}', 'Alice')
doc.save('filled.docx')
```

## Key Operations

| Task | Approach |
|------|----------|
| Create new document | `Document()` + `add_paragraph/add_heading/add_table` |
| Read text | Iterate `doc.paragraphs` / `doc.tables` |
| Add table | `doc.add_table(rows, cols)` |
| Headers/footers | `doc.sections[0].header.paragraphs[0]` |
| Images | `doc.add_picture('image.png')` |
| Styles | `paragraph.style = doc.styles['Heading 1']` |
| Template filling | Use `{{PLACEHOLDER}}` markers, find-and-replace |

## Installation

```bash
pip install python-docx
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Overwriting template with save | Always save to new file, not template |
| Forgetting to handle missing placeholders | Check placeholder exists before replacing |
| Adding content to wrong section | Verify `doc.sections[0]` is correct target |

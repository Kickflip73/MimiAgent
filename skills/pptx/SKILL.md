---
name: pptx
description: Use when creating, reading, or editing PowerPoint presentations (.pptx) — generating slide decks, modifying layouts, adding charts, or batch formatting slides
---

# PowerPoint Presentations (pptx)

## Overview

Create, read, and modify `.pptx` files using `python-pptx`. Covers slide generation, layout management, charts, tables, images, and speaker notes.

## When to Use

- Generating presentation decks from structured content
- Creating slides with charts and tables from data
- Batch formatting or rebranding existing decks
- Adding speaker notes programmatically
- Converting outlines to slides

**Don't use for:** Image-based slides (use image-gen skill), live presentations, or heavily animated effects.

## Quick Start

```python
from pptx import Presentation

# Create presentation
prs = Presentation()
prs.slide_width = 9144000  # 16:9 widescreen in EMU

slide = prs.slides.add_slide(prs.slide_layouts[1])  # Title and Content
slide.shapes.title.text = "Title"
slide.placeholders[1].text = "Bullet point"

prs.save('output.pptx')
```

## Key Operations

| Task | Approach |
|------|----------|
| Create deck | `Presentation()` |
| Read deck | `Presentation('input.pptx')` |
| Add slide | `prs.slides.add_slide(layout)` |
| Add table | `slide.shapes.add_table()` |
| Add chart | `slide.shapes.add_chart()` |
| Add image | `slide.shapes.add_picture()` |
| Speaker notes | `slide.notes_slide.notes_text_frame.text` |
| Change layout | Choose from `prs.slide_layouts[N]` |
| Slide dimensions | Set `prs.slide_width` and `prs.slide_height` (EMU units) |

## Installation

```bash
pip install python-pptx
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Wrong placeholder index | Inspect layout XML or test with index 0,1,2... |
| Text overflow | Check content length; split across slides if needed |
| EMU unit confusion | 1 inch = 914400 EMU; use helper: `Inches(1)` |
| Saving over template | Always save to new file |

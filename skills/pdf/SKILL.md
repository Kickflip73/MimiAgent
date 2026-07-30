---
name: pdf
description: Use when creating, reading, merging, splitting, or extracting content from PDF files — generating reports, filling forms, extracting text, or manipulating page structure
---

# PDF Documents

## Overview

Create, read, and manipulate PDF files. Use `reportlab` for generation (layout control), `pdfplumber` for extraction (text, tables), and `pypdf` for manipulation (merge, split, rotate).

## When to Use

- Generating PDF reports with precise layout (tables, headers, footers)
- Extracting text or table data from existing PDFs
- Merging multiple PDFs into one document
- Splitting PDFs into individual pages
- Rotating, cropping, or reordering pages
- Filling PDF form fields

**Don't use for:** Simple text output (use write_file or docx), image-heavy documents (consider pptx), or scanned PDF OCR (use specialized tools).

## Quick Start

```python
# Generate PDF
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
c = canvas.Canvas("output.pdf", pagesize=A4)
c.drawString(100, 750, "Hello World")
c.save()

# Extract text
import pdfplumber
with pdfplumber.open("input.pdf") as pdf:
    for page in pdf.pages:
        print(page.extract_text())

# Merge PDFs
from pypdf import PdfWriter, PdfReader
writer = PdfWriter()
for path in ["doc1.pdf", "doc2.pdf"]:
    writer.append(path)
writer.write("merged.pdf")
```

## Key Operations

| Task | Library | Approach |
|------|---------|----------|
| Generate new PDF | reportlab | `canvas.Canvas()` + `drawString/drawCentredString` |
| Generate table layout | reportlab | `Table(data)` with `TableStyle` |
| Extract text | pdfplumber | `page.extract_text()` |
| Extract tables | pdfplumber | `page.extract_tables()` |
| Merge PDFs | pypdf | `PdfWriter.append()` → `write()` |
| Split pages | pypdf | `PdfWriter.add_page(page)` per page |
| Rotate pages | pypdf | `page.rotate(angle)` |
| Fill forms | pypdf | `reader.get_fields()` → `writer.update_page_form_field_values()` |

## Installation

```bash
pip install reportlab pdfplumber pypdf
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Text clipped at page edges | Check margins; A4 content area is ~595×842 points with margins |
| Wrong library for task | reportlab = create, pdfplumber = read, pypdf = manipulate |
| Non-UTF8 text in reportlab | Register TTF fonts: `pdfmetrics.registerFont(TTFont(...))` |
| Merging preserves form data | Use `writer.add_page()` not `writer.append()` if stripping forms |

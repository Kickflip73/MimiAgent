---
name: xlsx
description: Use when creating, reading, editing, or analyzing Excel spreadsheets (.xlsx/.xls) — generating reports, data analysis, pivot tables, charts, or batch data processing
---

# Excel Spreadsheets (xlsx)

## Overview

Create, read, and modify `.xlsx` files using `openpyxl`. Covers formulas, formatting, charts, pivot tables, data validation, and batch processing.

## When to Use

- Generating structured data reports or exports
- Reading and analyzing spreadsheet data
- Creating charts and pivot tables programmatically
- Batch editing or formatting existing workbooks
- Data migration between systems via Excel

**Don't use for:** Simple CSV (use Shell), database queries (use db-query), or real-time data dashboards.

## Quick Start

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

# Create workbook
wb = Workbook()
ws = wb.active
ws.title = "Report"

# Write data
ws['A1'] = 'Name'
ws['A1'].font = Font(bold=True)
for i, item in enumerate(data, start=2):
    ws.cell(row=i, column=1, value=item)

# Read data
for row in ws.iter_rows(values_only=True):
    print(row)

wb.save('output.xlsx')
```

## Key Operations

| Task | Approach |
|------|----------|
| Create workbook | `Workbook()` |
| Read workbook | `load_workbook('file.xlsx')` |
| Formulas | `ws['B2'] = '=SUM(A1:A10)'` |
| Chart | `BarChart() + ws.add_chart()` |
| Pivot table | `pivot = PivotTable()` |
| Conditional formatting | `ConditionalFormatting()` |
| Data validation | `DataValidation()` |
| Merge cells | `ws.merge_cells('A1:C1')` |

## Installation

```bash
pip install openpyxl
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Not closing workbook after save | `wb.close()` after save, or use context manager |
| Overwriting existing data | Load first, then modify, save to new filename |
| Row/column index confusion | `cell(row=1, col=1)` = A1; rows and cols are 1-indexed |

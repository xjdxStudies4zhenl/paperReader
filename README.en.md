# Paper Reader

A local-first PDF reading & annotation desktop app built with **Electron + MySQL**.

## Features

- Import PDFs (file picker or drag & drop), de-duplicated by SHA-256, stored in a local library folder
- Library management: metadata, folders, tags, star rating, keyword search, reading progress
- Annotations: **highlight (incl. red)**, underline, strikethrough, rectangle, freehand pen, sticky notes
- Annotation side panel: grouped by page, filterable, searchable, jump-to-page, per-annotation comments/replies
- Export: annotation digest as Markdown, or a flattened "annotated PDF" with marks burned in (pdf-lib)
- All data lives in your own MySQL instance; connection password is encrypted with Electron safeStorage

## Quick start

```bash
npm install
npm run build
npm run app
```

On first launch, fill in MySQL host/port/user/password/database in the wizard; the app creates the
database (utf8mb4) and runs `electron/db/schema.sql` automatically.

CLI alternative:

```bash
npm run db:init -- --host=127.0.0.1 --port=3306 --user=root --password=yourpass --database=paper_reader
```

## Database naming convention

`pr_` (scope) + function name + `_info` (master data) or `_rd` (record data), e.g.
`pr_doc_info`, `pr_anno_info`, `pr_doc_tag_rd`, `pr_read_rd`, `pr_export_rd`.

See [README.md](README.md) (Chinese) for the full documentation, table list and screenshots.

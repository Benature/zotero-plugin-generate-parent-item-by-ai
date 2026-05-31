# Parent Item Generator

> A Zotero 9 plugin that uses AI to generate parent items for standalone PDF attachments.

[中文文档](README_zh-CN.md)

## Features

- Right-click any standalone PDF attachment → **Generate Parent Item**
- **Two-phase extraction** keeps costs low: Phase 1 uses only the filename; page text is extracted only when needed
- AI selects the best-fit Zotero item type automatically (journal article, book, report, thesis, …), or you can force a specific type
- Interactive preview: accept, improve with feedback, or cancel before writing anything to your library
- Fully configurable: system prompt and user prompt template are editable in the preferences panel

## Requirements

- Zotero 9

## How It Works

```
Right-click PDF
      │
      ▼
Phase 1 ── filename + title ──► LLM
      │
      ├─ metadata complete? ──► Preview dialog
      │                              │
      └─ incomplete ─► Phase 2       ├─ Accept ──► Create parent item
              │                      ├─ Improve ─► (page text extracted if
              │ first + last page     │             not yet) ──► LLM ──► Preview
              ▼                      └─ Cancel
            LLM ──► Preview dialog
```

**Phase 1** sends only the filename (and Zotero attachment title) to the LLM.
Metadata is considered complete when all of the following are present:
item type, title, date, at least one creator, and at least one institution-type
field (journal, publisher, university, institution, etc.).

**Phase 2** is triggered automatically when Phase 1 yields incomplete metadata.
Zotero's built-in PDF worker extracts the first and last page text, which is
then passed to the LLM together with the filename context.

**Improve** allows iterative refinement. If page text was not yet extracted
(Phase 1 was sufficient), it is extracted on demand before the improvement
call.

## Configuration

Open **Zotero → Preferences → Parent Item Generator**.

| Field | Description |
|---|---|
| Base URL | Root URL of an OpenAI-compatible API, e.g. `https://api.openai.com/v1` |
| API Key | Your API key |
| Model | Model name, e.g. `gpt-4o-mini` |
| Forced Item Type | Lock the Zotero item type; leave blank to let the AI decide |
| System Prompt | Override the built-in system instructions; empty = built-in default |
| User Prompt Template | Override the built-in user message; empty = built-in default |

Click **Test Connection** to verify that the Base URL and API Key are working.

### User Prompt Template Placeholders

| Placeholder | Replaced with |
|---|---|
| `{filename}` | PDF filename |
| `{firstPage}` | Extracted first-page text (empty string in Phase 1) |
| `{lastPage}` | Extracted last-page text (empty string in Phase 1) |
| `{itemTypes}` | All Zotero item types with their valid fields |
| `{forcedItemType}` | Instruction to use the forced item type (empty if not set) |

### Expected AI Output Format

The AI must return a single JSON object with the following structure.
Customized prompts must preserve this schema:

```json
{
  "itemType": "report",
  "fields": {
    "title": "...",
    "date": "2024-03",
    "institution": "..."
  },
  "creators": [
    { "creatorType": "author", "firstName": "", "lastName": "Zhang Wei" }
  ],
  "tags": [],
  "reason": ""
}
```

`reason` is shown in the preview dialog and appended to the `extra` field of
the created item.


## Migration from AI PDF Metadata Extractor

This plugin was previously named **AI PDF Metadata Extractor**
(`extensions.aiPdfMetadataExtractor.*`). Preference keys have moved to
`extensions.parentItemGenerator.*`. Old preferences are **not** migrated
automatically — re-enter your Base URL, API Key, and Model in the preferences
panel.

## Development

```bash
npm install
npm run build        # type-check + build XPI
npm run typecheck    # type-check only
```

The project follows the [`windingwind/zotero-plugin-template`](https://github.com/windingwind/zotero-plugin-template) layout:
static addon files under `addon/`, TypeScript source under `src/`.

### Hot Reload (dev server)

```bash
npm run dev

# macOS — if Zotero binary is not found automatically:
npm run dev:mac
# or
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/Applications/Zotero.app/Contents/MacOS/zotero npm run dev
```

### Release

```bash
npm run release
```

## License

AGPL-3.0-or-later

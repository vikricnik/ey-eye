# Extractable components

#### Layout Components (appear on the one page)

## TopBar
- Source: `web/src/App.tsx` (the `<header className="topbar">` block in the render section)
- Category: layout
- Description: App title + server URL + API/Ollama lights; toolbar with pipeline picker, ⚙ pipeline settings, unsaved dot, status chip, undo/redo, Save, File ▾, Aa
- Extractable props: pipelineName (string, default: "simple-local"), status (string, default: "saved"), dirty (boolean, default: false), apiOnline (boolean, default: true), ollamaOnline (boolean, default: true), pipelineSettingsOpen (boolean, default: false)
- Hardcoded: title text, button labels, icons (↶ ↷ ⚙ Aa), all CSS

## SettingsColumn
- Source: `web/src/editor/SettingsColumn.tsx`
- Category: layout
- Description: Column with a header (breadcrumb `pipeline › node` or `pipeline`, ✕ close) around the settings body
- Extractable props: pipeline (string, default: "simple-local"), subject (string, default: "node"), placement (string, default: "docked")
- Hardcoded: close glyph, CSS

## RunPanel
- Source: `web/src/ui/RunPanel.tsx`
- Category: layout
- Description: Right column with tabs Chat | Tests, a scrolling body and the message box footer
- Extractable props: activeTab (string, default: "chat"), running (boolean, default: false)
- Hardcoded: tab labels, CSS

#### Basic Components

## Section
- Source: `web/src/editor/Section.tsx`
- Category: basic
- Description: Foldable settings group with uppercase title and a one-line summary while folded
- Extractable props: title (string, default: "Model"), summary (string, default: "ollama:llama3 · T 0.2"), open (boolean, default: true)
- Hardcoded: chevron glyph, CSS

## MenuButton
- Source: `web/src/ui/Menu.tsx`
- Category: basic
- Description: Button with ▾ opening a menu of actions (label + detail line, separated danger item)
- Extractable props: label (string, default: "File"), open (boolean, default: false)
- Hardcoded: item labels and details, CSS

## ChipStatus
- Source: `web/src/App.tsx` (validationChip)
- Category: basic
- Description: Small uppercase status pill: saved / valid · unsaved / invalid · node / warnings
- Extractable props: kind (string, default: "ok"), text (string, default: "saved")
- Hardcoded: CSS

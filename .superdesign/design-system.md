# Design System — LLM Pipeline Builder (ey-eye web client)

## Product context
A local developer tool for building and tuning **LLM pipelines**: YAML-defined DAGs whose nodes are
model calls (Ollama, OpenAI, Anthropic, Gemini) wired by `depends_on` edges, with optional branches
(routes chosen by a node's output) and loops. One screen; the user is a developer who edits often.

**Key jobs**
1. Tune an existing pipeline: select a node, change its prompt / model / temperature, send a message,
   read the answer and each node's trace (what it received and replied), re-run from a node, repeat.
2. Build a pipeline: add nodes (blank or from presets), connect them, configure each node and the
   pipeline (output node, execution limits, conversation history, defaults for all nodes), save.
3. Debug a run: find the node that failed or answered wrong, fix it, retry.
4. Test: run test cases against the draft and compare models side by side.

**Screen inventory (what must stay reachable)**
- Pipeline identity & state: pipeline picker, unsaved marker, status chip (saved / valid · unsaved /
  invalid · node / N warnings), Save, undo/redo, File menu (New, Save as, Import YAML, Export YAML,
  Delete), display settings (theme, text size), server status (API, Ollama lights).
- Canvas (React Flow): node cards (id, model, temperature, status: running/done/failed, OUTPUT badge,
  context-usage line), dependency edges (branch edges labelled with their condition), + Add node
  palette, legend, zoom controls, minimap.
- Node settings (foldable sections): Trace, Model, Prompts, Input & output, Ollama options,
  Depends on, Routing, Presets; title actions: Re-run from here, Duplicate, Save as preset, ⋯
  (Rename, Delete).
- Pipeline settings (foldable sections): Output, Execution, Conversation history, Defaults for all
  nodes, Routing.
- Chat: conversation picker, transcript (message → collapsible "Trace · N nodes" → answer), toggles
  (format answers, open traces), message box with Send/Stop.
- Tests: test cases, run all, results grid, compare models.

## Visual style (keep)
Dark, technical, dense — a developer tool, not a marketing site.
- **Font:** JetBrains Mono for everything (400/500/600/700). No other fonts.
- **Type scale:** 11px uppercase labels/badges (letter-spacing 0.06–0.08em, weight 700) · 12px
  controls/hints · 13px body · 15px titles · 17px panel title. Nothing smaller than 11px.
- **Colors (dark, default):** background `#0B1220`; panels `#101A2E`; raised/inputs `#16223B`;
  borders `#22304C` (1px); text `#E6EDF5`; dim text `#7C8DA6`; faint (decoration only) `#4B5A78`;
  accent teal `#4FD1C5` (primary buttons, links, active tab underline, focus ring), accent-dim
  `#2B7A72`; valid `#34D399`; invalid `#F87171`; warn `#F5C061`; running `#60A5FA`;
  text on accent `#06201D`.
- **Colors (light theme):** background `#F3F5F9`; panels `#FFFFFF`; raised `#EDF1F6`; borders
  `#D3DAE4`; text `#142033`; dim `#4F5F77`; accent `#0A6A62`.
- **Shape:** radius 3px on controls, 6px on popovers/menus, 999px on pills. 1px borders; very little
  shadow except popovers (`0 8px 24px rgba(0,0,0,.5)`).
- **Buttons:** filled accent (primary, e.g. Save, Send), ghost (transparent + border), icon buttons
  (↶ ↷ ⚙ Aa ✕), text links in accent, danger in red. Uppercase small labels on buttons.
- **Status:** small uppercase pills/chips; pulsing blue dot while running; green ✓ done; red ✕ failed.
- **Graph:** dot-grid canvas; plain edges dim, branch edges teal (dashed, labelled), loop edges amber.

## Layout today
Top bar (full width) · workspace = canvas | settings column (380px, opens on selection, ✕ to close;
floats over the canvas when narrow) | run panel (420px, tabs Chat | Tests). Narrow (≤960px): stacked.

## Interaction patterns
- Foldable sections: uppercase title + one-line summary while folded; open/closed remembered.
- Selecting a node opens its settings; nothing else switches views automatically.
- Deletes don't ask — they offer Undo in a notice.
- Disabled controls say why (tooltip).
- Motion: 0.15s ease for chevrons/highlights; respect prefers-reduced-motion.

# UX Review — Web Client (`web/`)

- **Reviewed commit**: `7fe19a8` (`feature/yaml_based_pipelines`)
- **Date**: 2026-09-29
- **Review type**: UI/UX heuristic evaluation (Nielsen's 10 heuristics, UX laws, WCAG 2.2 contrast)

**Scope:** the React web client in `web/src`: the top bar, canvas, side panel
(Chat, Settings, Add, Messages, Tests), dialogs and display settings.

**How it was reviewed:**

- Read all of `web/src`.
- Ran the pipeline API (`:8000`) and the Vite dev server (`:5173`) and used the
  app in a browser at 1024×768 (light and dark themes) and 768×1024 (the
  stacked narrow layout).
- Measured the canvas zoom, the height of the settings panel and color
  contrast in the running page.
- Ollama was **not** running, so failure paths were observed but a successful
  streaming run was not (see [Not covered](#not-covered)).

---

## Summary

The client is solid underneath. It has real undo/redo, in-app dialogs with
inline validation, live server-side validation, a Run button that explains why
it's disabled, Esc to stop, reduced-motion support and ARIA tabs. The problems
are about **legibility and findability**, not behaviour:

- The canvas and most of the interface are set in very small type, and the
  faintest text color fails WCAG AA.
- Ollama being unreachable is only discovered when a run fails, and the
  failed message is lost.
- Pipeline-level settings are hidden behind an unlabeled gesture.
- Several actions are duplicated, share a name with a different action, or sit
  on the wrong tab.

Severity uses Nielsen's scale: **MAJOR** (3) causes real difficulty and should
be fixed soon; **MINOR** (2) is a low-priority fix; **SUGGESTION** is optional
polish.

## Metrics

| Severity   | Count |
|------------|-------|
| Major      | 5     |
| Minor      | 8     |
| Suggestion | 1     |

## Findings at a glance

| ID | Severity | Title |
|----|----------|-------|
| [UX-001](#ux-001-canvas-text-is-too-small-to-read-at-normal-window-sizes) | MAJOR | Canvas text is too small to read at normal window sizes — ✅ fixed |
| [UX-002](#ux-002-most-text-is-small-and-fails-contrast-minimums) | MAJOR | Most text is small and fails contrast minimums |
| [UX-003](#ux-003-an-unreachable-ollama-is-only-discovered-when-a-run-fails) | MAJOR | An unreachable Ollama is only discovered when a run fails |
| [UX-004](#ux-004-a-failed-run-discards-the-message-and-offers-no-retry) | MAJOR | A failed run discards the message and offers no retry |
| [UX-005](#ux-005-pipeline-settings-are-hard-to-find) | MAJOR | Pipeline settings are hard to find |
| [UX-006](#ux-006-two-run-buttons-with-different-meanings-on-the-tests-tab) | MINOR | Two Run buttons with different meanings on the Tests tab |
| [UX-007](#ux-007-the-toolbar-gives-ten-actions-equal-weight) | MINOR | The toolbar gives ten actions equal weight |
| [UX-008](#ux-008-node-settings-run-three-screens-long-and-repeat-actions) | MINOR | Node settings run three screens long and repeat actions |
| [UX-009](#ux-009-canvas-status-and-roles-are-hard-to-read-and-the-legend-is-on-the-wrong-tab) | MINOR | Canvas status and roles are hard to read, and the legend is on the wrong tab |
| [UX-010](#ux-010-one-concept-has-several-names-and-one-icon-has-two-meanings) | MINOR | One concept has several names, and one icon has two meanings |
| [UX-011](#ux-011-some-disabled-controls-give-no-reason) | MINOR | Some disabled controls give no reason |
| [UX-012](#ux-012-undo-exists-but-is-never-offered-after-a-delete) | MINOR | Undo exists but is never offered after a delete |
| [UX-013](#ux-013-on-narrow-screens-the-message-box-is-below-the-fold) | MINOR | On narrow screens the message box is below the fold |
| [UX-014](#ux-014-smaller-items) | SUGGESTION | Smaller items |

**Suggested order** (most payoff for the least effort first):

1. UX-002: point headings and hints at `--text-dim`. This is a small CSS change.
2. UX-004: put the message back in the box on failure and add Retry.
3. UX-005: add a gear button for pipeline settings.
4. UX-003: show one Ollama banner and block Run with that reason.
5. UX-008 and UX-012: remove the duplicated buttons and offer undo after deletes.
6. UX-001: this needs the most design work (card size, zoom floor, simpler
   cards when zoomed out).

---

## Findings

### UX-001: Canvas text is too small to read at normal window sizes

- **Severity**: MAJOR
- **Status**: ✅ Fixed (2026-09-29).
  - **Compact cards when zoomed out** ([zoomDetail.ts](web/src/editor/zoomDetail.ts),
    "Zoomed-out cards" in [style.css](web/src/style.css)). Below 0.85 × the
    display text size, a card shows only its id, model and a status mark:
    ✓ done, ✕ failed, a pulsing dot while running, nothing when idle. The
    text is scaled to cancel the zoom (`--node-text-scale`). At 1024×768 the
    node id now reads at **13px** on screen, up from 7.6px. The status word
    stays available to screen readers.
  - **Narrower cards**: 200px (was 220) and 230px sibling spacing (was 260).
    Auto-layout of the example now fits at zoom 0.74 (was 0.64). The status
    pill shows only the status word, so the id keeps its room; a node's run
    time moved to the meta line. Ids have a tooltip for when they're cut off.
  - **Fit floor**: fitting never zooms out below 0.4 × the text size, where
    compact text reaches its largest scale (2.5×). A very wide pipeline then
    extends past the edges. This is lower than the 0.85 suggested below:
    compact cards keep the text readable, so a floor that high would hide
    most of a wide graph for no gain.
  - **Handles**: an invisible 6px ring widens the area that picks them up,
    they grow to 14px on hover and as a connection's target, and they scale
    with compact text.
  - **Still small**: edge labels stay at 10px, scaled by the zoom. React
    Flow measures a label's background only when the label text changes, so
    scaling them needs custom edges with HTML labels (`EdgeLabelRenderer`).
    That's left as a follow-up.
- **Principle**: Legibility; Fitts's law; visual hierarchy (the primary object should be the easiest to read)
- **File(s)**:
  - [PipelineCanvas.tsx:50](web/src/editor/PipelineCanvas.tsx#L50)
  - [PipelineCanvas.tsx:136](web/src/editor/PipelineCanvas.tsx#L136)
  - [conversion.ts:45-47](web/src/editor/conversion.ts#L45-L47)
  - [style.css:377](web/src/style.css#L377)
  - [style.css:395-405](web/src/style.css#L395-L405)
- **Description**: Canvas cards use a fixed 12px font, and the view is
  fitted to the graph. At a 1024×768 window the side panel takes 440px, so
  fitting the four-node example (three siblings × 260px spacing) zooms the
  canvas to **0.64**. The measured transform was `scale(0.636)`.
  - Card titles render at about **7.6px**.
  - The model name (11px) and meta line (10px) render at about **6.4–7px**.
  - Status pills (9px) render at about **5.7px**.

  The cards are the main object in the app, yet they are the hardest thing on
  screen to read. The small connection handles (10px, also scaled) are hard
  to hit as well.
- **Recommendation**:
  - Narrow the cards and the spacing between them (for example 180px cards
    and about 210px sibling spacing) so wide levels need less zoom-out.
  - Don't let "fit to screen" zoom out below about 0.85. Scrolling around is
    better than unreadable text. Keep `minZoom` for manual zooming.
  - When zoomed out, show a simpler card (only the id and status, larger).
    React Flow's `useStore((s) => s.transform[2])` gives the current zoom.
  - Enlarge the handles on hover and while a connection is being dragged.

### UX-002: Most text is small and fails contrast minimums

- **Severity**: MAJOR
- **Principle**: WCAG 2.2 SC 1.4.3 Contrast (Minimum); visual hierarchy
- **File(s)**:
  - [style.css:8](web/src/style.css#L8) (`--text-faint`, dark)
  - [style.css:46](web/src/style.css#L46) (`--text-faint`, light)
  - [style.css:73](web/src/style.css#L73) (base font size)
  - [style.css:283-290](web/src/style.css#L283-L290) (section headings)
  - [style.css:492](web/src/style.css#L492) (kicker)
  - [style.css:501](web/src/style.css#L501) (field hints)
  - [style.css:463-475](web/src/style.css#L463-L475) (status pills)
- **Description**:
  - **Size.** The base font is 12px (`0.75rem`) monospace. There are 23
    declarations at 10px (`0.625rem`) and 8 at 9px (`0.5625rem`), most of
    them uppercase with extra letter spacing, which makes small text harder
    still to read.
  - **Contrast.** `--text-faint` is used for section headings, the
    "NODE"/"PIPELINE" kicker, field hints, placeholders, the chat empty state
    and idle status pills. Measured ratios (AA needs 4.5:1):

    | Where | Ratio |
    |---|---|
    | Dark: `--text-faint` on panel | 2.51:1 |
    | Dark: `--text-faint` on raised surface (idle pill, disabled button) | 2.29:1 |
    | Light: `--text-faint` on panel | 3.41:1 |
    | Light: `--text-faint` on raised surface | 3.01:1 |

  - **Hierarchy.** Section headings ("DEPENDS ON", "ROUTING", "PRESETS") use
    the faintest color on the page. They should organise the panel, but they
    are the hardest text in it to see.
- **Recommendation**:
  - Raise the base font to 13–14px and don't set any text below 11px.
  - Use `--text-dim` for headings, hints and kickers. A `--text-faint` that
    passes AA (about `#7A8BA6` dark, `#5E6D84` light) ends up almost the
    same as `--text-dim`, so keep `--text-faint` only for decoration that
    doesn't need to be read (dividers, grid dots).
  - Consider a proportional sans-serif font for interface text and prose
    (hints, descriptions, chat answers), and keep monospace for ids, prompts,
    model names and code.

### UX-003: An unreachable Ollama is only discovered when a run fails

- **Severity**: MAJOR
- **Principle**: H1 Visibility of system status; H5 Error prevention; WCAG 1.4.1 Use of Color
- **File(s)**:
  - [App.tsx:168-174](web/src/App.tsx#L168-L174)
  - [App.tsx:927-931](web/src/App.tsx#L927-L931)
  - [App.tsx:1060-1063](web/src/App.tsx#L1060-L1063)
  - [fields.tsx:205-211](web/src/editor/fields.tsx#L205-L211)
- **Description**: With Ollama stopped:
  - The header status dot stays **green**, because it only tracks the
    pipeline API. It also has no text, only a color and a `title`.
  - The only hint is three amber lines repeated under every model dropdown
    (node settings, pipeline defaults, the judge model, each Tests comparison
    row): "Ollama server unreachable…", "This model isn't
    installed/allowlisted…", "The server lists no selectable models."
  - Run stays enabled. Pressing it fails with *"Node 'clasify' failed:
    ollama:llama3 failed: All connection attempts failed"*.

  The client already knows the cause: `GET /v1/models` returns
  `providers[].reachable` and `error`.
- **Recommendation**:
  - Show two status indicators, **API** and **Ollama**, each with a text
    label or icon as well as a color, and a tooltip with the URL and error.
  - When Ollama is unreachable, show one banner: "Ollama isn't reachable at
    http://localhost:11434 — runs will fail. [Retry]". Retry calls
    `refreshModels(true)`.
  - Add the case to `runDisabled`, e.g. "Ollama is unreachable". Only
    block Run when every model the pipeline uses is on an unreachable
    provider.
  - Collapse the per-dropdown warnings to a single short line such as
    "model list unavailable".

### UX-004: A failed run discards the message and offers no retry

- **Severity**: MAJOR
- **Principle**: H3 User control and freedom; H9 Help users recognize, diagnose and recover from errors
- **File(s)**:
  - [Chat.tsx:193-198](web/src/run/Chat.tsx#L193-L198)
  - [Chat.tsx:51-55](web/src/run/Chat.tsx#L51-L55)
  - [App.tsx:804-813](web/src/App.tsx#L804-L813)
- **Description**: The message box clears when a message is sent. If the run
  fails or is stopped, the text is gone. The error box shows the server's
  message and a reference id but has no action, so retrying means retyping.
  The message is also raw ("All connection attempts failed") and doesn't say
  what to do next.
- **Recommendation**:
  - On `error` or `stopped`, put the prompt back into the message box, or add
    a **Retry** button to the error box that calls `run(turn.prompt)`.
  - Map known failures to plain words with a next step, e.g. "Couldn't reach
    Ollama at … Is it running? (`ollama serve`)". Keep the raw message and
    reference id underneath for bug reports.

### UX-005: Pipeline settings are hard to find

- **Severity**: MAJOR
- **Principle**: H6 Recognition rather than recall; navigation ("where am I, how do I get back")
- **File(s)**:
  - [App.tsx:875-879](web/src/App.tsx#L875-L879)
  - [SidePanel.tsx:7](web/src/ui/SidePanel.tsx#L7)
  - [Inspector.tsx:933](web/src/editor/Inspector.tsx#L933)
- **Description**: Pipeline settings appear only when nothing is selected
  **and** the Settings tab is open. Clicking empty canvas clears the selection
  but doesn't switch tabs, because the effect at `App.tsx:877` only reacts to
  a non-empty selection. From Chat or Tests, clicking the canvas therefore
  seems to do nothing. The only explanation is the Settings tab's hover
  tooltip.

  This hides important settings: timeouts, retries, parallel calls,
  conversation history, output nodes and the defaults for all nodes.
- **Recommendation**:
  - Add a gear button ("Pipeline settings") next to the pipeline dropdown
    that clears the selection and opens Settings.
  - At the top of Settings, show a path such as `simple-local › clasify`,
    where clicking the pipeline name returns to its settings.
  - Optionally switch to Settings on an empty-canvas click too, but only
    when the panel is already on Settings or Add, so Chat isn't taken away
    during a run.

### UX-006: Two Run buttons with different meanings on the Tests tab

- **Severity**: MINOR
- **Principle**: H4 Consistency and standards
- **File(s)**:
  - [App.tsx:1155-1167](web/src/App.tsx#L1155-L1167)
  - [TestsView.tsx:328-330](web/src/tests/TestsView.tsx#L328-L330)
- **Description**: The message box is shown on every tab (a deliberate
  choice, per the README). On the Tests tab this puts two buttons on screen
  that behave differently:
  - The message box's **Run** saves the draft first, then sends a chat
    message.
  - **Run all cases** runs the unsaved draft without saving.

  On Settings, the message box also takes about 60px of a panel that is
  already three screens tall (UX-008).
- **Recommendation**:
  - Rename the message box button to **Send** (or "Save & send"). It sends a
    chat message; "Run" then only means test runs.
  - Hide the message box on the Tests tab.
  - Optionally let it shrink to a one-line bar on Settings until it's
    focused.

### UX-007: The toolbar gives ten actions equal weight

- **Severity**: MINOR
- **Principle**: Hick's law; visual hierarchy; "hide the ejector seat"
- **File(s)**:
  - [App.tsx:996-1047](web/src/App.tsx#L996-L1047)
- **Description**: Undo, Redo, New, Save, Save as, Import, Export,
  Auto-layout and Delete are all bordered uppercase buttons of the same size,
  followed by "Aa" and the status dot. Save, the main action, looks like the
  others whenever it is disabled. Delete sits in the same row next to the
  display button.

  Auto-layout acts on the canvas but lives with the file actions. At 768px
  the toolbar wraps to two rows (125px of header).
- **Recommendation**:
  - Keep Undo, Redo and Save visible, with Save as the only filled button.
  - Move New, Save as, Import, Export and Delete into a **File ▾** menu,
    with Delete last and separated.
  - Move Auto-layout into the canvas controls next to zoom and fit.

### UX-008: Node settings run three screens long and repeat actions

- **Severity**: MINOR
- **Principle**: H8 Aesthetic and minimalist design; progressive disclosure; serial position effect
- **File(s)**:
  - [Inspector.tsx:201-229](web/src/editor/Inspector.tsx#L201-L229)
  - [Inspector.tsx:363](web/src/editor/Inspector.tsx#L363)
  - [Inspector.tsx:461-485](web/src/editor/Inspector.tsx#L461-L485)
- **Description**:
  - For a node, the Configuration sub-tab is **1779px** tall in a 574px panel
    (36 inputs), even with Ollama options folded.
  - **Duplicate** and **Save as preset** appear twice, in the header and
    again at the bottom.
  - The prompt template, the field people edit most, sits below id, model,
    temperature, history, reasoning, labels and output.
  - The template's hint is a four-line paragraph of syntax ("`{{ message }}`:
    the new message · `{{ conversation }}`: …").
  - Delete node is at the very bottom of a long scroll.
- **Recommendation**:
  - Group the settings into sections that fold, and remember which are
    open: Model & sampling, Prompts, Ollama options, Connections, Routing,
    Presets.
  - Put **Prompts** first, right after the model.
  - Remove the second copies of Duplicate and Save as preset. Put Delete
    node in a "⋯" menu in the header.
  - Move each variable's explanation into the tooltip of its insert button,
    and keep a one-line hint with a link to the full syntax.

### UX-009: Canvas status and roles are hard to read, and the legend is on the wrong tab

- **Severity**: MINOR
- **Principle**: Signifiers; WCAG 1.4.1 Use of Color; information architecture (content where it's used)
- **File(s)**:
  - [LlmNode.tsx:10-15](web/src/editor/LlmNode.tsx#L10-L15)
  - [LlmNode.tsx:36-47](web/src/editor/LlmNode.tsx#L36-L47)
  - [Sidebar.tsx:131-139](web/src/editor/Sidebar.tsx#L131-L139)
- **Description**:
  - Before any run, every card shows an **IDLE** pill. It carries no
    information, and in dark mode it is barely visible (2.29:1).
  - The output node is marked only by a small colored ★ with a `title`.
  - The legend (running / done / failed, depends-on / branch / loop edges)
    explains the canvas but lives in the **Add** tab, which is for adding
    nodes.
  - "Drag from a node's bottom handle to another node's top handle" is only
    explained in the Depends-on section of node settings.
- **Recommendation**:
  - Hide the status pill until a run starts.
  - Give output nodes a text badge ("OUTPUT").
  - Move the legend to a small "?" button in a canvas corner that opens it
    as an overlay.
  - When a pipeline has no edges, show a one-line hint on the canvas.

### UX-010: One concept has several names, and one icon has two meanings

- **Severity**: MINOR
- **Principle**: H2 Match between system and the real world; H4 Consistency and standards
- **File(s)**:
  - [Chat.tsx:161](web/src/run/Chat.tsx#L161)
  - [Chat.tsx:206](web/src/run/Chat.tsx#L206)
  - [Inspector.tsx:627](web/src/editor/Inspector.tsx#L627)
  - [Inspector.tsx:236-238](web/src/editor/Inspector.tsx#L236-L238)
  - [SidePanel.tsx:9](web/src/ui/SidePanel.tsx#L9)
  - [fields.tsx:189-191](web/src/editor/fields.tsx#L189-L191)
  - [Inspector.tsx:209](web/src/editor/Inspector.tsx#L209)
- **Description**:
  - The user's text is a "message" (Chat empty state, template variable), an
    "Ask something…" (placeholder), a "prompt" (turn data, Messages view) and
    the user's "`question`" (branch help, `Inspector.tsx:627`). The template
    hint says `question` and `input` are older names.
  - **Messages** is a panel tab and also a sub-tab of node Settings, and it
    shows node inputs and outputs. Meanwhile "message" also means what the
    user types.
  - **↻** means "refresh the model list" (`fields.tsx:190`) and also
    "re-run from here" (`Inspector.tsx:209`, `MessageEntry.tsx:68`).
- **Recommendation**:
  - Use **message** everywhere for what the user sends, including the
    branch help text and the placeholder ("Type a message…").
  - Rename the Messages tab and sub-tab to **Trace** (or "Run log").
  - Use a different icon, or a text label, for refreshing the model list.
  - Add these to a short glossary in `web/README.md`.

### UX-011: Some disabled controls give no reason

- **Severity**: MINOR
- **Principle**: H1 Visibility of system status; H9 Error recovery
- **File(s)**:
  - [Inspector.tsx:340](web/src/editor/Inspector.tsx#L340)
  - [Inspector.tsx:864](web/src/editor/Inspector.tsx#L864)
  - [App.tsx:1005-1012](web/src/App.tsx#L1005-L1012)
- **Description**:
  - The last output-node checkbox is checked and disabled, with no
    explanation (in both node and pipeline settings).
  - Save is disabled when the draft is invalid, but its tooltip always reads
    "Save (⌘S / Ctrl+S)".

  The Run button already solves this with `runDisabled`, a reason shown as
  the placeholder.
- **Recommendation**: Apply the same pattern here:
  - For the output checkbox: "a pipeline needs at least one output node".
  - For Save: "fix the validation error to save", or "no changes".

### UX-012: Undo exists but is never offered after a delete

- **Severity**: MINOR
- **Principle**: H3 User control and freedom (undo instead of confirm); modeless feedback
- **File(s)**:
  - [App.tsx:68-72](web/src/App.tsx#L68-L72)
  - [App.tsx:1116-1119](web/src/App.tsx#L1116-L1119)
  - [Inspector.tsx:474-483](web/src/editor/Inspector.tsx#L474-L483)
- **Description**: Deleting a node (Backspace on the canvas or Delete node),
  a dependency, a route or a test case happens at once, without
  confirmation. That's the right choice, since all of these go through the
  undo history. But nothing tells the user it can be undone. The only
  signifier is the ↶ icon in the toolbar.
- **Recommendation**: After a delete, show an info notice with an action:
  "Deleted *clasify* · **Undo**". `Notice` already supports `action`, so
  this is a small change in `onDeleteNodes` and the Delete node handler.

### UX-013: On narrow screens the message box is below the fold

- **Severity**: MINOR
- **Principle**: Responsive layout; tools close at hand
- **File(s)**:
  - [style.css:700-707](web/src/style.css#L700-L707)
- **Description**: Below 960px the panel stacks under the canvas. At 768×1024
  the page is 1507px tall and the message box starts at **1443px**, so
  sending a message means scrolling past the canvas and the whole panel.
  Answers appear there too, out of sight of the canvas that shows progress.
- **Recommendation**:
  - Keep the message box fixed to the bottom of the viewport in the narrow
    layout.
  - Alternatively, add a **Canvas** tab to the panel on narrow screens,
    instead of stacking the canvas and panel.

  This is a desktop-first tool, so treat it as low priority.

### UX-014: Smaller items

- **Severity**: SUGGESTION
- **File(s)**:
  - [Chat.tsx:81](web/src/run/Chat.tsx#L81)
  - [style.css:625](web/src/style.css#L625)
  - [TestsView.tsx:346](web/src/tests/TestsView.tsx#L346)
- **Description**:
  - Final answers are shown as plain pre-wrapped monospace text. Models
    usually answer in Markdown, so lists, headings and code blocks show up
    as raw symbols.
  - In **Compare models**, the node dropdown has no visible label (only an
    `aria-label`). It isn't obvious that it picks which node's model gets
    swapped.
- **Recommendation**:
  - Render final answers (and optionally node replies) as sanitized Markdown,
    with a "raw" toggle.
  - Label the dropdown, e.g. "Swap the model of node".

---

## What already works well

Keep these when making the changes above:

- In-app dialogs built on `<dialog>`, with inline validation and a
  destructive-action style.
- Undo/redo that groups typing in a field into one step, and ⌘S, ⌘D and
  ⌘Z/⇧⌘Z shortcuts.
- Live validation: a chip in the header, and a click on "invalid" jumps to
  the node.
- A Run button that states why it's disabled, and "Save & run" when there
  are unsaved changes.
- Streaming status on the canvas, live text on cards, and Esc to stop.
- `prefers-reduced-motion` support, `:focus-visible` outlines, and panel tabs
  marked up with `role="tab"` and `aria-selected`.
- A theme that follows the system, and text size applied before first paint.

## Not covered

- A successful streaming run, re-run from here and prompt preview with real
  outputs. Ollama wasn't running.
- Test runs with results, and the model comparison grid.
- A screen reader pass, and keyboard-only use of the canvas (selecting,
  connecting and moving nodes without a mouse).
- The New / Save as / Import dialogs were reviewed in code only.

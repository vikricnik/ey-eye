# Pages — dependency trees

## / (Pipeline editor)
Entry: web/src/main.tsx → web/src/App.tsx
Dependencies (local imports, recursively; `@llm-pipeline/client` is a workspace package, not UI):
- web/src/style.css
- web/src/config.ts
- web/src/format.ts
- web/src/providerStatus.ts
- web/src/ui/ServerStatus.tsx
- web/src/ui/DisplaySettings.tsx
- web/src/ui/Menu.tsx
- web/src/ui/Dialogs.tsx
- web/src/ui/icons.tsx
- web/src/ui/Splitter.tsx
  - web/src/ui/panelSizes.ts
- web/src/ui/RunPanel.tsx
- web/src/editor/PipelineCanvas.tsx
  - web/src/editor/LlmNode.tsx
  - web/src/editor/conversion.ts
  - web/src/editor/zoomDetail.ts
  - web/src/editor/canvasHint.ts
  - web/src/editor/revealNode.ts
  - web/src/editor/CanvasLegend.tsx
  - web/src/ui/icons.tsx
- web/src/editor/AddNodeMenu.tsx
  - web/src/editor/PipelineCanvas.tsx (NODE_DRAG_TYPE)
- web/src/editor/SettingsColumn.tsx
  - web/src/ui/panelSizes.ts (type)
- web/src/editor/Inspector.tsx
  - web/src/editor/Section.tsx
  - web/src/editor/fields.tsx
  - web/src/editor/PromptPreview.tsx
  - web/src/editor/NodeTrace.tsx
    - web/src/run/MessageEntry.tsx
  - web/src/editor/traceSummary.ts
  - web/src/editor/pipelineSummaries.ts
  - web/src/ui/Dialogs.tsx
  - web/src/ui/Menu.tsx
  - web/src/format.ts
- web/src/editor/editorState.ts
- web/src/editor/canvasDeletion.ts
- web/src/run/Chat.tsx
  - web/src/run/Markdown.tsx
    - web/src/run/markdownToHtml.ts
  - web/src/run/RunErrorView.tsx
    - web/src/run/runFailure.ts
  - web/src/run/RunTrace.tsx
    - web/src/run/MessageEntry.tsx
  - web/src/run/stickToBottom.ts
  - web/src/run/runHistory.ts (type)
- web/src/run/runHistory.ts
- web/src/tests/TestsView.tsx

Render notes: one render path for desktop; at ≤960px CSS stacks canvas → settings column → run panel.
The settings column shows NodeInspector (node selected), EdgeInspector (dependency) or PipelineInspector (nothing selected).
Inspector.tsx is ~1245 lines — line-range to the inspector bodies when passing it as context.

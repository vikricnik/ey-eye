# Routes — ey-eye web client

No router: a single page served by Vite at `/`.

| Path | Entry | Layout |
|---|---|---|
| `/` | `web/src/main.tsx` → `web/src/App.tsx` | the App shell (layouts.md) |

What `/` renders: a pipeline editor for YAML-defined LLM DAG pipelines — a React Flow canvas of nodes (LLM calls) and dependency edges; a settings column for the selected node, dependency or the pipeline; and a run panel with Chat (send a message, stream the answer, per-run trace of every node's input/output) and Tests (test cases, model comparisons).

### `web/src/main.tsx`

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DialogProvider } from "./ui/Dialogs";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Required element #root not found in DOM");

createRoot(root).render(
  <StrictMode>
    <DialogProvider>
      <App />
    </DialogProvider>
  </StrictMode>
);
```

### `web/index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LLM Pipeline Builder</title>
  <script>
    // Saved theme and text size, applied before the first paint so the page
    // doesn't flash the wrong theme. Same storage key and rules as
    // src/ui/DisplaySettings.tsx, which takes over once the app loads.
    (function () {
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem("llm-pipeline.display") || "{}") || {}; } catch (e) {}
      var theme = saved.theme === "light" || saved.theme === "dark" ? saved.theme
        : window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", theme);
      if ([0.875, 1.125, 1.25, 1.375, 1.5].indexOf(saved.textScale) >= 0) {
        document.documentElement.style.fontSize = saved.textScale * 100 + "%";
      }
    })();
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
</head>
<body>
  <div id="root"></div>
  <script src="/runtime-config.js"></script>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

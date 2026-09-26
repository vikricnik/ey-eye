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

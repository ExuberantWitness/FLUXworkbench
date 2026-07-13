// Flux Workbench — renderer entry. VSCode-style layout skeleton (activity bar /
// sidebar / editor / panel / status bar). Panels wired during build-task #5.
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LangProvider } from "./i18n";
import "./shell.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(<LangProvider><App /></LangProvider>);

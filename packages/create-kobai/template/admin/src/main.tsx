import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root to mount the Admin into.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import App from "./app";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            fontFamily: "JetBrains Mono, monospace",
            background: "var(--popover)",
            border: "1px solid var(--border)",
            color: "var(--popover-foreground)",
            fontSize: "12px",
          },
        }}
      />
    </BrowserRouter>
  </React.StrictMode>,
);

import "@fontsource-variable/instrument-sans/wdth.css";
import "@fontsource/fragment-mono/400.css";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OddsSite } from "./OddsSite.tsx";

// The public site is the live board alone: no simulated backend, no wallet, nothing else to load.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OddsSite />
  </StrictMode>,
);

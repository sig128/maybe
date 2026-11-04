import "@fontsource-variable/instrument-sans/wdth.css";
import "@fontsource/fragment-mono/400.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/features.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router/dom";
import * as Tooltip from "@radix-ui/react-tooltip";
import { BackendProvider } from "./data/BackendContext.tsx";
import { createBackend } from "./data/createBackend.ts";
import { router } from "./app/routes.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1, structuralSharing: true } },
});

const backend = createBackend();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BackendProvider backend={backend}>
        <Tooltip.Provider delayDuration={250}>
          <RouterProvider router={router} />
        </Tooltip.Provider>
      </BackendProvider>
    </QueryClientProvider>
  </StrictMode>,
);

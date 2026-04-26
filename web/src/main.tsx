import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app.js";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Loopback queries are cheap, but the daemon's run-loop only
      // polls SQLite every 2s — refetching faster than that is just
      // network noise. Run view streams via SSE separately.
      staleTime: 5_000,
      gcTime: 60_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

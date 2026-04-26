import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

// Hand-rolled SPA router — pulling in TanStack Router or React Router
// for four routes is more dependency than the spec allows. We track
// `window.location.pathname`, intercept anchor clicks via a delegated
// listener so server-side hrefs still work for inert links, and
// provide a tiny `useRoute()` hook for screens.

interface RouteContextValue {
  path: string;
  push: (next: string) => void;
}

const RouteContext = createContext<RouteContextValue | null>(null);

function readPath(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname || "/";
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState<string>(readPath);

  useEffect(() => {
    const onPop = () => setPath(readPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const push = useCallback((next: string) => {
    if (next === window.location.pathname + window.location.search) return;
    window.history.pushState(null, "", next);
    setPath(readPath());
  }, []);

  // Intercept clicks on anchors with same-origin hrefs. This lets
  // screens use plain <a href="/runs/123"> markup without a custom
  // <Link> component — gentler on accessibility tools and keeps the
  // SPA navigation transparent.
  useEffect(() => {
    const onClick = (ev: MouseEvent): void => {
      if (ev.defaultPrevented) return;
      if (ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const target = ev.target as Element | null;
      const anchor = target?.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("http") || href.startsWith("//")) return;
      if (anchor.target && anchor.target !== "" && anchor.target !== "_self") return;
      ev.preventDefault();
      push(href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [push]);

  const value = useMemo(() => ({ path, push }), [path, push]);
  return <RouteContext.Provider value={value}>{children}</RouteContext.Provider>;
}

export function useRoute(): RouteContextValue {
  const ctx = useContext(RouteContext);
  if (!ctx) throw new Error("useRoute outside RouterProvider");
  return ctx;
}

// match("/projects/:id", "/projects/abc") → { id: "abc" }
// match("/projects/:id", "/projects/abc/edit") → null
export function match(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const pp = pattern.split("/").filter(Boolean);
  const ap = path.split("/").filter(Boolean);
  if (pp.length !== ap.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < pp.length; i += 1) {
    const seg = pp[i]!;
    const a = ap[i]!;
    if (seg.startsWith(":")) {
      out[seg.slice(1)] = decodeURIComponent(a);
    } else if (seg !== a) {
      return null;
    }
  }
  return out;
}

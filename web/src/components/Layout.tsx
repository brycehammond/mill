import type { ReactNode } from "react";
import { useRoute } from "../router.js";

// App shell: top bar with brand + nav, content area below. Mobile nav
// collapses into a single-row scroll strip — no hamburger menu since
// there are only three top-level destinations.

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full flex flex-col">
      <Header />
      <main className="flex-1 px-4 sm:px-6 py-4 sm:py-6 max-w-6xl w-full mx-auto">
        {children}
      </main>
      <footer className="px-4 sm:px-6 py-3 text-xs text-ink-300 border-t border-ink-700">
        mill · loopback only · no auth
      </footer>
    </div>
  );
}

function Header() {
  const { path } = useRoute();
  const isActive = (prefix: string): boolean =>
    prefix === "/" ? path === "/" : path.startsWith(prefix);
  return (
    <header className="border-b border-ink-700 bg-ink-800">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-6">
        <a
          href="/"
          className="font-mono font-semibold text-ink-100 tracking-tight text-base"
        >
          mill
        </a>
        <nav className="flex items-center gap-1 sm:gap-3 overflow-x-auto">
          <NavLink href="/" active={isActive("/") && path === "/"}>
            dashboard
          </NavLink>
          <NavLink href="/findings" active={isActive("/findings")}>
            findings
          </NavLink>
        </nav>
      </div>
    </header>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  const cls = active
    ? "text-ink-100 border-b-2 border-ink-100"
    : "text-ink-300 hover:text-ink-100 border-b-2 border-transparent";
  return (
    <a
      href={href}
      className={`px-2 py-1 text-sm transition-colors ${cls}`}
    >
      {children}
    </a>
  );
}

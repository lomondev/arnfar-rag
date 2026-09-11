"use client";

import { cn } from "@arnfar/ui/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/studio", label: "Overview" },
  { href: "/studio/teach", label: "Teach" },
  { href: "/studio/ingest", label: "Ingest" },
  { href: "/studio/review", label: "Review" },
  { href: "/studio/qa", label: "QA" },
  { href: "/studio/glossary", label: "Glossary" },
  { href: "/studio/knowledge", label: "Knowledge" },
  { href: "/studio/lessons", label: "Lessons" },
  { href: "/studio/eval", label: "Eval" },
  { href: "/studio/lao-check", label: "Lao check" },
  { href: "/studio/export", label: "Export" },
];

export function StudioNav() {
  const pathname = usePathname();
  return (
    // The bar floats inside a transparent gutter rather than spanning the viewport:
    // glass only reads as glass when content is visibly passing *behind* it, and a
    // full-bleed bar hides its own edges against the window.
    <div className="sticky top-0 z-30 h-[var(--studio-nav-h)] px-3 pt-3 pb-2 sm:px-4">
      <nav className="glass glass-blur-lg mx-auto flex max-w-6xl items-center gap-1 rounded-2xl p-1.5">
        <Link
          href="/"
          className="hover:bg-accent/50 me-1 shrink-0 rounded-xl px-2.5 py-1.5 font-semibold transition-colors"
        >
          Arnfar <span className="text-muted-foreground font-normal">Studio</span>
        </Link>

        {/* Ten tabs will not fit a phone. Scroll them rather than wrapping — a
         * two-row capsule loses the segmented-control read entirely. */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((t) => {
            const active = pathname === t.href;
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-xl px-3 py-1.5 text-sm transition-all duration-200",
                  active
                    ? // The active tab is a lit pane of glass sitting on the bar —
                      // the macOS segmented-control thumb, not a flat fill.
                      "glass glass-strong glass-blur-sm text-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </div>

        <Link
          href="/chat"
          className="glass-field text-muted-foreground hover:text-foreground ms-1 shrink-0 rounded-xl px-2.5 py-1.5 text-sm transition-colors"
        >
          Chat →
        </Link>
      </nav>
    </div>
  );
}

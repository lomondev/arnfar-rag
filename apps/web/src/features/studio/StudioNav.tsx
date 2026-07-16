"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@arnfar/ui/lib/utils";

const TABS = [
  { href: "/studio/review", label: "Review" },
  { href: "/studio/qa", label: "QA" },
  { href: "/studio/glossary", label: "Glossary" },
  { href: "/studio/accounts", label: "Accounts" },
  { href: "/studio/eval", label: "Eval" },
  { href: "/studio/lao-check", label: "Lao check" },
  { href: "/studio/export", label: "Export" },
];

export function StudioNav() {
  const pathname = usePathname();
  return (
    <nav className="border-border bg-background sticky top-0 z-10 flex items-center gap-1 border-b px-4 py-2">
      <Link href="/" className="mr-3 font-semibold">
        Arnfar <span className="text-muted-foreground font-normal">Studio</span>
      </Link>
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              active
                ? "bg-secondary text-secondary-foreground font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
      <Link
        href="/chat"
        className="text-muted-foreground hover:text-foreground ml-auto text-sm"
      >
        Chat →
      </Link>
    </nav>
  );
}

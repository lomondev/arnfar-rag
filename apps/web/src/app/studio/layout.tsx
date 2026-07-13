import Link from "next/link";

const TABS = [
  { href: "/studio/review", label: "Review" },
  { href: "/studio/qa", label: "QA" },
  { href: "/studio/glossary", label: "Glossary" },
  { href: "/studio/eval", label: "Eval" },
  { href: "/studio/lao-check", label: "Lao check" },
  { href: "/studio/export", label: "Export" },
];

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav
        style={{
          display: "flex",
          gap: "0.25rem",
          padding: "0.5rem 1rem",
          borderBottom: "1px solid #e5e7eb",
          alignItems: "center",
        }}
      >
        <strong style={{ marginRight: "1rem" }}>Arnfar Studio</strong>
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            style={{
              padding: "0.35rem 0.75rem",
              borderRadius: 6,
              textDecoration: "none",
              color: "#334155",
              fontSize: "0.9rem",
            }}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}

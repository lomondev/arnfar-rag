import type { Metadata } from "next";
import { phetsarathFontFaceCss } from "@arnfar/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arnfar AI — Lao Accounting Assistant",
  description: "Local-first, offline-capable Lao accounting RAG + dataset platform.",
};

/**
 * Applies the stored theme before first paint. Running this as React state instead would
 * paint the light theme for one frame and then flip — a white flash on every load for a
 * dark-theme user. suppressHydrationWarning on <html> is required because this script
 * legitimately mutates the class list before React hydrates.
 */
const THEME_SCRIPT = `
try {
  var t = localStorage.getItem("arnfar.theme");
  if (t === "dark" || (t === null && matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
  }
} catch {}
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="lo" suppressHydrationWarning>
      <head>
        {/*
         * Phetsarath OT for all Lao script — self-hosted, font-display: swap.
         * These @font-face rules declare the family that Tailwind's --font-sans names
         * (packages/ui/src/styles/globals.css); the base layer applies it to <html>.
         */}
        <style dangerouslySetInnerHTML={{ __html: phetsarathFontFaceCss() }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

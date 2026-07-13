import type { Metadata } from "next";
import { phetsarathFontFaceCss } from "@arnfar/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arnfar AI — Lao Accounting Assistant",
  description: "Local-first, offline-capable Lao accounting RAG + dataset platform.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="lo">
      <head>
        {/*
         * Phetsarath OT for all Lao script — self-hosted, font-display: swap.
         * These @font-face rules declare the family that Tailwind's --font-sans names
         * (packages/ui/src/styles/globals.css); the base layer applies it to <html>.
         */}
        <style dangerouslySetInnerHTML={{ __html: phetsarathFontFaceCss() }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

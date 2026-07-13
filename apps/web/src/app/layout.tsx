import type { Metadata } from "next";
import { PHETSARATH_FAMILY, phetsarathFontFaceCss } from "@arnfar/ui";

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
        {/* Phetsarath OT for all Lao script — self-hosted, font-display: swap. */}
        <style dangerouslySetInnerHTML={{ __html: phetsarathFontFaceCss() }} />
      </head>
      <body
        style={{
          fontFamily: `"${PHETSARATH_FAMILY}", ui-sans-serif, system-ui, sans-serif`,
          margin: 0,
        }}
      >
        {children}
      </body>
    </html>
  );
}

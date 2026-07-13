/**
 * Phetsarath OT — the mandated font for ALL Lao script (UI + exports).
 *
 * Self-hosted and subset (CLAUDE.md). Drop the woff2 files at the paths below under
 * apps/web/public/fonts/ and verify tone-mark / vowel stacking actually composes —
 * most fallback fonts break Lao vowel+tone stacking, which is unacceptable for an
 * accounting document. `font-display: swap` so Lao never blocks first paint.
 */
export const PHETSARATH_FAMILY = "Phetsarath OT" as const;

export interface FontFaceSource {
  readonly weight: 400 | 700;
  readonly url: string;
}

export const PHETSARATH_SOURCES: readonly FontFaceSource[] = [
  { weight: 400, url: "/fonts/phetsarath-ot-regular.woff2" },
  { weight: 700, url: "/fonts/phetsarath-ot-bold.woff2" },
];

/** Emit the @font-face CSS block. Injected once in the web root layout. */
export function phetsarathFontFaceCss(): string {
  return PHETSARATH_SOURCES.map(
    (s) => `@font-face {
  font-family: "${PHETSARATH_FAMILY}";
  font-style: normal;
  font-weight: ${s.weight};
  font-display: swap;
  src: url("${s.url}") format("woff2");
}`,
  ).join("\n");
}

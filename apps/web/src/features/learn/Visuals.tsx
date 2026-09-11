"use client";

import type { VisualItem, VisualSpec } from "@arnfar/contracts";
import { cn } from "@arnfar/ui/lib/utils";

/**
 * The eight lesson visuals.
 *
 * Each takes typed data from `visualSpec` and draws it — no visual ever receives markup,
 * because the drafting model that produces the data cannot be trusted to produce correct
 * SVG and un-reviewable markup in a database is markup nobody audits.
 *
 * Constraints every one of these honours:
 *   - **Offline.** Inline SVG and CSS only. The app must run with no network at all, so
 *     there is no charting library and no icon font here.
 *   - **Both themes.** Colour comes from `--chart-1..5` and the semantic tokens, never a
 *     literal — a hex that reads well on the warm paper ground vanishes on the dark one.
 *   - **Lao renders correctly.** Labels inherit Phetsarath OT from the page. Lao is drawn
 *     as HTML text, never as SVG `<text>`: SVG text does not reflow, and a Lao label that
 *     overflows its box is unreadable rather than merely ugly.
 *   - **Reduced motion.** Every animation is a reveal defined in globals.css, and the
 *     media query there ends them all at their final state.
 */

/** Series colour by index. Wraps at five, which is also the cap on every item list in
 *  the contract — so two adjacent items can never share a colour. */
function seriesVar(i: number): string {
  return `var(--chart-${(i % 5) + 1})`;
}

/** Semantic tone → token. `highlight` is the terracotta primary, which in this design
 *  system means "act" or "cited" and is the only saturated colour — so it is used for the
 *  one thing a step wants the eye to land on, never for decoration. */
function toneVar(tone: VisualItem["tone"], fallbackIndex: number): string {
  switch (tone) {
    case "positive":
      return "var(--chart-2)";
    case "negative":
      return "var(--destructive)";
    case "highlight":
      return "var(--primary)";
    case "neutral":
      return "var(--muted-foreground)";
    default:
      return seriesVar(fallbackIndex);
  }
}

const STAGGER_MS = 90;
const delay = (i: number) => ({ animationDelay: `${i * STAGGER_MS}ms` });

function Caption({ text }: { text?: string }) {
  if (!text) return null;
  return <p className="text-muted-foreground mt-3 text-center text-xs leading-relaxed">{text}</p>;
}

function Frame({ children, caption }: { children: React.ReactNode; caption?: string }) {
  return (
    <figure className="bg-card/60 my-4 rounded-xl border p-4">
      {children}
      <Caption text={caption} />
    </figure>
  );
}

/** A labelled chip — the shared atom of balance, sequence, flow and compare. */
function Chip({ item, index, className }: { item: VisualItem; index: number; className?: string }) {
  return (
    <div
      className={cn(
        "bg-background/70 rounded-lg border px-3 py-2 text-center",
        // The tone stripe is a left border rather than a fill: a filled chip puts Lao text
        // on a saturated ground, where Phetsarath's thin strokes lose contrast.
        "border-s-3",
        className,
      )}
      style={{ borderInlineStartColor: toneVar(item.tone, index) }}
    >
      <div lang="lo" className="text-sm leading-snug font-medium">
        {item.label}
      </div>
      {item.value && <div className="mt-0.5 font-mono text-sm tabular-nums">{item.value}</div>}
      {item.note && (
        <div lang="lo" className="text-muted-foreground mt-0.5 text-xs leading-snug">
          {item.note}
        </div>
      )}
    </div>
  );
}

// ── balance ─────────────────────────────────────────────────────────────────────────
function BalanceVisual({ spec }: { spec: Extract<VisualSpec, { type: "balance" }> }) {
  const side = (label: string, items: VisualItem[], offset: number) => (
    <div className="flex-1">
      <div className="text-muted-foreground mb-2 text-center text-xs font-medium tracking-wide uppercase">
        {label}
      </div>
      <div className="flex flex-col gap-2">
        {items.map((it, i) => (
          <div key={`${it.label}-${i}`} className="lv-settle" style={delay(offset + i)}>
            <Chip item={it} index={offset + i} />
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <Frame caption={spec.caption}>
      <div className="flex items-center gap-3">
        {side(spec.leftLabel, spec.left, 0)}
        <div
          className="text-muted-foreground lv-rise shrink-0 text-2xl font-light"
          style={delay(spec.left.length)}
          aria-hidden="true"
        >
          =
        </div>
        {side(spec.rightLabel, spec.right, spec.left.length + 1)}
      </div>
    </Frame>
  );
}

// ── sequence ────────────────────────────────────────────────────────────────────────
function SequenceVisual({ spec }: { spec: Extract<VisualSpec, { type: "sequence" }> }) {
  return (
    <Frame caption={spec.caption}>
      <ol className="flex flex-col gap-2">
        {spec.steps.map((it, i) => (
          <li key={`${it.label}-${i}`} className="lv-rise flex items-start gap-3" style={delay(i)}>
            {/* Numbered because a sequence IS ordered — the number carries information
                here, unlike a decorative counter. */}
            <span
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums"
              style={{ background: seriesVar(i), color: "var(--primary-foreground)" }}
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div lang="lo" className="text-sm leading-snug font-medium">
                {it.label}
              </div>
              {it.value && <div className="font-mono text-sm tabular-nums">{it.value}</div>}
              {it.note && (
                <div lang="lo" className="text-muted-foreground text-xs leading-snug">
                  {it.note}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Frame>
  );
}

// ── flow ────────────────────────────────────────────────────────────────────────────
function FlowVisual({ spec }: { spec: Extract<VisualSpec, { type: "flow" }> }) {
  return (
    <Frame caption={spec.caption}>
      {/* Wraps to a column on narrow screens: a horizontal flow of Lao labels overflows a
          phone long before four nodes, and a sideways-scrolling diagram is not read. */}
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        {spec.nodes.map((node, i) => (
          <div key={`${node.label}-${i}`} className="contents">
            <div className="lv-rise flex-1" style={delay(i * 2)}>
              <Chip item={node} index={i} />
            </div>
            {i < spec.nodes.length - 1 && (
              <div
                className="flex shrink-0 flex-col items-center justify-center"
                style={{ minWidth: "2.5rem" }}
              >
                <svg
                  width="40"
                  height="16"
                  viewBox="0 0 40 16"
                  className="text-muted-foreground rotate-90 sm:rotate-0"
                  aria-hidden="true"
                >
                  <title>arrow</title>
                  <path
                    d="M2 8 H32"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    fill="none"
                    className="lv-draw"
                    style={{ ...delay(i * 2 + 1), strokeDasharray: 30, ["--lv-len" as string]: 30 }}
                  />
                  <path
                    d="M30 4 L36 8 L30 12"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    fill="none"
                  />
                </svg>
                {spec.edgeLabels?.[i] && (
                  <span className="text-muted-foreground mt-0.5 text-[0.65rem] leading-tight">
                    {spec.edgeLabels[i]}
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </Frame>
  );
}

// ── parts ───────────────────────────────────────────────────────────────────────────
function PartsVisual({ spec }: { spec: Extract<VisualSpec, { type: "parts" }> }) {
  // Values arrive as strings (a kip amount is BIGINT and a JSON number would lose it), so
  // the share is parsed here for width only. A part whose value is not numeric still
  // renders — it simply shares the bar equally rather than vanishing.
  const nums = spec.parts.map((p) => {
    const n = Number(String(p.value).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const total = nums.reduce((a, b) => a + b, 0);
  const widths = total > 0 ? nums.map((n) => (n / total) * 100) : nums.map(() => 100 / nums.length);

  return (
    <Frame caption={spec.caption}>
      <div className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
        {spec.wholeLabel}
      </div>
      <div className="flex h-9 w-full overflow-hidden rounded-lg border">
        {spec.parts.map((p, i) => (
          <div
            key={`${p.label}-${i}`}
            className="lv-growx h-full"
            style={{
              ...delay(i),
              width: `${widths[i]}%`,
              background: toneVar(p.tone, i),
              opacity: 0.85,
            }}
            title={`${p.label} ${p.value}`}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {spec.parts.map((p, i) => (
          <li key={`${p.label}-${i}`} className="lv-rise flex items-center gap-2" style={delay(i)}>
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: toneVar(p.tone, i) }}
              aria-hidden="true"
            />
            <span lang="lo" className="text-sm">
              {p.label}
            </span>
            <span className="text-muted-foreground font-mono text-sm tabular-nums">{p.value}</span>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

// ── compare ─────────────────────────────────────────────────────────────────────────
function CompareVisual({ spec }: { spec: Extract<VisualSpec, { type: "compare" }> }) {
  return (
    <Frame caption={spec.caption}>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${spec.columns.length}, minmax(0,1fr))` }}
      >
        {spec.columns.map((col, ci) => (
          <div key={`${col.heading}-${ci}`} className="flex flex-col gap-2">
            <div
              lang="lo"
              className="lv-rise border-b pb-1.5 text-center text-sm font-semibold"
              style={delay(ci)}
            >
              {col.heading}
            </div>
            {col.items.map((it, i) => (
              <div
                key={`${it.label}-${i}`}
                className="lv-rise"
                style={delay(spec.columns.length + i * spec.columns.length + ci)}
              >
                <Chip item={it} index={ci} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </Frame>
  );
}

// ── timeline ────────────────────────────────────────────────────────────────────────
function TimelineVisual({ spec }: { spec: Extract<VisualSpec, { type: "timeline" }> }) {
  return (
    <Frame caption={spec.caption}>
      <ol className="relative flex flex-col gap-3 ps-6">
        {/* The axis. Drawn as a border on the list rather than an SVG line so it grows with
            the content and never falls out of sync with the markers. */}
        <span className="bg-border absolute inset-y-1 start-[0.4375rem] w-px" aria-hidden="true" />
        {spec.events.map((ev, i) => (
          <li key={`${ev.label}-${i}`} className="lv-rise relative" style={delay(i)}>
            <span
              className="border-background absolute top-1 size-2.5 rounded-full border-2"
              style={{ insetInlineStart: "-1.4rem", background: toneVar(ev.tone, i) }}
              aria-hidden="true"
            />
            <div lang="lo" className="text-sm leading-snug font-medium">
              {ev.label}
            </div>
            {ev.value && (
              <div className="text-muted-foreground font-mono text-xs tabular-nums">{ev.value}</div>
            )}
            {ev.note && (
              <div lang="lo" className="text-muted-foreground text-xs leading-snug">
                {ev.note}
              </div>
            )}
          </li>
        ))}
      </ol>
    </Frame>
  );
}

// ── formula ─────────────────────────────────────────────────────────────────────────
function FormulaVisual({ spec }: { spec: Extract<VisualSpec, { type: "formula" }> }) {
  return (
    <Frame caption={spec.caption}>
      {/* Plain text, not typeset: no maths renderer may be loaded offline, and a
          Lao-labelled formula is read rather than typeset. Scrolls in its own box so a
          long expression never makes the page scroll sideways. */}
      <div className="overflow-x-auto">
        <div
          lang="lo"
          className="lv-rise bg-background/70 rounded-lg border px-4 py-3 text-center font-mono text-base whitespace-nowrap tabular-nums"
        >
          {spec.expression}
        </div>
      </div>
      {spec.substitution && (
        <div className="mt-2 overflow-x-auto">
          <div
            className="lv-rise text-primary px-4 text-center font-mono text-sm whitespace-nowrap tabular-nums"
            style={delay(1)}
          >
            {spec.substitution}
          </div>
        </div>
      )}
      <ul className="mt-3 flex flex-col gap-1.5">
        {spec.terms.map((t, i) => (
          <li
            key={`${t.label}-${i}`}
            className="lv-rise flex items-baseline gap-2"
            style={delay(i + 2)}
          >
            <span
              className="mt-1 size-2 shrink-0 rounded-full"
              style={{ background: toneVar(t.tone, i) }}
              aria-hidden="true"
            />
            <span lang="lo" className="text-sm">
              {t.label}
            </span>
            {t.value && (
              <span className="text-muted-foreground font-mono text-sm tabular-nums">
                {t.value}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Frame>
  );
}

// ── table ───────────────────────────────────────────────────────────────────────────
function TableVisual({ spec }: { spec: Extract<VisualSpec, { type: "table" }> }) {
  const highlight = new Set(spec.highlightRows ?? []);
  return (
    <Frame caption={spec.caption}>
      {/* Its own scroll container: a wide table must never make the page scroll sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] border-collapse text-sm">
          <thead>
            <tr>
              {spec.headers.map((h, i) => (
                <th
                  key={`${h}-${i}`}
                  lang="lo"
                  className="text-muted-foreground border-b px-2.5 py-1.5 text-start text-xs font-medium tracking-wide uppercase"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((row, ri) => (
              <tr
                key={`row-${ri}`}
                className={cn(
                  "lv-rise border-b last:border-0",
                  highlight.has(ri) && "bg-primary/8",
                )}
                style={delay(ri)}
              >
                {row.map((cell, ci) => (
                  <td
                    key={`cell-${ri}-${ci}`}
                    lang="lo"
                    className={cn(
                      "px-2.5 py-1.5 align-top leading-snug",
                      // Numeric-looking cells line up; Lao prose does not get tabular
                      // figures, which would space its Latin loanwords oddly.
                      /^[\d.,\s%+-]+$/.test(cell) && "font-mono tabular-nums",
                      highlight.has(ri) && "font-medium",
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

/**
 * Draw a step's visual.
 *
 * The switch is exhaustive over the discriminated union, so adding a type to the contract
 * without a renderer is a compile error rather than a blank space in a lesson.
 */
export function Visual({ spec }: { spec: VisualSpec }) {
  switch (spec.type) {
    case "balance":
      return <BalanceVisual spec={spec} />;
    case "sequence":
      return <SequenceVisual spec={spec} />;
    case "flow":
      return <FlowVisual spec={spec} />;
    case "parts":
      return <PartsVisual spec={spec} />;
    case "compare":
      return <CompareVisual spec={spec} />;
    case "timeline":
      return <TimelineVisual spec={spec} />;
    case "formula":
      return <FormulaVisual spec={spec} />;
    case "table":
      return <TableVisual spec={spec} />;
  }
}

/**
 * Shared types + pure UI helpers for /chat.
 *
 * Conversations are now server-persisted (see chatApi.ts). This module keeps the
 * types and the recency-bucketing/title helpers that the UI needs regardless of
 * where the data lives.
 */

import type { MessageRole, StoredSource } from "@arnfar/contracts";

/**
 * StoredSource is the wire shape and lives in @arnfar/contracts — the citation panel
 * renders exactly what the API sent, including the origin distinction that decides
 * whether a source is exportable. Re-exported so /chat imports stay local.
 */
export type { StoredSource };

export interface StoredMessage {
  /** Server id (`rag_message.id`). Absent on an optimistic turn that has not been
   *  persisted yet — which is exactly when editing it is meaningless anyway. */
  readonly id?: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly sources?: readonly StoredSource[];
  /** For an assistant turn: the question it answered. Needed to promote it to the dataset. */
  readonly question?: string;
  readonly promoted?: boolean;
  readonly reported?: boolean;
}

export interface Conversation {
  readonly id: string;
  readonly title: string;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: readonly StoredMessage[];
}

/** First line of the opening question, clipped. Lao has no spaces, so clip on graphemes. */
export function titleFrom(question: string): string {
  const line = question.trim().split("\n")[0] ?? "";
  const chars = [...line];
  if (chars.length === 0) return "New chat";
  return chars.length > 48 ? `${chars.slice(0, 48).join("")}…` : line;
}

export interface ConversationGroup {
  readonly label: string;
  readonly items: readonly Conversation[];
}

/** Bucket threads the way a person thinks about them: today, yesterday, this week, older. */
export function groupByRecency(list: readonly Conversation[], now: number): ConversationGroup[] {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const day = 86_400_000;

  const buckets: { label: string; min: number; items: Conversation[] }[] = [
    { label: "Today", min: startOfToday, items: [] },
    { label: "Yesterday", min: startOfToday - day, items: [] },
    { label: "Previous 7 days", min: startOfToday - 7 * day, items: [] },
    { label: "Older", min: Number.NEGATIVE_INFINITY, items: [] },
  ];

  for (const c of [...list].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const bucket = buckets.find((b) => c.updatedAt >= b.min);
    bucket?.items.push(c);
  }
  return buckets.filter((b) => b.items.length > 0).map(({ label, items }) => ({ label, items }));
}

/**
 * Resolve the number inside a citation marker to one of the answer's sources.
 *
 * A well-behaved generator emits `[1]`, `[2]` — a 1-based index into `sources`, and the
 * first branch is the whole story. The small quantised Lao models do not: gemma-3n-laos
 * emits `[n]411`, where 411 is the *account code* it is citing, not an index. That number
 * is still a real handle on the evidence — the source containing account 411 is the source
 * the sentence rests on — so fall back to finding it in the retrieved text rather than
 * dropping the citation on the floor.
 *
 * Returns null when the marker resolves to nothing; the caller shows the full reference
 * list instead, which is always honest.
 */
export function resolveCitation(
  sources: readonly StoredSource[],
  n: number | null,
): StoredSource | null {
  if (n === null || sources.length === 0) return null;
  if (n >= 1 && n <= sources.length) return sources[n - 1] ?? null;

  // Standalone-token match: `47` must not match inside `470` or `147`. Lao text has no
  // spaces, so word boundaries are useless here — bound on digits only.
  const token = new RegExp(`(?<![0-9])${n}(?![0-9])`);
  return sources.find((s) => token.test(s.content) || token.test(s.title)) ?? null;
}

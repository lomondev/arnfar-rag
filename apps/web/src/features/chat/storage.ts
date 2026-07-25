/**
 * Shared types + pure UI helpers for /chat.
 *
 * Conversations are now server-persisted (see chatApi.ts). This module keeps the
 * types and the recency-bucketing/title helpers that the UI needs regardless of
 * where the data lives.
 */

export interface StoredSource {
  readonly n: number;
  readonly id: string;
  readonly content: string;
  readonly headingPath: readonly string[];
  readonly kind: string;
  readonly title: string;
  readonly authority: string | null;
  readonly effectiveDate: string | null;
  /** Dataset chunks omit these; "web" = internet page, "erp" = live ERP figure. */
  readonly origin?: "dataset" | "web" | "erp";
  readonly url?: string | null;
}

export interface StoredMessage {
  readonly role: "user" | "assistant";
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

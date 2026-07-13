/**
 * Conversation persistence for /chat.
 *
 * Browser localStorage, not Postgres: `POST /chat/stream` is stateless single-turn — it
 * takes a `message` and nothing else — so there is no server-side conversation to read
 * back. This keeps the thread list honest about what it is: a local, per-browser history
 * of what *this* machine asked. Promote-to-dataset is what makes a turn durable and
 * shared; that already goes through the API.
 *
 * When conversations become a server concern (multi-turn context, cross-device history),
 * replace this module — the ChatClient only ever touches it through these functions.
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

const KEY = "arnfar.chat.conversations.v1";
const MAX_CONVERSATIONS = 200;

/**
 * Client-only identifier, so the app-side UUIDv7 rule (cross-service ids) does not apply.
 * These ids never leave the browser — nothing in a promote/report payload references them.
 */
export function newConversationId(): string {
  return crypto.randomUUID();
}

/** First line of the opening question, clipped. Lao has no spaces, so clip on graphemes. */
export function titleFrom(question: string): string {
  const line = question.trim().split("\n")[0] ?? "";
  const chars = [...line];
  if (chars.length === 0) return "New chat";
  return chars.length > 48 ? `${chars.slice(0, 48).join("")}…` : line;
}

function isSource(v: unknown): v is StoredSource {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s["n"] === "number" &&
    typeof s["id"] === "string" &&
    typeof s["content"] === "string" &&
    Array.isArray(s["headingPath"]) &&
    s["headingPath"].every((h) => typeof h === "string") &&
    typeof s["kind"] === "string" &&
    typeof s["title"] === "string" &&
    (s["authority"] === null || typeof s["authority"] === "string") &&
    (s["effectiveDate"] === null || typeof s["effectiveDate"] === "string")
  );
}

function isMessage(v: unknown): v is StoredMessage {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (m["role"] !== "user" && m["role"] !== "assistant") return false;
  if (typeof m["content"] !== "string") return false;
  if (m["sources"] !== undefined && !(Array.isArray(m["sources"]) && m["sources"].every(isSource))) return false;
  if (m["question"] !== undefined && typeof m["question"] !== "string") return false;
  return true;
}

function isConversation(v: unknown): v is Conversation {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c["id"] === "string" &&
    typeof c["title"] === "string" &&
    typeof c["createdAt"] === "number" &&
    typeof c["updatedAt"] === "number" &&
    Array.isArray(c["messages"]) &&
    c["messages"].every(isMessage)
  );
}

/**
 * localStorage is user-writable and survives schema changes, so every record is validated
 * rather than trusted. A malformed record is dropped, not thrown on — a corrupt history
 * must never be able to white-screen the chat.
 */
export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isConversation).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveConversations(list: readonly Conversation[]): void {
  try {
    const trimmed = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // Quota exceeded or storage disabled (private window). The in-memory thread still
    // works for this session; losing history is strictly better than losing the answer.
  }
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

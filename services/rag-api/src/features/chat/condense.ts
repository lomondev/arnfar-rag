import { generate } from "../../lib/ollama.ts";
import type { HistoryTurn } from "./prompt.ts";

/** Standalone-question rewriting ("query condensation").
 *
 *  Retrieval embeds the question as written, so a follow-up that leans on the
 *  conversation — "ແລ້ວປີກາຍເດ?", "and vehicles?" — embeds to almost nothing and the
 *  dense arm comes back with noise. Putting the history in the *prompt* fixes what the
 *  generator sees but not what the retriever searched for. So we rewrite history +
 *  follow-up into ONE self-contained question, retrieve on that, and still hand the
 *  generator the user's original wording to answer.
 *
 *  The rewrite is a model output sitting on the retrieval path, so it is guarded:
 *  a rewrite that fails any check is discarded and the raw message is used instead.
 */

/** Turns the rewriter sees. Pronoun/ellipsis resolution needs the last exchange or two;
 *  more history only adds latency and gives the model room to drift off-topic. */
const CONDENSE_HISTORY_TURNS = 4;

/** Longer than this and the model is explaining itself, not asking a question. */
const MAX_CONDENSED_CHARS = 300;

/** Lao block, U+0E80–U+0EFF. */
const LAO_SCRIPT = /[຀-໿]/;

/** Labels a small model likes to prepend despite "output only the question". */
const LABEL_PREFIX =
  /^(standalone question|rewritten question|search query|question|query|ຄຳຖາມ)\s*[:：]\s*/i;

const WRAPPING_QUOTES = /^["'`«»“”]+|["'`«»“”]+$/g;

const SYSTEM = [
  "You rewrite a follow-up question into ONE self-contained question for a search engine.",
  "Rules:",
  "- Resolve pronouns and ellipsis from the conversation.",
  "- Keep the SAME language as the follow-up. Never translate.",
  "- Copy numbers, account codes, dates and names EXACTLY. Never invent any.",
  "- If the follow-up already stands alone, repeat it unchanged.",
  "- Output ONLY the question: no preamble, no quotes, no explanation.",
].join("\n");

/** Format anchors — one Lao, one English — so the model returns a bare question
 *  in the asker's language instead of a labelled, translated paraphrase. */
const EXAMPLES = [
  "Conversation:",
  "User: ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນເທົ່າໃດ?",
  "Assistant: ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນ 10%.",
  "Follow-up: ແລ້ວປີ 2023 ເດ?",
  "Rewritten: ອັດຕາອາກອນມູນຄ່າເພີ່ມ ໃນປີ 2023 ແມ່ນເທົ່າໃດ?",
  "",
  "Conversation:",
  "User: What is the depreciation method for buildings?",
  "Assistant: Straight-line over 20 years.",
  "Follow-up: and vehicles?",
  "Rewritten: What is the depreciation method for vehicles?",
].join("\n");

export interface CondensedQuery {
  /** The question retrieval actually runs on. */
  query: string;
  /** true when a rewrite passed every guard and replaced the raw message. */
  rewritten: boolean;
}

/** First non-empty line, stripped of the label and wrapping quotes a model may add.
 *  A question is one line, so anything after the first is commentary. */
function clean(raw: string): string {
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return "";
  return line.replace(LABEL_PREFIX, "").replace(WRAPPING_QUOTES, "").replace(/\s+/g, " ").trim();
}

/** Accept a rewrite only if it still looks like the user's question. */
function acceptable(original: string, candidate: string): boolean {
  if (candidate.length === 0) return false;
  if ([...candidate].length > MAX_CONDENSED_CHARS) return false;
  // Lao stays Lao (CLAUDE.md). Beyond the language rule: a rewrite that translated the
  // question to English would also empty the lexical arm, whose tsvector holds
  // LaoNLP-segmented Lao — the dense side would be left retrieving alone.
  if (LAO_SCRIPT.test(original) && !LAO_SCRIPT.test(candidate)) return false;
  return true;
}

/** Rewrite `message` into a standalone question using recent history.
 *
 *  Returns the original message unchanged when there is no history (nothing to
 *  resolve — the first turn is self-contained by definition, so no LLM call), when the
 *  rewriter is unreachable, or when the rewrite fails a guard.
 */
export async function condenseQuery(
  message: string,
  history: HistoryTurn[],
  model?: string,
): Promise<CondensedQuery> {
  const turns = history.slice(-CONDENSE_HISTORY_TURNS);
  if (turns.length === 0) return { query: message, rewritten: false };

  const convo = turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");
  const prompt = `${EXAMPLES}\n\nConversation:\n${convo}\nFollow-up: ${message}\nRewritten:`;

  let raw: string;
  try {
    raw = await generate(prompt, {
      system: SYSTEM,
      temperature: 0,
      maxTokens: 120,
      ...(model ? { model } : {}),
    });
  } catch {
    // Fails soft — a rewriter outage must not take chat down. Retrieve on the raw message.
    return { query: message, rewritten: false };
  }

  const candidate = clean(raw);
  return acceptable(message, candidate)
    ? { query: candidate, rewritten: true }
    : { query: message, rewritten: false };
}

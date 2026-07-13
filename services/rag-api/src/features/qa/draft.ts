import { generate } from "../../lib/ollama.ts";

/** LLM-draft a Lao Q&A pair grounded STRICTLY in one chunk. The draft is never
 *  trusted — it lands verified=false for human review (CLAUDE.md). */

const SYSTEM =
  "You are a Lao accounting assistant. Write questions and answers ONLY in Lao " +
  "(ພາສາລາວ). Ground every answer strictly in the provided text — never invent " +
  "facts, rates, or account codes. Keep it short and factual.";

export interface DraftedQa {
  question_lo: string;
  answer_lo: string;
}

export async function draftQaFromChunk(content: string): Promise<DraftedQa> {
  const prompt =
    `Text:\n"""${content}"""\n\n` +
    `From this text only, write ONE Lao question a Lao accountant might ask and its ` +
    `answer. Respond as JSON: {"question_lo": "...", "answer_lo": "..."}. Lao only.`;

  const raw = await generate(prompt, { system: SYSTEM, json: true, temperature: 0.3, maxTokens: 400 });
  let parsed: Partial<DraftedQa>;
  try {
    parsed = JSON.parse(raw) as Partial<DraftedQa>;
  } catch {
    throw new Error(`LLM draft was not valid JSON: ${raw.slice(0, 120)}`);
  }
  const q = (parsed.question_lo ?? "").trim();
  const a = (parsed.answer_lo ?? "").trim();
  if (!q || !a) throw new Error("LLM draft missing question_lo/answer_lo");
  return { question_lo: q, answer_lo: a };
}

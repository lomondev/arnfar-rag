import { generate } from "../../lib/ollama.ts";

/** Minimal RAG answer for eval (Phase 7 has the streaming chat version). Cite or
 *  abstain — never fill the gap from parametric memory. */
const SYSTEM =
  "You are a Lao accounting assistant. Answer in Lao (ພາສາລາວ) using ONLY the " +
  "provided context. Cite sources as [n]. If the context does not support an answer, " +
  "say in Lao that the information is not in the documents — never invent it.";

export async function ragAnswer(
  question: string,
  contexts: string[],
  model: string,
): Promise<string> {
  const ctx = contexts.map((c, i) => `[${i + 1}] ${c}`).join("\n");
  return generate(
    `Context:\n${ctx || "(none)"}\n\nQuestion: ${question}\n` +
      `Answer in Lao, citing [n], or state it is not in the documents:`,
    { model, system: SYSTEM, temperature: 0.2, maxTokens: 300 },
  );
}

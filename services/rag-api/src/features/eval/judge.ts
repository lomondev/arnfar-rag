import { generate } from "../../lib/ollama.ts";

/** LLM-as-judge for faithfulness. Cross-model by design (CLAUDE.md decision 4): the
 *  judge model must differ from the generator, else self-preference bias inflates the
 *  score. Calibrate against human labels before trusting the threshold. */

export interface Judgement {
  score: number; // 1..5 — is every claim supported by the context?
  supported: boolean;
  abstained: boolean; // did the answer say the info is not in the context?
  reason: string;
}

const SYSTEM =
  "You are a strict evaluator of a Lao accounting assistant. Judge ONLY whether the " +
  "answer is supported by the provided context. Do not use outside knowledge.";

export async function judgeFaithfulness(
  question: string,
  answer: string,
  contexts: string[],
  judgeModel: string,
): Promise<Judgement> {
  const ctx = contexts.map((c, i) => `[${i + 1}] ${c}`).join("\n");
  const prompt =
    `Question (Lao): ${question}\n\n` +
    `Context:\n${ctx || "(no context retrieved)"}\n\n` +
    `Answer: ${answer}\n\n` +
    `Is every factual claim in the Answer supported by the Context? Also say whether the ` +
    `Answer abstains (states the information is not available). Respond as JSON: ` +
    `{"score": 1-5, "supported": true/false, "abstained": true/false, "reason": "..."}`;

  const raw = await generate(prompt, {
    model: judgeModel,
    system: SYSTEM,
    json: true,
    temperature: 0,
    maxTokens: 200,
  });
  try {
    const p = JSON.parse(raw) as Partial<Judgement>;
    const score = Math.max(1, Math.min(5, Number(p.score) || 1));
    return {
      score,
      supported: Boolean(p.supported),
      abstained: Boolean(p.abstained),
      reason: (p.reason ?? "").toString().slice(0, 500),
    };
  } catch {
    return { score: 1, supported: false, abstained: false, reason: `unparseable judge output: ${raw.slice(0, 80)}` };
  }
}

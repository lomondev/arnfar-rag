function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.RAG_API_PORT ?? 7730),
  databaseUrl: req("DATABASE_URL"),

  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  embedModel: process.env.OLLAMA_EMBED_MODEL ?? "bge-m3",
  // SEA-LION (Gemma-based, tuned for SE-Asian languages) is the best local Lao
  // generator on this host; it follows the cite-or-abstain instruction cleanly.
  genModel:
    process.env.OLLAMA_GEN_MODEL ?? "hf.co/aisingapore/Gemma-SEA-LION-v3-9B-IT-GGUF:latest",
  // Cross-FAMILY judge (CLAUDE.md decision 4) — qwen ≠ the Gemma-based generator.
  genModelAlt: process.env.OLLAMA_GEN_MODEL_ALT ?? "qwen3:8b",
  embedConcurrency: Number(process.env.OLLAMA_EMBED_CONCURRENCY ?? 4),

  laoNlpUrl: process.env.LAO_NLP_URL ?? "http://localhost:7731",
  docxExtractorUrl: process.env.DOCX_EXTRACTOR_URL ?? "http://localhost:7732",

  storageRoot: process.env.STORAGE_FS_ROOT ?? "./storage",

  // Single-tenant dev seed; the columns/filters exist everywhere regardless.
  devHfId: req("DEV_HF_ID"),
  devCompanyId: req("DEV_COMPANY_ID"),
  devBranchId: process.env.DEV_BRANCH_ID ?? null,
} as const;

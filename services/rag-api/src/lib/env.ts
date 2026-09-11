function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

/** Comma-separated origin list → array, with blanks dropped. */
function originList(raw: string | undefined, fallback: readonly string[]): string[] {
  const parsed = (raw ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

export const env = {
  port: Number(process.env.RAG_API_PORT ?? 7730),
  /**
   * Network interface to bind.
   *
   * Loopback by default: this API has no authentication layer, so anything that can reach
   * the port can read every ledger it serves. Bun's own default is 0.0.0.0, which meant
   * the service was reachable from the whole local network without anyone choosing that.
   * Set RAG_API_HOST=0.0.0.0 to serve other machines — deliberately, and having read the
   * "Serving the site over your network" section of the README.
   */
  host: process.env.RAG_API_HOST ?? "127.0.0.1",
  databaseUrl: req("DATABASE_URL"),

  // Browser origins allowed to call this API. Defaults to the local web app only —
  // `cors()` with no argument allows every origin, which for a service holding client
  // accounting data means any page the user visits can read it.
  corsOrigins: originList(process.env.CORS_ORIGINS, ["http://localhost:3000"]),
  /**
   * Also accept browser origins on private (RFC1918) addresses.
   *
   * Serving the Studio over a LAN means the origin is whatever address the visitor typed,
   * and on DHCP that changes — pinning it in CORS_ORIGINS breaks on the next lease. This
   * accepts any private-range origin on the web port instead, which is bounded in a way
   * `*` is not: a public site cannot match it.
   *
   * It is a convenience for browsers, NOT a security control. CORS is enforced by the
   * browser and does nothing about curl, so an exposed port is exposed regardless.
   */
  corsAllowPrivateNetwork:
    (process.env.CORS_ALLOW_PRIVATE_NETWORK ?? "false").toLowerCase() === "true",

  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  embedModel: process.env.OLLAMA_EMBED_MODEL ?? "bge-m3",
  // SEA-LION (Gemma-based, tuned for SE-Asian languages) is the best local Lao
  // generator on this host; it follows the cite-or-abstain instruction cleanly.
  genModel: process.env.OLLAMA_GEN_MODEL ?? "hf.co/aisingapore/Gemma-SEA-LION-v3-9B-IT-GGUF:latest",
  // Cross-FAMILY judge (CLAUDE.md decision 4) — qwen ≠ the Gemma-based generator.
  genModelAlt: process.env.OLLAMA_GEN_MODEL_ALT ?? "qwen3:8b",
  /**
   * Model that verifies delivered chat answers (features/chat/verify.ts).
   *
   * Cross-family by requirement (CLAUDE.md decision 4) — Qwen is not Gemma-based like the
   * SEA-LION generator, so it is not scoring its own output. **3B, not 8B, and that is a
   * memory decision, not a quality one:** the verifier runs CPU-only (see verifyOnCpu), so
   * its weights sit in SYSTEM RAM. Measured on this box — 15.4 GB total, SEA-LION 6.8 GB,
   * bge-m3 1.5 GB, Postgres, two Python sidecars and Next.js — adding a 6.7 GB
   * CPU-resident qwen3:8b exhausted swap and the kernel OOM-killed llama-server *mid
   * generation*, taking a user's in-flight answer with it.
   *
   * qwen2.5:3b-instruct is 1.9 GB and leaves headroom. Raise it to qwen3:8b only on a box
   * with the RAM to spare — a sharper judge is worthless if it kills the thing it judges.
   */
  verifyModel: process.env.OLLAMA_VERIFY_MODEL ?? "qwen2.5:3b-instruct",
  /**
   * How long Ollama keeps the verifier resident after a verdict.
   *
   * "0s" = unload immediately. Ollama's default is five minutes, which for a CPU-resident
   * model means minutes of held system RAM to serve one background check that has already
   * finished. Verification is bursty and infrequent; paying a reload per verdict is the
   * right trade on a memory-constrained host.
   */
  verifyKeepAlive: process.env.OLLAMA_VERIFY_KEEP_ALIVE ?? "0s",
  /**
   * Run verification on the CPU (`num_gpu: 0`) rather than the GPU.
   *
   * On by default, and the reason is arithmetic: an 8 GB card does not hold a 9B generator
   * and a second model at once. Letting the judge onto the GPU evicts the generator, so the
   * NEXT question pays a 5–15 s model reload — the user's chat gets slower so a background
   * check can finish sooner, which is exactly backwards. Verified in practice: with
   * cpuOnly set, `ollama ps` reports the judge at 100% CPU while the generator keeps the
   * card.
   *
   * The cost is system RAM instead of VRAM — see the sizing note on verifyModel above.
   * Set false only on a machine with VRAM to spare.
   */
  verifyOnCpu: (process.env.OLLAMA_VERIFY_ON_CPU ?? "true").toLowerCase() !== "false",
  /**
   * Verify every delivered answer in the background.
   *
   * **Default OFF, and that is a measured decision, not caution.** CLAUDE.md decision 4
   * requires the judge be calibrated against ~20 human labels before its verdict is
   * trusted, and the two candidate judges on this hardware both fail a different way
   * before that calibration exists:
   *
   *   qwen3:8b            accurate (scored a correct Lao answer 5/5, with reasoning that
   *                       quoted the right source) — but 6.7 GB CPU-resident alongside the
   *                       generator exhausted swap and the kernel OOM-killed llama-server
   *                       mid-answer.
   *   qwen2.5:3b-instruct memory-safe — but scored that SAME correct answer 1/5
   *                       "not supported", against a corpus that plainly supports it.
   *
   * A badge that cries wolf on correct answers teaches people to ignore it, which is worse
   * than no badge. So the loop is built, tested and off: turn it on once the judge has been
   * calibrated, or use POST /chat/messages/:id/verify to check one answer on demand.
   */
  verifyAnswers: (process.env.CHAT_VERIFY_ANSWERS ?? "false").toLowerCase() === "true",
  embedConcurrency: Number(process.env.OLLAMA_EMBED_CONCURRENCY ?? 4),
  // Lao word/sentence correction (the /lao/check rewrite). gemma-3n-laos is a
  // Lao-fine-tuned Gemma 3n (6.9B, 32k ctx) — it follows the minimal-edit contract
  // exactly: applies the fixes LaoNLP + the glossary found, returns clean text
  // unchanged, never paraphrases. Pull it with:
  //   ollama pull gemma-3n-laos:Q4_K_M   (or set this to any installed model)
  laoCorrectModel: process.env.OLLAMA_LAO_CORRECT_MODEL ?? "gemma-3n-laos:Q4_K_M",
  // Generation context window (prompt + answer tokens). SEA-LION v3 (Gemma2) maxes at
  // 8192. Ollama's own default is VRAM-based (4096 on an 8GB card) and when the prompt
  // overflows it context-shifts the OLDEST tokens out — i.e. the system persona,
  // glossary, and first retrieved sources silently vanish, which reads as "the model
  // doesn't understand Lao". Always set this explicitly. Lower it only if generation
  // becomes too slow on small VRAM.
  genNumCtx: Number(process.env.OLLAMA_NUM_CTX ?? 8192),

  laoNlpUrl: process.env.LAO_NLP_URL ?? "http://localhost:7731",
  docxExtractorUrl: process.env.DOCX_EXTRACTOR_URL ?? "http://localhost:7732",

  storageRoot: process.env.STORAGE_FS_ROOT ?? "./storage",

  // The company's ERP database (read-only role recommended). Unset = the bundled
  // demo `erp` schema in the app's own database. See docs/ERP-INTEGRATION.md.
  erpDatabaseUrl: process.env.ERP_DATABASE_URL ?? null,
  // Demo mode re-seeds its fixtures whenever erp.customer is empty, so deleting the
  // rows does not remove them — the next tool call puts them back. Set
  // ERP_DEMO_SEED=false to keep a deliberately emptied ERP schema empty. Defaults to
  // seeding, so a fresh clone still has a working demo out of the box.
  erpDemoSeed: (process.env.ERP_DEMO_SEED ?? "true").toLowerCase() !== "false",

  // Single-tenant dev seed; the columns/filters exist everywhere regardless.
  devHfId: req("DEV_HF_ID"),
  devCompanyId: req("DEV_COMPANY_ID"),
  devBranchId: process.env.DEV_BRANCH_ID ?? null,
} as const;

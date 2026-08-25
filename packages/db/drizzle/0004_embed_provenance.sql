-- Embedding provenance.
--
-- Records which Ollama model produced each vector. OLLAMA_EMBED_MODEL is configurable and
-- vectors from two models share no geometry, so a mixed index degrades recall with no
-- error to notice: both bge-m3 and multilingual-e5-large are 1024-dim, and halfvec(1024)
-- accepts either.
--
-- Deliberately NOT backfilled. Rows embedded before this column existed have unknown
-- provenance, and stamping them with the currently-configured model would turn a knowable
-- unknown into a confident wrong answer. `bun run db:reembed` reports them and offers both
-- honest resolutions: re-embed, or --stamp when you know what produced them.

ALTER TABLE "rag_chunk" ADD COLUMN "embed_model" text;--> statement-breakpoint
CREATE INDEX "rag_chunk_embed_model" ON "rag_chunk" USING btree ("embed_model") WHERE embed_model IS NOT NULL;--> statement-breakpoint
ALTER TABLE "rag_chunk" ADD CONSTRAINT "rag_chunk_embed_model_needs_vector" CHECK (embedding IS NOT NULL OR embed_model IS NULL);
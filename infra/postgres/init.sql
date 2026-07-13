-- Runs once on first cluster init (docker-entrypoint-initdb.d).
-- Extensions the schema depends on. pgvector must be >= 0.8 (halfvec + HNSW iterative scan).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Sanity: fail loudly at init if the image ships an old pgvector.
DO $$
DECLARE
  v TEXT;
BEGIN
  SELECT extversion INTO v FROM pg_extension WHERE extname = 'vector';
  IF string_to_array(v, '.')::int[] < ARRAY[0, 8, 0] THEN
    RAISE EXCEPTION 'pgvector % is too old; need >= 0.8.0 (halfvec + HNSW iterative scan)', v;
  END IF;
  RAISE NOTICE 'pgvector % OK', v;
END $$;

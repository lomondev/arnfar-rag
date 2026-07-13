/** Build a REAL eval set from the ingested accounting document:
 *   1. purge synthetic data (keep only the real doc), so retrieval measures real content
 *   2. generate grounded chart-of-accounts lookup questions where the gold chunk is known
 *   3. insert them as verified lao_qa_pair (gold = citation_ids)
 *  Adversarial (out-of-corpus) questions are passed to the eval RUN, not stored here. */
import postgres from "postgres";
import { uuidv7 } from "uuidv7";

const url = process.env.DATABASE_URL ?? "postgres://arnfar:change-me-locally@localhost:5433/arnfar";
const sql = postgres(url, { max: 1 });

const HF = "018f9a1e-7c00-7000-8000-000000000001";
const CO = "018f9a1e-7c00-7000-8000-000000000002";
const REAL_TITLE = "ການບັນຊີ ວຽກງານທ້າຍສະໄໝ";

try {
  const real = await sql<{ id: string }[]>`
    SELECT id FROM rag_document WHERE hf_id=${HF} AND title=${REAL_TITLE} ORDER BY created_at DESC LIMIT 1`;
  if (!real[0]) throw new Error("real document not found — ingest it first");
  const docId = real[0].id;

  // 1. purge everything else (dev-tenant non-real docs + the synthetic bench tenant).
  const delDocs = await sql`DELETE FROM rag_document WHERE hf_id=${HF} AND id<>${docId} RETURNING id`;
  const delBench = await sql`DELETE FROM rag_document WHERE hf_id='018f0000-0000-7000-8000-0000000000bb' RETURNING id`;
  await sql`DELETE FROM lao_account WHERE hf_id=${HF} AND (document_id IS NULL OR document_id<>${docId})`;
  await sql`DELETE FROM lao_qa_pair WHERE hf_id=${HF}`;
  console.log(`purged ${delDocs.length} dev docs + ${delBench.length} bench docs; cleared QA`);

  // 2. real account-row chunks → group by code (dedup; gold = all chunks with that code).
  const rows = await sql<{ id: string; content: string; code: string | null }[]>`
    SELECT id, content, meta->>'account_code' AS code
    FROM rag_chunk
    WHERE hf_id=${HF} AND kind='account_row' AND review<>'rejected'`;

  const byCode = new Map<string, { name: string; ids: string[] }>();
  for (const r of rows) {
    const code = (r.code ?? "").trim();
    if (!/^[0-9]{3,6}$/.test(code)) continue;
    const name = r.content.replace(new RegExp(`^${code}\\s*`), "").split("—")[0]!.trim();
    if (!name) continue;
    const e = byCode.get(code) ?? { name, ids: [] };
    e.ids.push(r.id);
    byCode.set(code, e);
  }

  // 3. build questions (alternate templates so it's not one fixed phrasing).
  const templates = (name: string) => [
    `ບັນຊີ ${name} ມີລະຫັດຫຍັງ?`,
    `ລະຫັດ ຂອງ ${name} ແມ່ນຫຍັງ?`,
  ];
  let seq = 0;
  const codes = [...byCode.entries()];
  for (const [code, { name, ids }] of codes) {
    const q = templates(name)[seq % 2]!;
    seq++;
    await sql`
      INSERT INTO lao_qa_pair (id, hf_id, company_id, collection, question_lo, answer_lo,
                               citation_ids, difficulty, tags, source, split, verified, verified_by)
      VALUES (${uuidv7()}, ${HF}, ${CO}, 'coa', ${q}, ${`ລະຫັດ ${code}.`},
              ${ids}::uuid[], 1, ARRAY['coa','lookup'], 'human', 'unassigned', true, 'eval-builder')`;
  }
  console.log(`inserted ${codes.length} verified CoA eval questions (gold = account-row chunks)`);

  const remain = await sql<{ n: number }[]>`
    SELECT count(*)::int n FROM rag_chunk WHERE hf_id=${HF} AND review<>'rejected'`;
  console.log(`real corpus chunks remaining: ${remain[0]?.n ?? 0}`);
} finally {
  await sql.end();
}

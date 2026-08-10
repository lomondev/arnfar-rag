# Arnfar RAG — Data Format Standard

How to author data so the assistant **understands it fully** and **answers correctly**.

This is the canonical, code-verified standard. Where this document and any older guide
disagree, this one wins — it is versioned with the code it describes.

Scope: the `accounting` domain today. The same five formats are reused for all 25 ERP
domains (`services/rag-api/src/domains/registry.ts`); a new domain is a different *mix*
of the same formats, never a new format.

---

## 1. Why format decides correctness

The assistant has no memory of your documents. At answer time it sees exactly two things:
the **numbered context block** built from retrieved chunks, and the **system prompt**. That
is all. Anything not in those does not exist for the model.

So a wrong answer is almost always one of three authoring failures, in this order:

1. **Not retrievable** — the chunk exists but the query never finds it. Caused by broken
   Lao text, bad chunk boundaries, or missing headings.
2. **Not groundable** — retrieved, but the text does not actually contain the answer, so the
   model either abstains or invents. Caused by chunks that are too big, too vague, or split
   away from the number they explain.
3. **Not attributable** — correct content, but no authority or effective date, so the reader
   cannot tell whether a tax rate is current. For accounting this is the dangerous one: a
   confidently-cited superseded rate is worse than no answer.

Formatting well is how you prevent all three.

---

## 2. The contract at answer time

This is the exact shape each retrieved source takes in the prompt
(`services/rag-api/src/features/chat/prompt.ts`):

```
[1] (ພາກທີ 3 › ອາກອນມູນຄ່າເພີ່ມ, authority: ກະຊວງການເງິນ, effective: 2026-01-01)
ອັດຕາອາກອນມູນຄ່າເພີ່ມ ມາດຕະຖານ ແມ່ນ 10 ສ່ວນຮ້ອຍ ...
```

Four consequences you must author for:

| Element | Comes from | What it means for you |
|---|---|---|
| `[1]` | retrieval order | The model cites this number. A claim without one is an abstention. |
| heading path | `rag_chunk.heading_path` | The chunk's address. Real headings make citations legible; no headings makes every chunk anonymous. |
| `authority`, `effective` | `rag_document` | Set at **ingest time**, per document. Never inside the file body. |
| body text | `rag_chunk.content` | **Capped at 700 characters** in the prompt. A chunk longer than that is silently truncated. |

That 700-character cap is the single most under-appreciated rule here. A 2,000-character
chunk reaches the model as its first third. If the answer lives in the last paragraph, the
model cannot see it — retrieval "worked" and the answer is still wrong.

---

## 3. The five formats

| | Format | Content | Lands in | Endpoint |
|---|---|---|---|---|
| **F1** | `.md` / `.docx` | Narrative knowledge — law, standards, SOPs | `rag_chunk` | `POST /ingest/docx` |
| **F2** | CSV | Master data — chart of accounts | `lao_account` | `POST /accounts/` |
| **F3** | JSON/Markdown | Worked transactions — journal entries | `rag_chunk` | via F1 |
| **F4** | CSV | Bilingual glossary | `lao_term` | `POST /glossary/` |
| **F5** | JSONL | QA pairs — eval now, fine-tuning later | `lao_qa_pair` | `POST /qa/` |

Fill-in templates live in [`templates/accounting/`](../templates/accounting/) and load with
`bun run templates/accounting/load.ts`.

---

### F1 — Narrative knowledge (`.md`, `.docx`)

The backbone. Everything the assistant knows about rules and procedures enters here.

**`.md` and `.markdown` are ingested directly**, parsed in-process; other files go to the
docx-extractor sidecar. The endpoint is still named `/ingest/docx` for both. Markdown is the
preferred authoring format — it is diffable, reviewable, and its structure maps exactly onto
chunk boundaries.

Upload as multipart form:

```bash
curl -X POST http://localhost:7730/ingest/docx \
  -F "file=@vat-rate.md" \
  -F "collection=tax" \
  -F "title=ກົດໝາຍວ່າດ້ວຍອາກອນມູນຄ່າເພີ່ມ" \
  -F "authority=ກະຊວງການເງິນ" \
  -F "effectiveDate=2026-01-01" \
  -F "license=internal"
```

| Field | Required | Notes |
|---|---|---|
| `file` | yes | UTF-8. UTF-16 is auto-detected and decoded with a warning — re-save as UTF-8. |
| `collection` | yes | Free text; user-creatable. e.g. `tax`, `coa`, `sop`, `lao-accounting-law` |
| `title` | no | Defaults to the filename. Shown in citations — always set it. |
| `authority` | no | Issuing body. Required for anything legal. |
| `effectiveDate` | no | `YYYY-MM-DD`. A malformed value is rejected with 422. |
| `license` | no | Defaults `internal`. Use `client-confidential` to exclude from shareable exports. |

> **YAML frontmatter is skipped, not read.** The parser strips a leading `---` block and
> emits a warning. Metadata authored there is silently discarded — it must be passed as
> form fields above. This is the most common authoring mistake.

**Structure that chunks well.** The chunker merges prose to 400 tokens with 60 tokens of
overlap and **never merges across a heading**, so your headings *are* your chunk boundaries:

```markdown
# ອາກອນມູນຄ່າເພີ່ມ

## ອັດຕາມາດຕະຖານ

ອັດຕາອາກອນມູນຄ່າເພີ່ມ ມາດຕະຖານ ແມ່ນ 10 ສ່ວນຮ້ອຍ ຂອງມູນຄ່າສິນຄ້າ ແລະ ການບໍລິການ.

## ການຍົກເວັ້ນ

ການສົ່ງອອກ ໄດ້ຮັບອັດຕາ 0 ສ່ວນຮ້ອຍ.

| ລະຫັດ | ລາຍການ | ອັດຕາ |
| --- | --- | --- |
| 4331 | ອາກອນມູນຄ່າເພີ່ມຕ້ອງສົ່ງ | 10% |
```

Supported: ATX (`#`–`######`) and setext headings, GFM pipe tables, lists, fenced code,
blockquotes. Tables become **one atomic chunk** — never split across rows, even when large.

**One heading, one answerable idea.** If a section answers three questions, split it into
three. That is what keeps chunks under the 700-character prompt cap.

#### Replacing an old version — supersession

When a law or standard is amended, **ingest the new version as its own document and link the
old one to it.** Do not edit the old document, and do not delete it.

```bash
curl -X PATCH http://localhost:7730/ingest/documents/<OLD_ID>/supersede \
  -H 'content-type: application/json' \
  -d '{"supersededBy":"<NEW_ID>"}'
```

Pass `{"supersededBy": null}` to undo it. Rejected with 422: superseding a document by
itself, pointing at a document in another tenant, or creating a cycle.

The old document **stays retrievable on purpose** — "what was the rate in 2023?" is a real
question only the old law answers, and hiding it would make that unanswerable. What changes
is the citation: every hit from it now carries `⚠ SUPERSEDED by "<title>" effective <date>`,
and the assistant is instructed to never present it as current, to name the replacement, and
to answer from the replacement when both are retrieved. Ranking is untouched.

Superseded documents are also marked in the exported `DATA_CARD.md`.

---

### F2 — Chart of accounts (CSV)

`code, name_lo, name_en, parent_code, class, normal_balance, statement`

```csv
code,name_lo,name_en,parent_code,class,normal_balance,statement
1010,ເງິນສົດໃນມື,Cash on hand,101,asset,debit,BS
4331,ອາກອນມູນຄ່າເພີ່ມຕ້ອງສົ່ງ,VAT payable,433,liability,credit,BS
```

Enums are enforced at the API boundary — anything else is a 422:

- `class` — `asset` · `liability` · `equity` · `revenue` · `expense`
- `normal_balance` — `debit` · `credit` (asset/expense debit; liability/equity/revenue credit; contra-accounts flip)
- `statement` — `BS` · `PL` · `CF` · `NONE`

`parent_code` is empty for top-level accounts, otherwise the parent's `code`. Use **your**
official Lao chart of accounts; the sample plan is a placeholder.

Rows arrive `verified = false`. Extraction proposes, a person disposes — approve in
`/studio/knowledge`.

---

### F3 — Worked transactions

A journal entry teaches the pattern a rule only describes, and is what lets the assistant
answer "how do I record this?" rather than merely quoting the rule.

Author them as F1 markdown with a table per entry, under a descriptive heading:

```markdown
## ຮັບເງິນຈາກລູກຄ້າ ຕາມໃບເກັບເງິນ INV-2026-001

| ລະຫັດ | ຊື່ບັນຊີ | ເດບິດ (ກີບ) | ເຄຣດິດ (ກີບ) |
| --- | --- | --- | --- |
| 531 | ເງິນຝາກທະນາຄານ | 6000000 | 0 |
| 411 | ລູກໜີ້ການຄ້າ | 0 | 6000000 |
```

**Amounts are whole kip integers** — `6000000`, never `6,000,000.00`, never `6.0M`. The
extractor captures the literal string it finds; it does not parse or round. Write the number
you mean.

---

### F4 — Glossary (CSV)

`term_lo, term_en, definition_lo, definition_en, variants_lo, forbidden_lo`

```csv
term_lo,term_en,definition_lo,definition_en,variants_lo,forbidden_lo
ອາກອນມູນຄ່າເພີ່ມ,VAT,ອາກອນທີ່ເກັບຈາກມູນຄ່າເພີ່ມ,Value-added tax,ພາສີມູນຄ່າເພີ່ມ,ວ.ອ.ມ
```

The glossary is not documentation — it is **wired into two live paths**:

1. **Terminology control.** Verified terms are injected into the system prompt as the only
   approved vocabulary, and `forbidden_lo` becomes an explicit do-not-use list. This is how
   you stop the model inventing plausible-but-wrong Lao accounting terms.
2. **Cross-language retrieval.** A verified `term_en` appearing in a question appends the
   Lao form to the lexical query, so an English question can reach a Lao corpus.

`term_en` is required. Separate multiple `variants_lo` / `forbidden_lo` with `|`. Quote any
field containing a comma.

---

### F5 — QA pairs (JSONL, one object per line)

```json
{"question_lo":"ອັດຕາອາກອນມູນຄ່າເພີ່ມ ມາດຕະຖານ ແມ່ນເທົ່າໃດ?","answer_lo":"ອັດຕາມາດຕະຖານ ແມ່ນ 10 ສ່ວນຮ້ອຍ.","citation_query":"ອັດຕາອາກອນມູນຄ່າເພີ່ມ ມາດຕະຖານ","tags":["vat"],"difficulty":2,"source":"human"}
```

| Field | Required | Notes |
|---|---|---|
| `question_lo`, `answer_lo` | yes | Natural Lao, as a real user would ask. |
| `citation_ids` | yes¹ | Real chunk UUIDs. **Minimum one** — enforced at creation. |
| `citation_query` | yes¹ | Loader-only convenience: searches the corpus and cites the top hit. |
| `question_en`, `answer_en` | no | Glosses alongside, never replacing the Lao. |
| `difficulty` | no | 1 (easy) – 5 (hard) |
| `source` | no | `human` · `chat_promoted` |

¹ Provide one or the other. `citation_query` resolves to a real id at load time — **check
what it resolved to.** A confidently wrong citation is worse than a missing one.

Validation is enforced server-side: every id must exist in the tenant and none may reference
a rejected chunk. Editing a pair **resets `verified` to false** — an edited answer must be
re-approved.

After loading, run `POST /qa/assign-splits`. Splits are assigned **by document**, so pairs
from one source never straddle train and test. `qa_test.jsonl` is held out and must never be
used for tuning.

---

## 4. Content element formats — the default for every kind of content

§3 covers which *file* to use. This section is the default for the content *inside* an F1
document: one agreed way to write each kind of element, so every author produces the same
shape and the chunker behaves predictably.

**Start from the template:** [`templates/accounting/knowledge/_TEMPLATE.md`](../templates/accounting/knowledge/_TEMPLATE.md)
is a fill-in-the-blank document containing every element below, correctly formatted. Copy it
and replace the content.

### Quick reference

| Element | Write it as | Becomes | Chunking behaviour |
|---|---|---|---|
| Section title | `## ຫົວຂໍ້` | `heading` | **Boundary** — chunks never merge across it |
| Text | plain lines, blank line between paragraphs | `prose` | Merged up to 400 tokens, 60 overlap |
| Bullet point | `- ຂໍ້ຄວາມ` | `list` | Merged into the surrounding prose chunk |
| Numbered step | `1. ຂັ້ນຕອນ` | `list` | Same as bullets |
| Table | GFM pipe table | `table` | **Atomic** — one chunk, never split |
| Choice / options | table: condition → outcome | `table` | Atomic — keeps option with its consequence |
| Definition | `**ຄຳສັບ** — ຄວາມໝາຍ` | `prose` | Also add an F4 glossary row |
| Formula | fenced code block | `prose` | Fences stripped, text kept verbatim |
| Quoted law | `> ຂໍ້ຄວາມ` | `prose` | `>` stripped, text kept |
| Amount | `6000000` | — | Whole kip, captured as a literal |
| Date | `2026-01-01` | — | ISO; the document's own date goes in the form field |

### Text

One idea per paragraph, blank line between. Keep a paragraph under ~700 characters so it
survives the prompt cap whole.

```markdown
ອັດຕາອາກອນມູນຄ່າເພີ່ມ ມາດຕະຖານ ແມ່ນ 10 ສ່ວນຮ້ອຍ ຂອງມູນຄ່າສິນຄ້າ ແລະ ການບໍລິການ.

ຜູ້ປະກອບການ ຕ້ອງແຈ້ງອາກອນ ພາຍໃນ ວັນທີ 20 ຂອງເດືອນຖັດໄປ.
```

Write self-contained sentences. "ອັດຕານີ້ ແມ່ນ 10 ສ່ວນຮ້ອຍ" ("this rate is 10%") is useless
once retrieved alone — the reader cannot tell which rate. Name the subject in the sentence.

### Bullet points

Use for unordered facts, conditions, or requirements. One fact per bullet, each readable on
its own. Always introduce the list with a line ending in `:` so the list has context.

```markdown
ເອກະສານທີ່ຕ້ອງມີ ໃນການແຈ້ງອາກອນ:

- ໃບເກັບເງິນ ທີ່ອອກໃນເດືອນນັ້ນ
- ບົດລາຍງານ ຍອດຂາຍ ປະຈຳເດືອນ
- ໃບຢັ້ງຢືນ ການຫັກອາກອນ ຖ້າມີ
```

Keep a list under about 10 items. Bullets merge into the surrounding prose chunk, so a very
long list will be cut at the 400-token boundary and its tail separated from its introduction.
If you need more, split with a sub-heading.

### Numbered steps

Use only when order matters. One action per step, imperative, self-contained.

```markdown
ຂັ້ນຕອນ ການປິດບັນຊີ ທ້າຍເດືອນ:

1. ກວດສອບ ຍອດເງິນສົດ ໃຫ້ກົງກັບ ໃບແຈ້ງຍອດທະນາຄານ.
2. ບັນທຶກ ຄ່າເສື່ອມລາຄາ ປະຈຳເດືອນ.
3. ສະສາງ ບັນຊີ ອາກອນມູນຄ່າເພີ່ມ.
```

### Tables

The strongest format for facts, because a table is **one atomic chunk** — it is never split,
so a code never gets separated from its meaning. Use a table whenever content has repeating
structure.

```markdown
| ລະຫັດ | ຊື່ບັນຊີ | ໝວດ | ຍອດປົກກະຕິ |
| --- | --- | --- | --- |
| 1010 | ເງິນສົດໃນມື | ຊັບສິນ | ເດບິດ |
| 4331 | ອາກອນມູນຄ່າເພີ່ມຕ້ອງສົ່ງ | ໜີ້ສິນ | ເຄຣດິດ |
```

Rules: always include the header row and the `| --- |` separator (without it the lines are
parsed as ordinary text, not a table); never leave the first column blank; keep one table per
heading; and never split one logical table into two.

### Choice / options / conditions

This is where wrong answers are most often *authored in*. The rule: **each option must carry
its condition and its outcome on the same row.** If the conditions live in one place and the
outcomes in another, retrieval can surface one without the other and the model will pair them
up incorrectly.

```markdown
## ວິທີຄິດໄລ່ຄ່າເສື່ອມລາຄາ ຕາມປະເພດຊັບສິນ

| ປະເພດຊັບສິນ | ວິທີຄິດໄລ່ | ອາຍຸການນຳໃຊ້ | ອັດຕາຕໍ່ປີ |
| --- | --- | --- | --- |
| ອາຄານ | ເສັ້ນຊື່ | 20 ປີ | 5% |
| ພາຫະນະ | ເສັ້ນຊື່ | 5 ປີ | 20% |
| ຄອມພິວເຕີ | ເສັ້ນຊື່ | 3 ປີ | 33% |
```

For a yes/no or branching rule, keep the whole condition in one bullet:

```markdown
- ຖ້າ ລາຍຮັບ ຕໍ່ປີ ຕ່ຳກວ່າ 400000000 ກີບ — ບໍ່ຕ້ອງ ຈົດທະບຽນ ອາກອນມູນຄ່າເພີ່ມ.
- ຖ້າ ລາຍຮັບ ຕໍ່ປີ ເທົ່າກັບ ຫຼື ສູງກວ່າ 400000000 ກີບ — ຕ້ອງ ຈົດທະບຽນ ພາຍໃນ 30 ວັນ.
```

Never write "ເລືອກວິທີໃດວິທີໜຶ່ງ ຂ້າງເທິງ" ("choose one of the above") — "above" does not
survive chunking.

### Definitions

Bold the term, em-dash, then the meaning. Add a matching F4 glossary row so the term is also
under terminology control.

```markdown
**ອາກອນມູນຄ່າເພີ່ມ** — ອາກອນ ທີ່ເກັບຈາກ ມູນຄ່າເພີ່ມ ຂອງສິນຄ້າ ແລະ ການບໍລິການ ໃນແຕ່ລະຂັ້ນຕອນ.
```

### Formulas

Fenced code keeps the expression verbatim. Always follow it with a worked example using real
numbers — the example is what the assistant can actually reason from.

````markdown
```
ຄ່າເສື່ອມລາຄາ ຕໍ່ປີ = (ລາຄາຊື້ - ມູນຄ່າຊາກ) ÷ ອາຍຸການນຳໃຊ້
```

ຕົວຢ່າງ: ອາຄານ ລາຄາ 500000000 ກີບ, ມູນຄ່າຊາກ 20000000 ກີບ, ອາຍຸ 20 ປີ
→ (500000000 - 20000000) ÷ 20 = 24000000 ກີບ ຕໍ່ປີ.
````

### Quoted law

Blockquote the provision, then explain it in your own words. The `>` marker is stripped and
the text kept, so the quote stays retrievable.

```markdown
> ມາດຕາ 12: ຜູ້ປະກອບການ ຕ້ອງແຈ້ງອາກອນ ພາຍໃນ ວັນທີ 20 ຂອງເດືອນຖັດໄປ.

ໝາຍຄວາມວ່າ ການແຈ້ງ ສຳລັບເດືອນ ມັງກອນ ຕ້ອງສົ່ງ ກ່ອນ ວັນທີ 20 ກຸມພາ.
```

### Amounts and dates

- Amounts: whole kip integers — `6000000`. No separators, no decimals, no `M`/`ລ້ານ` shorthand.
- Dates in body text: ISO `2026-01-01`.
- The document's own effective date is **not** written in the body — it goes in the
  `effectiveDate` form field at ingest, so it appears in every citation automatically.

### FAQ-style content

The single best-retrieving shape: make the **question the heading** and the answer the body.
It matches how users actually ask, so the heading path alone often carries the answer.

```markdown
## ຕ້ອງແຈ້ງອາກອນມູນຄ່າເພີ່ມ ເມື່ອໃດ?

ຕ້ອງແຈ້ງ ພາຍໃນ ວັນທີ 20 ຂອງເດືອນຖັດໄປ.
```

---

## 5. The gates that keep answers correct

These are enforced in SQL and at API boundaries, not by convention:

1. **Cite or abstain.** Every factual claim carries `[n]`. No supporting context means the
   assistant says so in Lao rather than guessing.
2. **A rejected chunk never appears in retrieval and never exports.**
3. **Only `verified = true` rows export.** Unverified drafts never leave the building.
4. **A QA pair cannot export without a non-empty citation set** where every id resolves to a
   non-rejected chunk.
5. **Train/test split by document**, never by row.
6. **`license = 'client-confidential'` is excluded from shareable exports** in the query.
7. **Every export is immutable and versioned** under `datasets/lao-accounting/vX.Y.Z/`, with
   a `MANIFEST.json` (sha256 per file) and a `DATA_CARD.md`.
8. **A superseded source is never presented as current.** Link the old document to its
   replacement (see F1) and every citation from it carries the warning.

An export emits `chunks.jsonl`, `glossary.jsonl`, `chart_of_accounts.jsonl`,
`qa_{train,dev,test}.jsonl`, `eval_set.jsonl`, plus `MANIFEST.json`, `LICENSE.md` and
`DATA_CARD.md`.

---

## 6. Lao text rules

Lao is where this dataset is won or lost. The pipeline keeps three columns per chunk and
each has exactly one job:

| Column | Contents | Used for |
|---|---|---|
| `content` | your original text, byte-for-byte | display and the LLM prompt |
| `content_norm` | NFC, zero-width stripped | **dense embedding input** |
| `content_seg` | LaoNLP tokens joined by spaces | **lexical/BM25 input only** |

You author `content`. The other two are derived — never author them.

**Defects that silently destroy retrieval.** A past corpus was 51% defective and recall
suffered badly before it was found:

- **Doubled combining marks** — `ທີີ່` instead of `ທີ່`. Looks nearly identical, embeds
  completely differently.
- **A space inside a syllable** — breaks segmentation, so the token never matches.
- **Zero-width characters** (`U+200B`, `U+FEFF`) — invisible, pasted in from Word and the web.

Run `POST /ingest/preview` before committing a large document, and `/studio/lao-check` to
scan. The cleaner is a conservative whitelist — it fixes these specific defects and leaves
everything else alone.

**Lao stays Lao.** Never machine-translate content. English glosses sit *alongside*, never
*instead of*. The UI language toggle switches chrome only, never content.

---

## 7. Anti-patterns

| Don't | Why | Do instead |
|---|---|---|
| Put `authority` / `effective_date` in YAML frontmatter | Frontmatter is skipped and discarded | Pass them as form fields at ingest |
| Write one 3,000-character section | Truncated to 700 chars in the prompt | One heading per answerable idea |
| Split a table across chunks | Tables are atomic; a split row loses its code | Keep one table under one heading |
| `6,000,000.00 ກີບ` | LAK is an integer; never rounded | `6000000` |
| Ship a QA pair with a guessed citation | Trains and evaluates against a lie | Verify what `citation_query` resolved to |
| Paste Lao straight from Word | Carries zero-width and doubled marks | Preview, then clean before embedding |
| Translate Lao content to English | Violates the language rule and empties the lexical arm | Add an English gloss alongside |
| Author a document with no headings | Every chunk becomes anonymous in citations | Use `##` liberally |

---

## 8. Authoring checklist

Before loading anything:

- [ ] File is UTF-8; Lao renders correctly (no `ທີີ່`, no mid-syllable spaces)
- [ ] Every section has a heading; no section answers more than one question
- [ ] Longest prose block is comfortably under 700 characters
- [ ] Amounts are whole-kip integers
- [ ] `collection`, `title`, `authority`, `effectiveDate`, `license` passed as form fields
- [ ] Tables intact, one per heading
- [ ] Glossary covers the terms this document introduces
- [ ] QA pairs cite real chunk ids, verified by eye
- [ ] `POST /qa/assign-splits` run after loading QA
- [ ] Reviewed and accepted in `/studio` — nothing exports unverified

---

## 9. Known gaps

Recorded so they are not rediscovered as bugs:

- **Knowledge entries created in `/studio/knowledge` do not carry `effective_date`.** Only
  the F1 ingest path accepts it. Prefer F1 for anything legally dated.
- **Glossary expansion cannot widen lexical results.** Expansion appends terms to the query,
  but the lexical arm requires *all* terms to match, so appending can only narrow. It is
  effectively inert until the query uses OR semantics or a separate expanded arm.

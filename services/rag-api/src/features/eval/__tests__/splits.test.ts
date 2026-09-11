import { afterAll, describe, expect, test } from "bun:test";
import { schema } from "@arnfar/db";
import { inArray } from "drizzle-orm";
import { db } from "../../../lib/db.ts";
import { newId } from "../../../lib/ids.ts";
import { devTenant } from "../../../lib/tenant.ts";
import { joinLaoWordSpaces, looksSegmented } from "../../lao/clean.ts";
import { DEFAULT_EVAL_SPLITS, type EvalSplit, isHeldOut, selectEvalPairs } from "../runner.ts";

/**
 * The held-out set must not be measured unless a caller names it.
 *
 * CLAUDE.md: "`qa_test.jsonl` is held out and never used for tuning." The harness used to
 * select every verified pair with no split predicate at all, so `test` entered every run
 * and the reported number was part tuning-set, part gate-set. These tests fail against
 * that version — `selectEvalPairs` returned the test row regardless of the argument.
 *
 * Skipped without a database, exactly like the RLS and export suites.
 */

const configured = Boolean(process.env.DATABASE_URL && process.env.DEV_HF_ID);

describe("eval split selection", () => {
  test("the default split set never includes the held-out bucket", () => {
    expect(DEFAULT_EVAL_SPLITS).not.toContain("test");
  });

  test("isHeldOut flags exactly the runs that touch test", () => {
    expect(isHeldOut(["train", "dev"])).toBe(false);
    expect(isHeldOut(["dev"])).toBe(false);
    expect(isHeldOut(["test"])).toBe(true);
    expect(isHeldOut(["train", "dev", "test"])).toBe(true);
  });
});

describe.skipIf(!configured)("eval split selection (database)", () => {
  const tenant = devTenant();
  const created: string[] = [];

  async function seed(split: EvalSplit, verified: boolean): Promise<string> {
    const id = newId();
    await db()
      .insert(schema.laoQaPair)
      .values({
        id,
        hfId: tenant.hfId,
        companyId: tenant.companyId,
        collection: "split-test",
        questionLo: `ຄຳຖາມ ${split} ${verified}`,
        answerLo: "ຄຳຕອບ",
        source: "human",
        split,
        verified,
      });
    created.push(id);
    return id;
  }

  afterAll(async () => {
    if (created.length) {
      await db().delete(schema.laoQaPair).where(inArray(schema.laoQaPair.id, created));
    }
  });

  test("a train+dev run cannot see a test pair", async () => {
    const trainId = await seed("train", true);
    const testId = await seed("test", true);

    const ids = (await selectEvalPairs(tenant, ["train", "dev"])).map((p) => p.id);

    expect(ids).toContain(trainId);
    expect(ids).not.toContain(testId);
  });

  test("the held-out set is reachable only by naming it", async () => {
    const testId = await seed("test", true);

    const ids = (await selectEvalPairs(tenant, ["test"])).map((p) => p.id);

    expect(ids).toContain(testId);
  });

  test("an unverified draft is never gold, whatever its split", async () => {
    const draftId = await seed("dev", false);

    const ids = (await selectEvalPairs(tenant, ["train", "dev", "test", "unassigned"])).map(
      (p) => p.id,
    );

    expect(ids).not.toContain(draftId);
  });
});

describe("question form", () => {
  // The seeded gold set is stored space-segmented; real Lao is not written that way.
  const STORED = "ຄິດໄລ່ ອາກອນມູນຄ່າເພີ່ມ ຕ້ອງ ຊຳລະ ສຸດທິ ແນວ ໃດ";

  test("as-typed removes the word-boundary spaces the corpus was authored with", () => {
    const typed = joinLaoWordSpaces(STORED);
    expect(typed).not.toBe(STORED);
    expect(typed).toContain("ຄິດໄລ່ອາກອນມູນຄ່າເພີ່ມ");
    expect(typed.split(" ").length).toBeLessThan(STORED.split(" ").length);
  });

  test("as-typed is a no-op on a question already written naturally", () => {
    // So the default is safe to apply unconditionally to a real user-authored gold set.
    const natural = "ອັດຕາອາກອນມູນຄ່າເພີ່ມແມ່ນເທົ່າໃດ?";
    expect(joinLaoWordSpaces(natural)).toBe(natural);
  });

  test("joining preserves initialism spacing", () => {
    // ສປປລາວ is wrong; the space in ສປປ ລາວ is orthographic, not a word boundary. A
    // de-segmenter that ate it would change the query's meaning, not just its spacing.
    expect(joinLaoWordSpaces("ອັດຕາ ອາກອນ ຢູ່ ສປປ ລາວ")).toContain("ສປປ ລາວ");
  });

  test("the stored gold questions are detected as segmented", () => {
    // This is the finding that motivated the flag: if this ever returns false for the
    // seeded set, the skew is gone and `as-stored` stops being misleading.
    expect(looksSegmented(STORED)).toBe(true);
  });
});

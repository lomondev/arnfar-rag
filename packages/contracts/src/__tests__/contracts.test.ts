import { describe, expect, test } from "bun:test";
import { exportRequest } from "../export.ts";
import { term } from "../glossary.ts";
import {
  chatRequest,
  chunkPatch,
  parseResponse,
  qaInput,
  reviewState,
  streamEvent,
} from "../index.ts";

/**
 * These schemas are the web↔api boundary. A rule that lives only in a comment gets
 * violated eventually; a rule that lives here fails the request.
 */

describe("chunkPatch", () => {
  test("accepts an accept with no body", () => {
    expect(chunkPatch.safeParse({ action: "accept" }).success).toBe(true);
  });

  test("rejects an edit with no content", () => {
    const r = chunkPatch.safeParse({ action: "edit" });
    expect(r.success).toBe(false);
  });

  test("rejects an edit whose content is only whitespace", () => {
    // An edit that blanks a chunk would silently destroy the pristine `content` column,
    // which CLAUDE.md says is only ever changed by a deliberate human edit.
    expect(chunkPatch.safeParse({ action: "edit", content: "   \n" }).success).toBe(false);
  });

  test("accepts a real edit", () => {
    expect(chunkPatch.safeParse({ action: "edit", content: "ບັນຊີ" }).success).toBe(true);
  });

  test("rejects an unknown action", () => {
    expect(chunkPatch.safeParse({ action: "delete" }).success).toBe(false);
  });
});

describe("reviewState", () => {
  test("knows exactly the four states", () => {
    expect(reviewState.options).toEqual(["pending", "accepted", "edited", "rejected"]);
  });
});

describe("qaInput", () => {
  const valid = {
    questionLo: "ອາກອນມູນຄ່າເພີ່ມແມ່ນຫຍັງ?",
    answerLo: "ອາກອນມູນຄ່າເພີ່ມ...",
    citationIds: ["018f9a1e-7c00-7000-8000-000000000001"],
  };

  test("accepts a cited pair", () => {
    expect(qaInput.safeParse(valid).success).toBe(true);
  });

  test("requires citationIds to be present", () => {
    const { citationIds: _omitted, ...withoutCitations } = valid;
    expect(qaInput.safeParse(withoutCitations).success).toBe(false);
  });

  test("rejects an empty answer", () => {
    expect(qaInput.safeParse({ ...valid, answerLo: "" }).success).toBe(false);
  });

  test("keeps difficulty inside 1–5, matching the DB CHECK constraint", () => {
    expect(qaInput.safeParse({ ...valid, difficulty: 3 }).success).toBe(true);
    expect(qaInput.safeParse({ ...valid, difficulty: 0 }).success).toBe(false);
    expect(qaInput.safeParse({ ...valid, difficulty: 6 }).success).toBe(false);
    expect(qaInput.safeParse({ ...valid, difficulty: 2.5 }).success).toBe(false);
  });
});

describe("exportRequest", () => {
  test("requires a semver version", () => {
    expect(exportRequest.safeParse({ version: "1.0.0" }).success).toBe(true);
    expect(exportRequest.safeParse({ version: "v1.0.0" }).success).toBe(false);
    expect(exportRequest.safeParse({ version: "1.0" }).success).toBe(false);
    expect(exportRequest.safeParse({ version: "latest" }).success).toBe(false);
  });

  test("treats shareable as optional, so it defaults to the safe direction", () => {
    const parsed = exportRequest.parse({ version: "0.1.0" });
    expect(parsed.shareable).toBeUndefined();
  });
});

describe("chatRequest", () => {
  test("uses the field names the route actually declares", () => {
    // The first version of this schema said `question` / `web` / `scope`. The route says
    // `message` / `webSearch` / `kinds`, and a contract that disagrees with the server is
    // worse than no contract at all.
    expect(chatRequest.safeParse({ message: "ອາກອນມູນຄ່າເພີ່ມແມ່ນຫຍັງ?" }).success).toBe(true);
    expect(chatRequest.safeParse({ question: "ອາກອນ" }).success).toBe(false);
  });

  test("accepts every optional the route accepts", () => {
    const full = {
      message: "ຄຳຖາມ",
      conversationId: "c1",
      collections: ["tax"],
      kinds: ["vat"],
      webSearch: true,
      k: 8,
      model: "qwen3:8b",
    };
    expect(chatRequest.safeParse(full).success).toBe(true);
  });

  test("holds k inside the range the route enforces", () => {
    expect(chatRequest.safeParse({ message: "x", k: 20 }).success).toBe(true);
    expect(chatRequest.safeParse({ message: "x", k: 21 }).success).toBe(false);
    expect(chatRequest.safeParse({ message: "x", k: 0 }).success).toBe(false);
  });
});

describe("streamEvent", () => {
  const source = {
    n: 1,
    id: "chunk-1",
    content: "ເນື້ອໃນ",
    headingPath: ["ບົດທີ 1"],
    kind: "prose",
    title: "ກົດໝາຍອາກອນ",
    authority: "ກະຊວງການເງິນ",
    effectiveDate: "2026-01-01",
    superseded: null,
    origin: "dataset",
    url: null,
  };

  test("accepts each frame the server actually emits", () => {
    const frames: unknown[] = [
      { type: "created", conversationId: "c1", userMessageId: "m1" },
      { type: "citations", sources: [source], glossaryMatches: [], retrievalQuery: "ອາກອນ" },
      { type: "token", t: "ບັນ" },
      { type: "done", conversationId: "c1", assistantMessageId: "m2" },
      { type: "error", error: "ollama unreachable" },
    ];
    for (const f of frames) {
      const r = streamEvent.safeParse(f);
      expect(`${(f as { type: string }).type}: ${r.success}`).toBe(
        `${(f as { type: string }).type}: true`,
      );
    }
  });

  test("rejects a frame type the server never sends", () => {
    // "phase" was invented by the first draft of this schema. The three-step progress
    // indicator is derived client-side from the order of real frames.
    expect(streamEvent.safeParse({ type: "phase", phase: "searching" }).success).toBe(false);
  });

  test("keeps the superseded warning on a citation", () => {
    // Dropping this field is how a repealed VAT rate gets cited as current.
    const superseded = {
      ...source,
      superseded: { title: "ສະບັບເກົ່າ", effectiveDate: "2020-01-01" },
    };
    const r = streamEvent.safeParse({
      type: "citations",
      sources: [superseded],
      glossaryMatches: [],
      retrievalQuery: "q",
    });
    expect(r.success).toBe(true);
  });

  test("requires a citation to declare its origin", () => {
    // dataset / web / erp decides whether a source is exportable at all.
    const { origin: _dropped, ...withoutOrigin } = source;
    const r = streamEvent.safeParse({
      type: "citations",
      sources: [withoutOrigin],
      glossaryMatches: [],
      retrievalQuery: "q",
    });
    expect(r.success).toBe(false);
  });
});

describe("parseResponse", () => {
  test("returns the parsed value when it matches", () => {
    const value = parseResponse(
      term,
      {
        id: "1",
        termLo: "ບັນຊີ",
        termLoSeg: "ບັນຊີ",
        termEn: "account",
        definitionLo: null,
        definitionEn: null,
        domain: "accounting",
        variantsLo: [],
        forbiddenLo: [],
        verified: true,
      },
      "GET /glossary",
    );
    expect(value.termEn).toBe("account");
  });

  test("names the endpoint and the field that moved", () => {
    // This is the drift the contracts package exists to catch: the API renames a field,
    // both sides still compile, and the UI silently renders nothing.
    expect(() => parseResponse(term, { id: "1", term_en: "account" }, "GET /glossary")).toThrow(
      /GET \/glossary.*termLo/s,
    );
  });
});

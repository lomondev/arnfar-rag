import { describe, expect, test } from "bun:test";
import { streamEvent } from "../chat.ts";
import { exportRequest } from "../export.ts";
import { term } from "../glossary.ts";
import { chunkPatch, parseResponse, qaInput, reviewState } from "../index.ts";

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

describe("streamEvent", () => {
  test("accepts each event the server emits", () => {
    const events: unknown[] = [
      { type: "phase", phase: "searching" },
      { type: "phase", phase: "reading", sources: 4 },
      { type: "sources", sources: [] },
      { type: "token", text: "ບັນ" },
      { type: "conversation", id: "abc" },
      { type: "done" },
      { type: "error", message: "ollama unreachable" },
    ];
    for (const e of events) {
      expect(streamEvent.safeParse(e).success).toBe(true);
    }
  });

  test("rejects an unknown event type", () => {
    expect(streamEvent.safeParse({ type: "thinking" }).success).toBe(false);
  });

  test("rejects a known phase name in the wrong slot", () => {
    expect(streamEvent.safeParse({ type: "phase", phase: "finished" }).success).toBe(false);
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

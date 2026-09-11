import {
  type LessonDetail,
  type LessonProgress,
  type LessonSummary,
  lessonDetail,
  lessonProgress,
  lessonSummary,
  parseResponse,
  type Student,
  type Subject,
  student,
  subject,
} from "@arnfar/contracts";
import { z } from "zod";
import { apiBaseUrl } from "@/lib/api";

const BASE = apiBaseUrl();

/** Responses are PARSED, not cast (CLAUDE.md): a renamed field on the API side surfaces
 *  here as a named error at the fetch boundary rather than a blank lesson. */
async function get<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`rag-api ${path} → ${res.status}`);
  return parseResponse(schema, await res.json(), `GET ${path}`);
}

async function post<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  body: unknown,
): Promise<z.infer<S>> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`rag-api ${path} → ${res.status}`);
  return parseResponse(schema, await res.json(), `POST ${path}`);
}

export const listSubjects = (): Promise<Subject[]> => get("/learn/subjects", z.array(subject));

export const listLessons = (subjectId?: string): Promise<LessonSummary[]> =>
  get(
    `/learn/lessons${subjectId ? `?subjectId=${encodeURIComponent(subjectId)}` : ""}`,
    z.array(lessonSummary),
  );

export const getLesson = (id: string): Promise<LessonDetail> =>
  get(`/learn/lessons/${id}`, lessonDetail);

export const listStudents = (): Promise<Student[]> => get("/learn/students", z.array(student));

export const createStudent = (displayName: string, lang: Student["lang"]): Promise<Student> =>
  post("/learn/students", student, { displayName, lang });

export const listProgress = (studentId: string): Promise<LessonProgress[]> =>
  get(`/learn/students/${studentId}/progress`, z.array(lessonProgress));

export const saveProgress = (
  studentId: string,
  lessonId: string,
  seq: number,
  completed: boolean,
): Promise<LessonProgress> =>
  post(`/learn/students/${studentId}/progress`, lessonProgress, { lessonId, seq, completed });

const dueQuestion = z.object({
  qaPairId: z.string(),
  questionLo: z.string(),
  questionEn: z.string().nullable(),
  answerLo: z.string(),
  answerEn: z.string().nullable(),
  difficulty: z.number(),
  citationIds: z.array(z.string()),
  streak: z.number(),
  isNew: z.boolean(),
});
export type DueQuestion = z.infer<typeof dueQuestion>;

export const listDue = (studentId: string, limit = 10): Promise<DueQuestion[]> =>
  get(
    `/learn/students/${studentId}/due?limit=${limit}`,
    z.object({ questions: z.array(dueQuestion), count: z.number() }),
  ).then((r) => r.questions);

const weakTopic = z.object({
  qaPairId: z.string(),
  questionLo: z.string(),
  attempts: z.number(),
  wrong: z.number(),
  lessonId: z.string().nullable(),
  lessonTitleLo: z.string().nullable(),
});
export type WeakTopic = z.infer<typeof weakTopic>;

export const listWeak = (studentId: string): Promise<WeakTopic[]> =>
  get(`/learn/students/${studentId}/weak`, z.object({ topics: z.array(weakTopic) })).then(
    (r) => r.topics,
  );

export const recordAttempt = (
  studentId: string,
  input: {
    qaPairId: string;
    correct: boolean;
    streak: number;
    lessonStepId?: string;
    response?: string;
    elapsedMs?: number;
  },
): Promise<{ id: string; nextInHours: number }> =>
  post(
    `/learn/students/${studentId}/attempts`,
    z.object({ id: z.string(), nextInHours: z.number() }),
    input,
  );

/** The chunks a step cites — what "why?" opens.
 *  Served by the existing review endpoint, so no new API surface is needed for it. */
const citedChunk = z.object({
  id: z.string(),
  content: z.string(),
  title: z.string().nullable(),
});
export type CitedChunk = z.infer<typeof citedChunk>;

export async function fetchCitations(ids: readonly string[]): Promise<CitedChunk[]> {
  if (!ids.length) return [];
  const res = await fetch(`${BASE}/learn/citations?ids=${ids.join(",")}`);
  if (!res.ok) return [];
  try {
    return parseResponse(z.array(citedChunk), await res.json(), "GET /learn/citations");
  } catch {
    // A citation panel that cannot load is a degraded step, not a broken lesson.
    return [];
  }
}

const checkAnswer = z.object({
  qaPairId: z.string(),
  answerLo: z.string(),
  answerEn: z.string().nullable(),
});
export type CheckAnswer = z.infer<typeof checkAnswer>;

/** The answer to a check step. Read live from the verified pair rather than copied into
 *  the lesson, so an un-verified pair stops being shown the moment it is un-verified. */
export const getCheckAnswer = (qaPairId: string): Promise<CheckAnswer> =>
  get(`/learn/qa/${qaPairId}/answer`, checkAnswer);

// ── Curator ─────────────────────────────────────────────────────────────────────────

export const listCuratorLessons = (subjectId?: string): Promise<LessonSummary[]> =>
  get(
    `/learn/curator/lessons${subjectId ? `?subjectId=${encodeURIComponent(subjectId)}` : ""}`,
    z.array(lessonSummary),
  );

export const getCuratorLesson = (id: string): Promise<LessonDetail> =>
  get(`/learn/curator/lessons/${id}`, lessonDetail);

export const draftLesson = (input: {
  subjectId: string;
  topic: string;
  targetSteps?: number;
}): Promise<{
  lessonId: string;
  titleLo: string;
  stepCount: number;
  checkSteps: number;
  droppedSteps: number;
}> =>
  post(
    "/learn/curator/lessons/draft",
    z.object({
      lessonId: z.string(),
      titleLo: z.string(),
      stepCount: z.number(),
      checkSteps: z.number(),
      sourcesUsed: z.number(),
      droppedSteps: z.number(),
    }),
    input,
  );

/**
 * PATCH/POST/DELETE that surfaces the API's own message.
 *
 * The editing routes answer a broken invariant with a 422 and a readable sentence — "a
 * concept step must cite at least one source". Throwing a bare status here would discard
 * exactly the part a curator needs, so the body is read first.
 */
async function mutate(path: string, method: string, body?: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.ok) return;
  let message = `rag-api ${path} → ${res.status}`;
  try {
    const payload = (await res.json()) as { error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // Non-JSON error body: the status line is all there is.
  }
  throw new Error(message);
}

const patch = (path: string): Promise<void> => mutate(path, "PATCH", {});

export interface LessonPatch {
  titleLo?: string;
  titleEn?: string | null;
  summaryLo?: string | null;
  summaryEn?: string | null;
  difficulty?: number;
  estimatedMinutes?: number;
}

export const updateLesson = (id: string, body: LessonPatch): Promise<void> =>
  mutate(`/learn/curator/lessons/${id}`, "PATCH", body);

export interface StepPatch {
  kind?: string;
  titleLo?: string | null;
  titleEn?: string | null;
  bodyLo?: string | null;
  bodyEn?: string | null;
  visual?: unknown;
  citationIds?: string[];
}

export const updateStep = (id: string, body: StepPatch): Promise<void> =>
  mutate(`/learn/curator/steps/${id}`, "PATCH", body);

export const addStep = (
  lessonId: string,
  body: { kind?: string; bodyLo?: string; citationIds?: string[] },
): Promise<void> => mutate(`/learn/curator/lessons/${lessonId}/steps`, "POST", body);

export const deleteStep = (id: string): Promise<void> =>
  mutate(`/learn/curator/steps/${id}`, "DELETE");

export const moveStep = (id: string, direction: "up" | "down"): Promise<void> =>
  mutate(`/learn/curator/steps/${id}/move`, "POST", { direction });

export const verifyLesson = (id: string) => patch(`/learn/curator/lessons/${id}/verify`);
export const unverifyLesson = (id: string) => patch(`/learn/curator/lessons/${id}/unverify`);

export async function deleteLesson(id: string): Promise<void> {
  const res = await fetch(`${BASE}/learn/curator/lessons/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`rag-api delete lesson → ${res.status}`);
}

export const createSubject = (input: {
  key: string;
  nameLo: string;
  nameEn?: string;
  collections?: string[];
}): Promise<{ id: string }> => post("/learn/subjects", z.object({ id: z.string() }), input);

/** The student chosen on this device. Kept in localStorage deliberately: the student ROW
 *  and all their progress live in Postgres, so nothing is lost by clearing a browser —
 *  only the convenience of not re-picking a name. */
const STUDENT_KEY = "arnfar.learn.studentId";

export function rememberStudent(id: string): void {
  try {
    localStorage.setItem(STUDENT_KEY, id);
  } catch {
    // Private mode or blocked site data: the picker simply appears every visit.
  }
}

export function recallStudent(): string | null {
  try {
    return localStorage.getItem(STUDENT_KEY);
  } catch {
    return null;
  }
}

export function forgetStudent(): void {
  try {
    localStorage.removeItem(STUDENT_KEY);
  } catch {
    /* nothing to do */
  }
}

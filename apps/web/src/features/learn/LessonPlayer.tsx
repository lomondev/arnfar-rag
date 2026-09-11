"use client";

import type { LessonDetail, LessonStep, Student } from "@arnfar/contracts";
import { Button } from "@arnfar/ui/components/button";
import { cn } from "@arnfar/ui/lib/utils";
import { ArrowLeft, ArrowRight, BookOpen, Check, Loader2, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type CheckAnswer as ApiCheckAnswer,
  type CitedChunk,
  fetchCitations,
  getCheckAnswer,
  getLesson,
  recordAttempt,
  saveProgress,
} from "./api";
import { Visual } from "./Visuals";

/**
 * The step player — one step at a time.
 *
 * One step per screen is the whole design. A lesson rendered as a long scroll is a
 * document, and a student reads a document by skimming it; a student who must press
 * "next" has to decide, each time, that they understood the step they are on.
 *
 * Chrome is bilingual and content follows the student's own `lang` — which is a real
 * choice here, not the chrome toggle CLAUDE.md talks about: a lesson is generated text
 * with a Lao and an English version written from the same sources, so showing one, the
 * other, or both is choosing between two authored versions, never translating content.
 */

const UI = {
  lo: {
    step: "ຂັ້ນຕອນ",
    of: "ຈາກ",
    next: "ຕໍ່ໄປ",
    prev: "ກັບຄືນ",
    why: "ເປັນຫຍັງ?",
    sources: "ແຫຼ່ງອ້າງອີງ",
    close: "ປິດ",
    finish: "ຈົບບົດຮຽນ",
    done: "ຮຽນຈົບແລ້ວ",
    backToLessons: "ກັບໄປລາຍການບົດຮຽນ",
    reveal: "ເບິ່ງຄຳຕອບ",
    gotIt: "ຕອບຖືກ",
    missedIt: "ຕອບຜິດ",
    answer: "ຄຳຕອບ",
    again: "ຮຽນຄືນໃໝ່",
    loading: "ກຳລັງໂຫຼດ…",
    notFound: "ບໍ່ພົບບົດຮຽນ",
  },
  en: {
    step: "Step",
    of: "of",
    next: "Next",
    prev: "Back",
    why: "Why?",
    sources: "Sources",
    close: "Close",
    finish: "Finish lesson",
    done: "Lesson complete",
    backToLessons: "Back to lessons",
    reveal: "Show answer",
    gotIt: "I got it",
    missedIt: "I missed it",
    answer: "Answer",
    again: "Study again",
    loading: "Loading…",
    notFound: "Lesson not found",
  },
} as const;

type Chrome = keyof typeof UI;

const KIND_LABEL: Record<LessonStep["kind"], { lo: string; en: string }> = {
  intro: { lo: "ບົດນຳ", en: "Intro" },
  concept: { lo: "ແນວຄິດ", en: "Concept" },
  example: { lo: "ຕົວຢ່າງ", en: "Example" },
  check: { lo: "ກວດຄວາມເຂົ້າໃຈ", en: "Check" },
  recap: { lo: "ສະຫຼຸບ", en: "Recap" },
};

/** Which body text to show, from the student's own preference. */
function bodyFor(
  step: LessonStep,
  lang: Student["lang"],
): { lo: string | null; en: string | null } {
  if (lang === "lo") return { lo: step.bodyLo, en: null };
  if (lang === "en") return { lo: null, en: step.bodyEn ?? step.bodyLo };
  return { lo: step.bodyLo, en: step.bodyEn };
}

export function LessonPlayer({
  lessonId,
  student,
  chrome = "lo",
}: {
  lessonId: string;
  student: Student | null;
  chrome?: Chrome;
}) {
  const t = UI[chrome];
  const [lesson, setLesson] = useState<LessonDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(0);
  const [sources, setSources] = useState<CitedChunk[] | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [finished, setFinished] = useState(false);
  const shownAt = useRef<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getLesson(lessonId)
      .then((l) => {
        if (!cancelled) setLesson(l);
      })
      .catch(() => {
        if (!cancelled) setLesson(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lessonId]);

  const step = lesson?.steps[idx];
  const total = lesson?.steps.length ?? 0;
  const isLast = idx === total - 1;

  // Reset per-step state whenever the step changes, and start the timer the attempt
  // records — a check answered after two minutes of thought is a different signal from
  // one answered in three seconds.
  useEffect(() => {
    setSourcesOpen(false);
    setSources(null);
    setRevealed(false);
    shownAt.current = Date.now();
  }, []);

  const goto = useCallback(
    (next: number) => {
      if (!lesson || next < 0 || next >= lesson.steps.length) return;
      setIdx(next);
      setSourcesOpen(false);
      setSources(null);
      setRevealed(false);
      shownAt.current = Date.now();
      // Fire-and-forget: progress is a convenience, and a failed write must never block
      // a student from moving on.
      if (student) void saveProgress(student.id, lesson.id, next, false).catch(() => {});
    },
    [lesson, student],
  );

  const openSources = useCallback(async () => {
    if (!step) return;
    setSourcesOpen(true);
    if (sources === null) setSources(await fetchCitations(step.citationIds));
  }, [step, sources]);

  const answerCheck = useCallback(
    async (correct: boolean) => {
      if (!step || !step.qaPairId) return;
      setAnswered((a) => ({ ...a, [step.id]: correct }));
      if (!student) return;
      await recordAttempt(student.id, {
        qaPairId: step.qaPairId,
        correct,
        streak: 0,
        lessonStepId: step.id,
        elapsedMs: Date.now() - shownAt.current,
      }).catch(() => {});
    },
    [step, student],
  );

  const finish = useCallback(async () => {
    if (!lesson) return;
    setFinished(true);
    if (student) await saveProgress(student.id, lesson.id, total - 1, true).catch(() => {});
  }, [lesson, student, total]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-24 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t.loading}
      </div>
    );
  }

  if (!lesson || !step) {
    return (
      <div className="py-24 text-center">
        <p className="text-muted-foreground text-sm">{t.notFound}</p>
        <Link
          href="/learn"
          className="text-muted-foreground hover:text-foreground mt-3 inline-block text-sm underline underline-offset-4"
        >
          {t.backToLessons}
        </Link>
      </div>
    );
  }

  if (finished) {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <div className="bg-primary/10 text-primary mx-auto flex size-14 items-center justify-center rounded-full">
          <Check className="size-7" />
        </div>
        <h2 lang="lo" className="mt-4 text-xl font-semibold">
          {t.done}
        </h2>
        <p lang="lo" className="text-muted-foreground mt-1 text-sm">
          {lesson.titleLo}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link
            href="/learn"
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors"
          >
            {t.backToLessons}
          </Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFinished(false);
              setIdx(0);
            }}
          >
            <RotateCcw className="size-4" />
            {t.again}
          </Button>
        </div>
      </div>
    );
  }

  const lang = student?.lang ?? "lo";
  const body = bodyFor(step, lang);
  const checkAnswered = step.kind === "check" ? answered[step.id] : undefined;

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24">
      {/* Progress. A bar plus "step n of m": the bar is the glance, the numbers are the
          answer to "how much is left", which is the question a tired student actually asks. */}
      <div className="sticky top-0 z-10 -mx-4 mb-6 bg-[var(--background)]/90 px-4 pt-4 pb-3 backdrop-blur">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <Link
            href="/learn"
            lang="lo"
            className="text-muted-foreground hover:text-foreground truncate text-sm"
          >
            {lesson.titleLo}
          </Link>
          <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
            {t.step} {idx + 1} {t.of} {total}
          </span>
        </div>
        <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-300"
            style={{ width: `${((idx + 1) / total) * 100}%` }}
          />
        </div>
      </div>

      <article>
        <div className="text-muted-foreground mb-1.5 text-xs font-medium tracking-wide uppercase">
          {KIND_LABEL[step.kind][chrome]}
        </div>
        {(step.titleLo || step.titleEn) && (
          <h2 lang="lo" className="mb-3 text-lg leading-snug font-semibold text-balance">
            {lang === "en" ? (step.titleEn ?? step.titleLo) : step.titleLo}
          </h2>
        )}

        {body.lo && (
          <p lang="lo" className="text-[1.02rem] leading-[1.85] whitespace-pre-wrap">
            {body.lo}
          </p>
        )}
        {body.en && (
          <p
            className={cn(
              "text-[0.98rem] leading-[1.7] whitespace-pre-wrap",
              // In bilingual mode the English sits under the Lao, visually secondary —
              // alongside, never instead of.
              body.lo && "text-muted-foreground mt-3 border-t pt-3",
            )}
          >
            {body.en}
          </p>
        )}

        {step.visual && <Visual spec={step.visual} />}

        {/* A check step: the question is the body; the answer is hidden until asked for,
            then the student says whether they had it. Self-marking is deliberate — there
            is no reliable way to grade free-text Lao offline, and asking honestly is both
            cheaper and better evidence than a wrong auto-grade. */}
        {step.kind === "check" && step.qaPairId !== null && (
          <div className="bg-card/60 mt-5 rounded-xl border p-4">
            {!revealed ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setRevealed(true)}
                className="w-full"
              >
                {t.reveal}
              </Button>
            ) : (
              <>
                <div className="text-muted-foreground mb-1.5 text-xs font-medium tracking-wide uppercase">
                  {t.answer}
                </div>
                <CheckAnswer qaPairId={step.qaPairId} lang={lang} />
                {checkAnswered === undefined ? (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" className="flex-1" onClick={() => void answerCheck(true)}>
                      <Check className="size-4" />
                      {t.gotIt}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="flex-1"
                      onClick={() => void answerCheck(false)}
                    >
                      <X className="size-4" />
                      {t.missedIt}
                    </Button>
                  </div>
                ) : (
                  <div
                    className={cn(
                      "mt-3 rounded-lg px-3 py-2 text-center text-sm font-medium",
                      checkAnswered
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {checkAnswered ? t.gotIt : t.missedIt}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {step.citationIds.length > 0 && (
          <div className="mt-5">
            <Button size="xs" variant="ghost" onClick={() => void openSources()}>
              <BookOpen className="size-3.5" />
              {t.why}
            </Button>
            {sourcesOpen && (
              <div className="mt-2 flex flex-col gap-2">
                {sources === null ? (
                  <div className="text-muted-foreground flex items-center gap-2 text-xs">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t.loading}
                  </div>
                ) : (
                  sources.map((c) => (
                    <blockquote
                      key={c.id}
                      className="border-primary/40 bg-muted/40 rounded-e-lg border-s-2 px-3 py-2"
                    >
                      {c.title && (
                        <div lang="lo" className="text-muted-foreground mb-1 text-xs font-medium">
                          {c.title}
                        </div>
                      )}
                      <p lang="lo" className="text-sm leading-relaxed whitespace-pre-wrap">
                        {c.content}
                      </p>
                    </blockquote>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </article>

      {/* Navigation pinned to the bottom: the student's thumb is there, and a "next" that
          moves down the page as steps get longer is a moving target. */}
      <nav className="fixed inset-x-0 bottom-0 z-10 border-t bg-[var(--background)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => goto(idx - 1)}
            disabled={idx === 0}
            className="shrink-0"
          >
            <ArrowLeft className="size-4" />
            {t.prev}
          </Button>
          <div className="flex-1" />
          {isLast ? (
            <Button size="sm" onClick={() => void finish()}>
              <Check className="size-4" />
              {t.finish}
            </Button>
          ) : (
            <Button size="sm" onClick={() => goto(idx + 1)}>
              {t.next}
              <ArrowRight className="size-4" />
            </Button>
          )}
        </div>
      </nav>
    </div>
  );
}

/**
 * The answer to a check step.
 *
 * Fetched by the pair's id rather than embedded in the lesson: the step stores only the id,
 * so a student always sees the verified pair's current text, and a pair that is later
 * un-verified stops being shown as an answer instead of living on in a lesson copy.
 */
function CheckAnswer({ qaPairId, lang }: { qaPairId: string; lang: Student["lang"] }) {
  const [answer, setAnswer] = useState<ApiCheckAnswer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCheckAnswer(qaPairId)
      .then((a) => {
        if (!cancelled) setAnswer(a);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [qaPairId]);

  if (failed) {
    return <p className="text-muted-foreground text-sm">ບໍ່ສາມາດໂຫຼດຄຳຕອບໄດ້ · answer unavailable</p>;
  }
  if (!answer) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-3.5 animate-spin" />
      </div>
    );
  }

  const showEn = lang !== "lo" && answer.answerEn;
  return (
    <>
      {lang !== "en" && (
        <p lang="lo" className="text-sm leading-relaxed whitespace-pre-wrap">
          {answer.answerLo}
        </p>
      )}
      {showEn && (
        <p
          className={cn(
            "text-sm leading-relaxed whitespace-pre-wrap",
            lang === "both" && "text-muted-foreground mt-2 border-t pt-2",
          )}
        >
          {answer.answerEn}
        </p>
      )}
      {lang === "en" && !answer.answerEn && (
        // No English version was ever written for this pair. Showing the Lao is correct:
        // an answer is better than a gap, and Lao stays Lao.
        <p lang="lo" className="text-sm leading-relaxed whitespace-pre-wrap">
          {answer.answerLo}
        </p>
      )}
    </>
  );
}

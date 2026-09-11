"use client";

import type { Student } from "@arnfar/contracts";
import { Button } from "@arnfar/ui/components/button";
import { cn } from "@arnfar/ui/lib/utils";
import { Check, Loader2, PartyPopper, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { type DueQuestion, listDue, listStudents, recallStudent, recordAttempt } from "./api";

/**
 * Practice — spaced repetition over the verified question bank.
 *
 * Self-marked, deliberately. There is no reliable way to grade free-text Lao offline, and
 * an auto-grader that marks a correct answer wrong teaches a student to distrust the tool.
 * Asking honestly is cheaper and is better evidence: the schedule only has to know whether
 * they knew it.
 */

const UI = {
  lo: {
    title: "ຝຶກຫັດ",
    loading: "ກຳລັງໂຫຼດ…",
    allDone: "ບໍ່ມີຄຳຖາມທີ່ຮອດເວລາ",
    allDoneSub: "ກັບມາໃໝ່ພາຍຫຼັງ — ຫຼື ຮຽນບົດຮຽນເພີ່ມ",
    back: "ກັບໄປ",
    reveal: "ເບິ່ງຄຳຕອບ",
    gotIt: "ຕອບຖືກ",
    missedIt: "ຕອບຜິດ",
    answer: "ຄຳຕອບ",
    newQ: "ໃໝ່",
    nextIn: "ຈະຖາມອີກໃນ",
    hours: "ຊົ່ວໂມງ",
    days: "ມື້",
    remaining: "ຍັງເຫຼືອ",
    noStudent: "ເລືອກຜູ້ຮຽນກ່ອນ",
  },
  en: {
    title: "Practice",
    loading: "Loading…",
    allDone: "Nothing due right now",
    allDoneSub: "Come back later — or study another lesson",
    back: "Back",
    reveal: "Show answer",
    gotIt: "I knew it",
    missedIt: "I missed it",
    answer: "Answer",
    newQ: "new",
    nextIn: "Next in",
    hours: "h",
    days: "d",
    remaining: "left",
    noStudent: "Pick a student first",
  },
} as const;

type Chrome = keyof typeof UI;

export function PracticeClient({ chrome = "lo" }: { chrome?: Chrome }) {
  const t = UI[chrome];
  const [me, setMe] = useState<Student | null>(null);
  const [queue, setQueue] = useState<DueQuestion[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nextIn, setNextIn] = useState<number | null>(null);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = recallStudent();
      if (!id) {
        setLoading(false);
        return;
      }
      const roster = await listStudents().catch(() => [] as Student[]);
      const found = roster.find((s) => s.id === id) ?? null;
      if (cancelled) return;
      setMe(found);
      if (found) setQueue(await listDue(found.id, 15).catch(() => []));
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const current = queue[idx];

  const answer = useCallback(
    async (correct: boolean) => {
      if (!me || !current) return;
      const res = await recordAttempt(me.id, {
        qaPairId: current.qaPairId,
        correct,
        streak: current.streak,
        elapsedMs: Date.now() - shownAt.current,
      }).catch(() => null);
      setNextIn(res?.nextInHours ?? null);
      // Brief pause so the student sees when they will meet the question again — the
      // feedback that makes a schedule read as progress rather than randomness.
      window.setTimeout(() => {
        setNextIn(null);
        setRevealed(false);
        setIdx((i) => i + 1);
        shownAt.current = Date.now();
      }, 900);
    },
    [me, current],
  );

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-24 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t.loading}
      </div>
    );
  }

  if (!me) {
    return (
      <div className="py-24 text-center">
        <p lang="lo" className="text-muted-foreground text-sm">
          {t.noStudent}
        </p>
        <Link
          href="/learn"
          className="text-primary mt-3 inline-block text-sm underline underline-offset-4"
        >
          {t.back}
        </Link>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <div className="bg-primary/10 text-primary mx-auto flex size-14 items-center justify-center rounded-full">
          <PartyPopper className="size-7" />
        </div>
        <h2 lang="lo" className="mt-4 text-xl font-semibold">
          {t.allDone}
        </h2>
        <p lang="lo" className="text-muted-foreground mt-1 text-sm">
          {t.allDoneSub}
        </p>
        <Link
          href="/learn"
          className="bg-primary text-primary-foreground hover:bg-primary/90 mt-6 inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors"
        >
          {t.back}
        </Link>
      </div>
    );
  }

  const showEn = me.lang !== "lo";
  const showLo = me.lang !== "en";

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-3">
        <h1 lang="lo" className="text-xl font-semibold">
          {t.title}
        </h1>
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {queue.length - idx} {t.remaining}
        </span>
      </header>

      <div className="bg-card/60 rounded-xl border p-5">
        <div className="mb-2 flex items-center gap-2">
          {current.isNew && (
            <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[0.65rem] font-medium">
              {t.newQ}
            </span>
          )}
          <span
            className="flex gap-0.5"
            role="img"
            aria-label={`difficulty ${current.difficulty} of 5`}
          >
            {Array.from({ length: 5 }, (_, i) => (
              <span
                key={`d-${i}`}
                className={cn(
                  "size-1.5 rounded-full",
                  i < current.difficulty ? "bg-muted-foreground/60" : "bg-muted",
                )}
              />
            ))}
          </span>
        </div>

        {showLo && (
          <p lang="lo" className="text-[1.05rem] leading-[1.85] font-medium">
            {current.questionLo}
          </p>
        )}
        {showEn && current.questionEn && (
          <p className={cn("text-sm leading-relaxed", showLo && "text-muted-foreground mt-2")}>
            {current.questionEn}
          </p>
        )}

        {!revealed ? (
          <Button
            size="sm"
            variant="secondary"
            className="mt-5 w-full"
            onClick={() => setRevealed(true)}
          >
            {t.reveal}
          </Button>
        ) : (
          <>
            <div className="mt-5 border-t pt-4">
              <div className="text-muted-foreground mb-1.5 text-xs font-medium tracking-wide uppercase">
                {t.answer}
              </div>
              {showLo && (
                <p lang="lo" className="text-sm leading-relaxed whitespace-pre-wrap">
                  {current.answerLo}
                </p>
              )}
              {showEn && current.answerEn && (
                <p
                  className={cn(
                    "text-sm leading-relaxed whitespace-pre-wrap",
                    showLo && "text-muted-foreground mt-2 border-t pt-2",
                  )}
                >
                  {current.answerEn}
                </p>
              )}
            </div>
            {nextIn === null ? (
              <div className="mt-4 flex gap-2">
                <Button size="sm" className="flex-1" onClick={() => void answer(true)}>
                  <Check className="size-4" />
                  {t.gotIt}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => void answer(false)}
                >
                  <X className="size-4" />
                  {t.missedIt}
                </Button>
              </div>
            ) : (
              <div className="bg-muted text-muted-foreground mt-4 rounded-lg px-3 py-2 text-center text-sm">
                {t.nextIn}{" "}
                <span className="font-mono tabular-nums">
                  {nextIn >= 24 ? `${Math.round(nextIn / 24)}${t.days}` : `${nextIn}${t.hours}`}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="mt-6 text-center">
        <Link
          href="/learn"
          className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
        >
          {t.back}
        </Link>
      </div>
    </div>
  );
}

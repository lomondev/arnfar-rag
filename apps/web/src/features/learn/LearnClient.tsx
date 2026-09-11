"use client";

import type { LessonProgress, LessonSummary, Student, Subject } from "@arnfar/contracts";
import { Button } from "@arnfar/ui/components/button";
import { Input } from "@arnfar/ui/components/input";
import { Select } from "@arnfar/ui/components/select";
import { cn } from "@arnfar/ui/lib/utils";
import { BookOpen, Check, Clock, Dumbbell, Loader2, TriangleAlert, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  createStudent,
  forgetStudent,
  listLessons,
  listProgress,
  listStudents,
  listSubjects,
  listWeak,
  recallStudent,
  rememberStudent,
  type WeakTopic,
} from "./api";

const UI = {
  lo: {
    title: "ຮຽນຮູ້",
    subtitle: "ຮຽນເປັນຂັ້ນຕອນ ພ້ອມແຫຼ່ງອ້າງອີງ",
    whoAreYou: "ເຈົ້າແມ່ນໃຜ?",
    newStudent: "ນັກຮຽນໃໝ່",
    yourName: "ຊື່ຂອງເຈົ້າ",
    start: "ເລີ່ມ",
    change: "ປ່ຽນຜູ້ຮຽນ",
    lessons: "ບົດຮຽນ",
    noLessons: "ຍັງບໍ່ມີບົດຮຽນທີ່ຢືນຢັນແລ້ວ",
    noLessonsHint: "ຄູສອນຕ້ອງສ້າງ ແລະ ຢືນຢັນບົດຮຽນກ່ອນ",
    minutes: "ນາທີ",
    steps: "ຂັ້ນຕອນ",
    done: "ຮຽນຈົບ",
    inProgress: "ກຳລັງຮຽນ",
    practice: "ຝຶກຫັດ",
    practiceSub: "ທົບທວນຄຳຖາມທີ່ຮອດເວລາ",
    weak: "ຈຸດທີ່ຄວນທົບທວນ",
    wrongOf: "ຜິດ",
    times: "ຄັ້ງ",
    loading: "ກຳລັງໂຫຼດ…",
    lang: "ພາສາຂອງບົດຮຽນ",
  },
  en: {
    title: "Learn",
    subtitle: "Step by step, with sources",
    whoAreYou: "Who is studying?",
    newStudent: "New student",
    yourName: "Your name",
    start: "Start",
    change: "Change student",
    lessons: "Lessons",
    noLessons: "No verified lessons yet",
    noLessonsHint: "A teacher needs to draft and approve a lesson first",
    minutes: "min",
    steps: "steps",
    done: "Complete",
    inProgress: "In progress",
    practice: "Practice",
    practiceSub: "Review what is due",
    weak: "Worth reviewing",
    wrongOf: "missed",
    times: "times",
    loading: "Loading…",
    lang: "Lesson language",
  },
} as const;

type Chrome = keyof typeof UI;

export function LearnClient({ chrome = "lo" }: { chrome?: Chrome }) {
  const t = UI[chrome];
  const [students, setStudents] = useState<Student[]>([]);
  const [me, setMe] = useState<Student | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [progress, setProgress] = useState<LessonProgress[]>([]);
  const [weak, setWeak] = useState<WeakTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newLang, setNewLang] = useState<Student["lang"]>("lo");
  const [busy, setBusy] = useState(false);

  // Load the roster and restore whoever was studying on this device.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [roster, subs, ls] = await Promise.all([
        listStudents().catch(() => [] as Student[]),
        listSubjects().catch(() => [] as Subject[]),
        listLessons().catch(() => [] as LessonSummary[]),
      ]);
      if (cancelled) return;
      setStudents(roster);
      setSubjects(subs);
      setLessons(ls);
      const remembered = recallStudent();
      const found = remembered ? roster.find((s) => s.id === remembered) : undefined;
      // A remembered id that no longer exists (student deleted elsewhere) falls back to
      // the picker rather than leaving the page in a half-signed-in state.
      if (found) setMe(found);
      else if (remembered) forgetStudent();
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Progress and weak topics belong to the chosen student, so they reload when it changes.
  useEffect(() => {
    if (!me) {
      setProgress([]);
      setWeak([]);
      return;
    }
    let cancelled = false;
    void Promise.all([
      listProgress(me.id).catch(() => [] as LessonProgress[]),
      listWeak(me.id).catch(() => [] as WeakTopic[]),
    ]).then(([p, w]) => {
      if (cancelled) return;
      setProgress(p);
      setWeak(w);
    });
    return () => {
      cancelled = true;
    };
  }, [me]);

  const pick = useCallback((s: Student) => {
    setMe(s);
    rememberStudent(s.id);
  }, []);

  const addStudent = useCallback(async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const s = await createStudent(name, newLang);
      setStudents((cur) => [...cur, s]);
      pick(s);
      setNewName("");
    } finally {
      setBusy(false);
    }
  }, [newName, newLang, busy, pick]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-24 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t.loading}
      </div>
    );
  }

  // ── Student picker ────────────────────────────────────────────────────────
  if (!me) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <h1 lang="lo" className="text-2xl font-semibold">
          {t.title}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t.subtitle}</p>

        <h2 className="mt-8 text-sm font-medium">{t.whoAreYou}</h2>
        {students.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {students.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => pick(s)}
                  className="hover:bg-accent flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-start transition-colors"
                >
                  <UserRound className="text-muted-foreground size-4 shrink-0" />
                  <span lang="lo" className="flex-1 text-sm font-medium">
                    {s.displayName}
                  </span>
                  <span className="text-muted-foreground font-mono text-xs uppercase">
                    {s.lang}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 rounded-lg border p-3">
          <div className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            {t.newStudent}
          </div>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t.yourName}
            lang="lo"
            onKeyDown={(e) => {
              if (e.key === "Enter") void addStudent();
            }}
          />
          <div className="mt-2 flex gap-2">
            <Select
              value={newLang}
              onChange={(e) => setNewLang(e.target.value as Student["lang"])}
              className="h-8 flex-1"
              title={t.lang}
            >
              <option value="lo">ລາວ</option>
              <option value="en">English</option>
              <option value="both">ລາວ + English</option>
            </Select>
            <Button size="sm" disabled={!newName.trim() || busy} onClick={() => void addStudent()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : t.start}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Signed-in view ────────────────────────────────────────────────────────
  const progressOf = new Map(progress.map((p) => [p.lessonId, p]));
  const bySubject = new Map<string, LessonSummary[]>();
  for (const l of lessons) {
    const list = bySubject.get(l.subjectId) ?? [];
    list.push(l);
    bySubject.set(l.subjectId, list);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 pb-20">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 lang="lo" className="text-2xl font-semibold">
            {t.title}
          </h1>
          <p lang="lo" className="text-muted-foreground mt-0.5 text-sm">
            {me.displayName}
          </p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            forgetStudent();
            setMe(null);
          }}
          className="text-muted-foreground"
        >
          {t.change}
        </Button>
      </header>

      <Link
        href="/learn/practice"
        className="border-primary/30 bg-primary/5 hover:bg-primary/10 mt-6 flex items-center gap-3 rounded-xl border p-4 transition-colors"
      >
        <Dumbbell className="text-primary size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div lang="lo" className="text-sm font-semibold">
            {t.practice}
          </div>
          <div lang="lo" className="text-muted-foreground text-xs">
            {t.practiceSub}
          </div>
        </div>
      </Link>

      {weak.length > 0 && (
        <section className="mt-6">
          <h2 lang="lo" className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <TriangleAlert className="text-muted-foreground size-4" />
            {t.weak}
          </h2>
          <ul className="flex flex-col gap-1.5">
            {weak.slice(0, 4).map((w) => (
              <li
                key={w.qaPairId}
                className="bg-card/50 flex items-baseline gap-2 rounded-lg border px-3 py-2"
              >
                <span lang="lo" className="min-w-0 flex-1 truncate text-sm">
                  {w.questionLo}
                </span>
                <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                  {w.wrong}/{w.attempts} {t.wrongOf}
                </span>
                {/* The way back from a mistake to the explanation — the point of tracking
                    mistakes at all. */}
                {w.lessonId && (
                  <Link
                    href={`/learn/${w.lessonId}`}
                    className="text-primary shrink-0 text-xs underline underline-offset-2"
                  >
                    {t.lessons}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium">{t.lessons}</h2>
        {lessons.length === 0 ? (
          <div className="text-muted-foreground rounded-xl border border-dashed p-8 text-center">
            <BookOpen className="mx-auto size-6 opacity-40" />
            <p lang="lo" className="mt-2 text-sm">
              {t.noLessons}
            </p>
            <p className="mt-1 text-xs">{t.noLessonsHint}</p>
          </div>
        ) : (
          subjects
            .filter((s) => (bySubject.get(s.id) ?? []).length > 0)
            .map((s) => (
              <div key={s.id} className="mb-6">
                <h3
                  lang="lo"
                  className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase"
                >
                  {s.nameLo}
                  {s.nameEn ? ` · ${s.nameEn}` : ""}
                </h3>
                <ul className="flex flex-col gap-2">
                  {(bySubject.get(s.id) ?? []).map((l) => {
                    const p = progressOf.get(l.id);
                    const done = Boolean(p?.completedAt);
                    const pct = p
                      ? Math.round(((p.furthestSeq + 1) / Math.max(l.stepCount, 1)) * 100)
                      : 0;
                    return (
                      <li key={l.id}>
                        <Link
                          href={`/learn/${l.id}`}
                          className="hover:bg-accent/50 block rounded-xl border p-3.5 transition-colors"
                        >
                          <div className="flex items-baseline gap-2">
                            <span
                              lang="lo"
                              className="min-w-0 flex-1 text-sm font-semibold text-balance"
                            >
                              {l.titleLo}
                            </span>
                            {done && (
                              <span className="text-primary flex shrink-0 items-center gap-1 text-xs font-medium">
                                <Check className="size-3.5" />
                                {t.done}
                              </span>
                            )}
                          </div>
                          {l.summaryLo && (
                            <p
                              lang="lo"
                              className="text-muted-foreground mt-1 text-xs leading-relaxed"
                            >
                              {l.summaryLo}
                            </p>
                          )}
                          <div className="text-muted-foreground mt-2 flex items-center gap-3 text-xs">
                            <span className="flex items-center gap-1 tabular-nums">
                              <Clock className="size-3" />
                              {l.estimatedMinutes} {t.minutes}
                            </span>
                            <span className="tabular-nums">
                              {l.stepCount} {t.steps}
                            </span>
                            {/* role="img" so the label is announced: a bare span carries
                                no role, and aria-label on one is ignored. */}
                            <span
                              className="flex gap-0.5"
                              role="img"
                              aria-label={`difficulty ${l.difficulty} of 5`}
                            >
                              {Array.from({ length: 5 }, (_, i) => (
                                <span
                                  key={`d-${l.id}-${i}`}
                                  className={cn(
                                    "size-1.5 rounded-full",
                                    i < l.difficulty ? "bg-muted-foreground/60" : "bg-muted",
                                  )}
                                />
                              ))}
                            </span>
                          </div>
                          {p && !done && (
                            <div className="mt-2">
                              <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
                                <div
                                  className="bg-primary h-full rounded-full"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-muted-foreground mt-1 block text-[0.65rem]">
                                {t.inProgress} · {pct}%
                              </span>
                            </div>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
        )}
      </section>
    </div>
  );
}

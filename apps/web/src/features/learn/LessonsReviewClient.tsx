"use client";

import type { LessonDetail, LessonSummary, Subject } from "@arnfar/contracts";
import { Button } from "@arnfar/ui/components/button";
import { Input } from "@arnfar/ui/components/input";
import { Select } from "@arnfar/ui/components/select";
import { cn } from "@arnfar/ui/lib/utils";
import { Check, Loader2, Plus, Sparkles, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  addStep,
  createSubject,
  deleteLesson,
  draftLesson,
  getCuratorLesson,
  listCuratorLessons,
  listSubjects,
  unverifyLesson,
  verifyLesson,
} from "./api";
import { StepEditor } from "./StepEditor";

/**
 * The lesson review queue.
 *
 * Drafts sort first, because this page exists to empty that queue. Approving is one click;
 * reading the whole lesson before approving takes as many clicks as it has steps, and the
 * design makes the reading the easy path — the whole lesson expands inline, with each
 * step's citations shown beside it, so a reviewer never has to leave to check a claim.
 */

const UI = {
  lo: {
    title: "ບົດຮຽນ",
    subtitle: "ຮ່າງ → ກວດ → ຢືນຢັນ. ນັກຮຽນເຫັນສະເພາະບົດຮຽນທີ່ຢືນຢັນແລ້ວ",
    draft: "ຮ່າງ",
    live: "ນັກຮຽນເຫັນ",
    approve: "ຢືນຢັນ",
    unapprove: "ຖອນການຢືນຢັນ",
    remove: "ລຶບ",
    newLesson: "ຮ່າງບົດຮຽນໃໝ່",
    topic: "ຫົວຂໍ້ທີ່ຢາກສອນ",
    generate: "ຮ່າງ",
    steps: "ຂັ້ນຕອນ",
    noLessons: "ຍັງບໍ່ມີບົດຮຽນ",
    noSubjects: "ຕ້ອງສ້າງວິຊາກ່ອນ",
    newSubject: "ວິຊາໃໝ່",
    subjectName: "ຊື່ວິຊາ",
    create: "ສ້າງ",
    cites: "ອ້າງອີງ",
    loading: "ກຳລັງໂຫຼດ…",
    drafting: "ກຳລັງຮ່າງ… ອາດໃຊ້ເວລາ 1-3 ນາທີ",
    dropped: "ຂັ້ນຕອນທີ່ຖືກຕັດອອກ (ບໍ່ມີແຫຼ່ງອ້າງອີງ)",
    addStep: "ເພີ່ມຂັ້ນຕອນ",
  },
  en: {
    title: "Lessons",
    subtitle: "Draft → review → approve. Students see approved lessons only",
    draft: "Draft",
    live: "Live",
    approve: "Approve",
    unapprove: "Unapprove",
    remove: "Delete",
    newLesson: "Draft a new lesson",
    topic: "What should it teach?",
    generate: "Draft",
    steps: "steps",
    noLessons: "No lessons yet",
    noSubjects: "Create a subject first",
    newSubject: "New subject",
    subjectName: "Subject name",
    create: "Create",
    cites: "cites",
    loading: "Loading…",
    drafting: "Drafting… this can take 1–3 minutes",
    dropped: "steps dropped (no citation)",
    addStep: "Add step",
  },
} as const;

type Chrome = keyof typeof UI;

export function LessonsReviewClient({ chrome = "en" }: { chrome?: Chrome }) {
  const t = UI[chrome];
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [expanded, setExpanded] = useState<Record<string, LessonDetail>>({});
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [topic, setTopic] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [newSubject, setNewSubject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [subs, ls] = await Promise.all([
      listSubjects().catch(() => [] as Subject[]),
      listCuratorLessons().catch(() => [] as LessonSummary[]),
    ]);
    setSubjects(subs);
    setLessons(ls);
    setSubjectId((cur) => cur || (subs[0]?.id ?? ""));
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Re-read one lesson and the list after an edit.
   *  The list too, not just the lesson: every edit withdraws approval server-side, so the
   *  Live/Draft badge is stale the moment a step changes. */
  const refreshLesson = useCallback(async (id: string) => {
    const [detail, ls] = await Promise.all([
      getCuratorLesson(id).catch(() => null),
      listCuratorLessons().catch(() => null),
    ]);
    if (detail) setExpanded((e) => ({ ...e, [id]: detail }));
    if (ls) setLessons(ls);
  }, []);

  const toggle = useCallback(
    async (id: string) => {
      if (expanded[id]) {
        setExpanded((e) => {
          const { [id]: _dropped, ...rest } = e;
          return rest;
        });
        return;
      }
      const detail = await getCuratorLesson(id).catch(() => null);
      if (detail) setExpanded((e) => ({ ...e, [id]: detail }));
    },
    [expanded],
  );

  const draft = useCallback(async () => {
    if (!topic.trim() || !subjectId || drafting) return;
    setDrafting(true);
    setError(null);
    setNote(null);
    try {
      const r = await draftLesson({ subjectId, topic: topic.trim() });
      setTopic("");
      setNote(
        `${r.titleLo} — ${r.stepCount} ${t.steps}` +
          (r.droppedSteps > 0 ? ` · ${r.droppedSteps} ${t.dropped}` : ""),
      );
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  }, [topic, subjectId, drafting, reload, t]);

  const addSubject = useCallback(async () => {
    const name = newSubject.trim();
    if (!name) return;
    // A slug is derived rather than asked for: the key is a URL detail, and making a
    // curator invent one is a question with no interesting answer.
    const key =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || `subject-${Date.now()}`;
    await createSubject({ key, nameLo: name }).catch(() => null);
    setNewSubject("");
    await reload();
  }, [newSubject, reload]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-24 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t.loading}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20" style={{ paddingTop: "var(--studio-nav-h)" }}>
      <header className="py-6">
        <h1 className="text-2xl font-semibold">{t.title}</h1>
        <p lang="lo" className="text-muted-foreground mt-1 text-sm">
          {t.subtitle}
        </p>
      </header>

      {subjects.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6">
          <p className="text-muted-foreground text-sm">{t.noSubjects}</p>
          <div className="mt-3 flex gap-2">
            <Input
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              placeholder={t.subjectName}
              lang="lo"
            />
            <Button size="sm" onClick={() => void addSubject()} disabled={!newSubject.trim()}>
              <Plus className="size-4" />
              {t.create}
            </Button>
          </div>
        </div>
      ) : (
        <div className="bg-card/50 rounded-xl border p-4">
          <div className="mb-2 text-sm font-medium">{t.newLesson}</div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              className="h-9 sm:w-48"
            >
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nameLo}
                </option>
              ))}
            </Select>
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t.topic}
              lang="lo"
              className="flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") void draft();
              }}
            />
            <Button size="sm" onClick={() => void draft()} disabled={!topic.trim() || drafting}>
              {drafting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              {t.generate}
            </Button>
          </div>
          {drafting && <p className="text-muted-foreground mt-2 text-xs">{t.drafting}</p>}
          {note && <p className="text-primary mt-2 text-xs">{note}</p>}
          {error && <p className="text-destructive mt-2 text-xs">{error}</p>}
        </div>
      )}

      <ul className="mt-6 flex flex-col gap-2">
        {lessons.length === 0 && (
          <li className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
            {t.noLessons}
          </li>
        )}
        {lessons.map((l) => {
          const detail = expanded[l.id];
          return (
            <li key={l.id} className="rounded-xl border">
              <div className="flex items-start gap-3 p-3.5">
                <button
                  type="button"
                  onClick={() => void toggle(l.id)}
                  className="min-w-0 flex-1 text-start"
                >
                  <div className="flex items-baseline gap-2">
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-medium",
                        l.verified
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {l.verified ? t.live : t.draft}
                    </span>
                    <span lang="lo" className="min-w-0 flex-1 text-sm font-semibold">
                      {l.titleLo}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-1 text-xs tabular-nums">
                    {l.stepCount} {t.steps} · {l.estimatedMinutes} min · {l.source}
                  </div>
                </button>
                <div className="flex shrink-0 gap-1">
                  {l.verified ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={async () => {
                        await unverifyLesson(l.id);
                        await reload();
                      }}
                      className="text-muted-foreground"
                    >
                      <Undo2 className="size-3.5" />
                      {t.unapprove}
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      onClick={async () => {
                        await verifyLesson(l.id);
                        await reload();
                      }}
                    >
                      <Check className="size-3.5" />
                      {t.approve}
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={async () => {
                      await deleteLesson(l.id);
                      await reload();
                    }}
                    className="text-muted-foreground"
                    aria-label={t.remove}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>

              {detail && (
                <div className="border-t px-3.5 py-3">
                  {detail.steps.map((s, si) => (
                    <StepEditor
                      key={s.id}
                      step={s}
                      isFirst={si === 0}
                      isLast={si === detail.steps.length - 1}
                      onChanged={() => refreshLesson(l.id)}
                    />
                  ))}
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={async () => {
                      // A new step starts as `intro`: it is the one kind that may be
                      // uncited, so the row is accepted and the curator fills it in
                      // rather than being refused before they have written anything.
                      await addStep(l.id, { kind: "intro", bodyLo: "…" }).catch(() => {});
                      await refreshLesson(l.id);
                    }}
                  >
                    <Plus className="size-3.5" />
                    {t.addStep}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

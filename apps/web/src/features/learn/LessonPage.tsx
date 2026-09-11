"use client";

import type { Student } from "@arnfar/contracts";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { listStudents, recallStudent } from "./api";
import { LessonPlayer } from "./LessonPlayer";

/**
 * Resolves who is studying, then hands off to the player.
 *
 * Separate from the player because the student lives in localStorage: the server shell
 * cannot know it, so this waits for the browser before rendering anything that depends on
 * it. A lesson still opens without a student — reading is allowed; only progress needs a
 * name attached.
 */
export function LessonPage({ lessonId }: { lessonId: string }) {
  const [me, setMe] = useState<Student | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = recallStudent();
      if (!id) {
        if (!cancelled) setResolved(true);
        return;
      }
      const roster = await listStudents().catch(() => [] as Student[]);
      if (cancelled) return;
      setMe(roster.find((s) => s.id === id) ?? null);
      setResolved(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!resolved) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-24 text-sm">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  return (
    <>
      {!me && (
        <div className="bg-muted/50 border-b px-4 py-2 text-center text-xs">
          <span lang="lo" className="text-muted-foreground">
            ຄວາມຄືບໜ້າຈະບໍ່ຖືກບັນທຶກ ·{" "}
          </span>
          <Link href="/learn" className="text-primary underline underline-offset-2">
            ເລືອກຜູ້ຮຽນ
          </Link>
        </div>
      )}
      <LessonPlayer lessonId={lessonId} student={me} />
    </>
  );
}

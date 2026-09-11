import { LessonPage } from "@/features/learn/LessonPage";

export const metadata = { title: "Lesson — Arnfar AI" };

/** The lesson route. Params are awaited (Next 15) and handed to the client player, which
 *  owns the student selection — the student lives in localStorage, so the shell cannot
 *  know who is studying and must not try to render as if it did. */
export default async function Page({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  return <LessonPage lessonId={lessonId} />;
}

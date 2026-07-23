"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Flag, Pencil, Plus, Square, X } from "lucide-react";

import { Button } from "@arnfar/ui/components/button";
import { Input } from "@arnfar/ui/components/input";
import { Select } from "@arnfar/ui/components/select";
import { cn } from "@arnfar/ui/lib/utils";

import { renderMarkdown } from "@/features/chat/markdown";
import type { StoredMessage, StoredSource } from "@/features/chat/storage";
import { promoteToDataset, reportWrong } from "@/features/chat/chatApi";

import { useKnowledgeKinds } from "@/features/studio/useCollections";
import { shortModel, useModels } from "@/features/chat/useModels";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

/** Chrome only — the language toggle never touches message content (CLAUDE.md). */
const UI = {
  lo: {
    title: "ສອນ AI",
    subtitle: "ຖາມ → ກວດ → ຢືນຢັນ — ຄຳຕອບທີ່ຢືນຢັນ ກາຍເປັນ dataset",
    placeholder: "ຖາມເພື່ອທົດສອບ ຫຼື ສອນ…",
    greeting: "ຖາມຄຳຖາມ ທີ່ຜູ້ໃຊ້ຕົວຈິງຈະຖາມ",
    greetSub: "ຖ້າຄຳຕອບຖືກ → ຢືນຢັນ. ຜິດ → ແກ້ໄຂ. ບໍ່ມີຂໍ້ມູນ → ເພີ່ມຄວາມຮູ້.",
    approve: "ຖືກຕ້ອງ",
    saved: "ບັນທຶກເປັນ QA ຢືນຢັນແລ້ວ",
    edit: "ແກ້ໄຂ",
    saveEdit: "ບັນທຶກສະບັບແກ້",
    cancel: "ຍົກເລີກ",
    wrong: "ຜິດ",
    reported: "ລາຍງານແລ້ວ — ສົ່ງໄປ review",
    abstained: "ບໍ່ພົບຂໍ້ມູນໃນ dataset — AI ບໍ່ຕອບເດົາ",
    abstainedHint: "ຂຽນຄຳຕອບເອງ ພ້ອມອ້າງອີງ ໃນໜ້າ QA, ຫຼື ເພີ່ມເອກະສານກ່ອນ.",
    writeQa: "ຂຽນ QA ເອງ",
    sources: "ແຫຼ່ງອ້າງອີງ",
    noSources: "ຍັງບໍ່ມີ — ຖາມກ່ອນ, ແຫຼ່ງທີ່ AI ໃຊ້ຈະສະແດງບ່ອນນີ້",
    newSession: "ເລີ່ມໃໝ່",
    stop: "ຢຸດ",
    send: "ສົ່ງ",
    hint: "Enter ສົ່ງ · Shift+Enter ຂຶ້ນແຖວໃໝ່",
  },
  en: {
    title: "Teach",
    subtitle: "ask → check → approve — approved answers become the dataset",
    placeholder: "Ask to test or teach…",
    greeting: "Ask what a real user would ask",
    greetSub: "Right → approve. Wrong → correct it. Missing → add the knowledge.",
    approve: "Correct",
    saved: "Saved as verified QA",
    edit: "Edit",
    saveEdit: "Save correction",
    cancel: "Cancel",
    wrong: "Wrong",
    reported: "Reported — sent to review",
    abstained: "Not in the dataset — the AI won't guess",
    abstainedHint: "Write the answer with citations on the QA page, or add the source document first.",
    writeQa: "Write QA by hand",
    sources: "Sources",
    noSources: "None yet — ask first; the sources the AI used appear here",
    newSession: "New session",
    stop: "Stop",
    send: "Send",
    hint: "Enter to send · Shift+Enter for a new line",
  },
} as const;

type Lang = keyof typeof UI;

interface StreamEvent {
  readonly type: string;
  readonly t?: string;
  readonly error?: string;
  readonly sources?: readonly StoredSource[];
  readonly conversationId?: string;
}

/** An assistant turn is "grounded" when it actually cited something — the cite-or-abstain
 *  prompt makes SEA-LION emit [n] markers only when the answer comes from a chunk. */
function isGrounded(msg: StoredMessage): boolean {
  return (msg.sources ?? []).length > 0 && /\[\d+\]/.test(msg.content);
}

export function TeachClient() {
  const KINDS = useKnowledgeKinds();
  const MODELS = useModels();
  const [messages, setMessages] = useState<readonly StoredMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [lang, setLang] = useState<Lang>("lo");
  const [k, setK] = useState(8);
  // Same scope semantics as /chat: "" = all knowledge, "kind:KEY" = one kind.
  const [scope, setScope] = useState("");
  const [model, setModel] = useState("");
  /** Which assistant message's sources fill the rail (defaults to the latest). */
  const [railIdx, setRailIdx] = useState<number | null>(null);
  const [focusN, setFocusN] = useState<number | null>(null);
  /** Inline correction editor: which message, and the draft text. */
  const [editing, setEditing] = useState<{ idx: number; text: string } | null>(null);
  const [errorNote, setErrorNote] = useState<string | null>(null);

  // Multi-turn context: the server assigns a conversation id on the first stream.
  const convIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const t = UI[lang];

  useEffect(() => {
    const stored = localStorage.getItem("arnfar.chat.lang");
    if (stored === "lo" || stored === "en") setLang(stored);
    const storedModel = localStorage.getItem("arnfar.chat.model");
    if (storedModel) setModel(storedModel);
  }, []);

  // Default to the server's configured generator once the list arrives (same as /chat).
  useEffect(() => {
    if (MODELS.models.length === 0) return;
    setModel((cur) => (cur && MODELS.models.includes(cur) ? cur : MODELS.default));
  }, [MODELS]);

  useEffect(() => {
    if (model) localStorage.setItem("arnfar.chat.model", model);
  }, [model]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 160) el.scrollTo({ top: el.scrollHeight });
  }, [messages]);

  /** Pure updater only — StrictMode double-invokes, mutation doubles streamed tokens. */
  const patchMessage = useCallback((idx: number, patch: (m: StoredMessage) => StoredMessage) => {
    setMessages((cur) => cur.map((m, j) => (j === idx ? patch(m) : m)));
  }, []);

  async function send(question: string) {
    const q = question.trim();
    if (!q || streaming) return;
    setInput("");
    setErrorNote(null);
    if (composerRef.current) composerRef.current.style.height = "auto";

    const assistantIdx = messages.length + 1;
    setMessages((cur) => [
      ...cur,
      { role: "user", content: q },
      { role: "assistant", content: "", sources: [], question: q },
    ]);
    setRailIdx(assistantIdx);
    setFocusN(null);

    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Token batching (same as ChatClient): SEA-LION streams character-level tokens for
    // Lao; one setState per character re-renders the whole thread and stalls on tables.
    let pending = "";
    let flushTimer: number | null = null;
    const flushPending = () => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pending) return;
      const chunk = pending;
      pending = "";
      patchMessage(assistantIdx, (m) => ({ ...m, content: m.content + chunk }));
    };

    try {
      const res = await fetch(`${BASE}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: q,
          k,
          ...(convIdRef.current ? { conversationId: convIdRef.current } : {}),
          ...(scope.startsWith("kind:") ? { kinds: [scope.slice(5)] } : {}),
          ...(model ? { model } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`rag-api responded ${res.status}`);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const ev = JSON.parse(line.slice(5).trim()) as StreamEvent;
          if (ev.type === "created" && ev.conversationId) {
            convIdRef.current = ev.conversationId;
          } else if (ev.type === "citations") {
            patchMessage(assistantIdx, (m) => ({ ...m, sources: ev.sources ?? [] }));
          } else if (ev.type === "token") {
            pending += ev.t ?? "";
            if (flushTimer === null) {
              flushTimer = window.setTimeout(() => {
                flushTimer = null;
                flushPending();
              }, 80);
            }
          } else if (ev.type === "error") {
            flushPending();
            patchMessage(assistantIdx, (m) => ({
              ...m,
              content: `${m.content}\n\n_[error: ${ev.error ?? "unknown"}]_`,
            }));
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        flushPending();
        patchMessage(assistantIdx, (m) => ({
          ...m,
          content: `${m.content}\n\n_[error: ${(e as Error).message}]_`,
        }));
      }
    } finally {
      flushPending();
      setStreaming(false);
      abortRef.current = null;
    }
  }

  /** Approve as-is, or approve the curator's corrected text. Verified on the spot. */
  async function approve(idx: number, answerOverride?: string) {
    const msg = messages[idx];
    if (!msg) return;
    const ids = (msg.sources ?? []).map((s) => s.id);
    const answer = (answerOverride ?? msg.content).trim();
    if (!ids.length || !answer) return;
    try {
      await promoteToDataset({
        question: msg.question ?? "",
        answer,
        citationIds: ids,
        tags: ["teach"],
        verify: true,
        reviewer: "teach",
      });
      patchMessage(idx, (m) => ({
        ...m,
        // Show what was actually saved — a correction replaces the displayed answer.
        content: answerOverride !== undefined ? answer : m.content,
        promoted: true,
      }));
      setEditing(null);
    } catch (e) {
      setErrorNote((e as Error).message);
    }
  }

  async function report(idx: number) {
    const msg = messages[idx];
    const ids = (msg?.sources ?? []).map((s) => s.id);
    if (!ids.length) return;
    try {
      await reportWrong(ids);
      patchMessage(idx, (m) => ({ ...m, reported: true }));
    } catch (e) {
      setErrorNote((e as Error).message);
    }
  }

  function newSession() {
    abortRef.current?.abort();
    convIdRef.current = null;
    setMessages([]);
    setRailIdx(null);
    setFocusN(null);
    setEditing(null);
    setErrorNote(null);
    composerRef.current?.focus();
  }

  const railSources: readonly StoredSource[] =
    (railIdx !== null ? messages[railIdx]?.sources : undefined) ?? [];

  return (
    <div className="flex h-[calc(100dvh-3.1rem)] overflow-hidden">
      {/* ── Teach column ─────────────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
          <span className="text-sm font-medium">{t.title}</span>
          <span className="text-muted-foreground hidden text-xs sm:inline">{t.subtitle}</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setLang(lang === "lo" ? "en" : "lo")}
            className="text-muted-foreground ml-auto"
          >
            {lang === "lo" ? "EN" : "ລາວ"}
          </Button>
          <Button size="xs" variant="outline" onClick={newSession} className="gap-1.5">
            <Plus className="size-3.5" />
            {t.newSession}
          </Button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-6">
            {messages.length === 0 ? (
              <div className="flex min-h-[45vh] flex-col items-center justify-center text-center">
                <span className="bg-primary text-primary-foreground mb-4 flex size-11 items-center justify-center rounded-xl text-lg">
                  ✦
                </span>
                <p lang="lo" className="text-xl font-semibold">
                  {t.greeting}
                </p>
                <p lang="lo" className="text-muted-foreground mt-1.5 max-w-md text-sm">
                  {t.greetSub}
                </p>
              </div>
            ) : (
              messages.map((msg, i) =>
                msg.role === "user" ? (
                  <div key={i} className="mb-6 flex justify-end">
                    <div
                      lang="lo"
                      className="bg-chat-user text-chat-user-foreground max-w-[85%] rounded-2xl rounded-ee-md px-4 py-2.5 text-[1.02rem] leading-[1.7] whitespace-pre-wrap"
                    >
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="mb-8">
                    {editing?.idx === i ? (
                      /* ── Inline correction editor ── */
                      <div className="border-border rounded-xl border p-3">
                        <textarea
                          lang="lo"
                          value={editing.text}
                          onChange={(e) =>
                            setEditing((cur) => (cur ? { ...cur, text: e.target.value } : cur))
                          }
                          rows={6}
                          autoFocus
                          className="w-full resize-y bg-transparent text-[1.02rem] leading-[1.7] outline-none"
                        />
                        <div className="mt-2 flex items-center gap-1.5">
                          <Button
                            size="xs"
                            disabled={!editing.text.trim()}
                            onClick={() => void approve(i, editing.text)}
                            className="gap-1.5"
                          >
                            <Check className="size-3.5" />
                            {t.saveEdit}
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => setEditing(null)}
                            className="text-muted-foreground gap-1.5"
                          >
                            <X className="size-3.5" />
                            {t.cancel}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-[1.02rem]">
                        {msg.content ? (
                          renderMarkdown(msg.content, (n) => {
                            setRailIdx(i);
                            setFocusN(n);
                          })
                        ) : (
                          <span className="inline-flex gap-1 py-2">
                            <Dot delay="0ms" />
                            <Dot delay="150ms" />
                            <Dot delay="300ms" />
                          </span>
                        )}
                        {streaming && i === messages.length - 1 && msg.content && (
                          <span className="bg-foreground ms-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse" />
                        )}
                      </div>
                    )}

                    {/* ── Verdict bar (only once the turn is finished) ── */}
                    {msg.content &&
                      !(streaming && i === messages.length - 1) &&
                      editing?.idx !== i &&
                      (isGrounded(msg) ? (
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          {msg.promoted ? (
                            <span className="text-primary inline-flex items-center gap-1.5 text-sm font-medium">
                              <Check className="size-4" />
                              {t.saved}
                            </span>
                          ) : (
                            <>
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => void approve(i)}
                                className="gap-1.5 border-emerald-600/40 text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400"
                              >
                                <Check className="size-3.5" />
                                {t.approve}
                              </Button>
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => setEditing({ idx: i, text: msg.content })}
                                className="gap-1.5"
                              >
                                <Pencil className="size-3.5" />
                                {t.edit}
                              </Button>
                            </>
                          )}
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={msg.reported === true}
                            onClick={() => void report(i)}
                            className="text-muted-foreground gap-1.5"
                          >
                            {msg.reported ? <Check className="size-3.5" /> : <Flag className="size-3.5" />}
                            {msg.reported ? t.reported : t.wrong}
                          </Button>
                        </div>
                      ) : (
                        /* ── Abstained: the gap IS the signal ── */
                        <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
                          <p lang="lo" className="text-sm font-medium">
                            {t.abstained}
                          </p>
                          <p lang="lo" className="text-muted-foreground mt-1 text-sm">
                            {t.abstainedHint}
                          </p>
                          <Link
                            href="/studio/qa"
                            className="border-input hover:bg-accent hover:text-accent-foreground mt-2.5 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors"
                          >
                            <Pencil className="size-3.5" />
                            {t.writeQa}
                          </Link>
                        </div>
                      ))}
                  </div>
                ),
              )
            )}
            {errorNote && (
              <p className="text-destructive mb-4 text-sm" role="alert">
                {errorNote}
              </p>
            )}
          </div>
        </div>

        {/* ── Composer ── */}
        <div className="shrink-0 px-6 pb-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="border-border bg-card focus-within:border-ring/50 mx-auto w-full max-w-3xl rounded-2xl border shadow-sm transition-shadow focus-within:shadow-md"
          >
            <textarea
              ref={composerRef}
              lang="lo"
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
              }}
              onKeyDown={(e) => {
                // isComposing guards the Lao IME — Enter on a candidate commit must not send.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder={t.placeholder}
              className="placeholder:text-muted-foreground max-h-[200px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[1.02rem] leading-[1.6] outline-none"
            />
            <div className="text-muted-foreground flex items-center gap-2 px-3 pb-2.5 text-xs">
              <label className="flex items-center gap-1" title="Chunks retrieved per question">
                k
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={k}
                  onChange={(e) => setK(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
                  className="h-7 w-14"
                />
              </label>
              <Select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="h-7"
                title="ຂອບເຂດຄວາມຮູ້ · knowledge scope"
              >
                <option value="">ຄວາມຮູ້ທັງໝົດ · all knowledge</option>
                {KINDS.length > 0 && (
                  <optgroup label="ປະເພດຄວາມຮູ້ · knowledge">
                    {KINDS.map((kd) => (
                      <option key={kd.key} value={`kind:${kd.key}`}>
                        {kd.nameLo}
                        {kd.nameEn ? ` · ${kd.nameEn}` : ""}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
              {MODELS.models.length > 1 && (
                <Select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="h-7"
                  title="ໂມເດວ · model"
                >
                  {MODELS.models.map((m) => (
                    <option key={m} value={m}>
                      {shortModel(m)}
                      {m === MODELS.default ? " ★" : ""}
                    </option>
                  ))}
                </Select>
              )}
              <span className="ms-auto hidden sm:inline">{t.hint}</span>
              {streaming ? (
                <Button
                  type="button"
                  size="icon"
                  onClick={() => abortRef.current?.abort()}
                  title={t.stop}
                  className="bg-foreground text-background"
                >
                  <Square className="fill-current" />
                </Button>
              ) : (
                <Button type="submit" size="icon" disabled={!input.trim()} title={t.send}>
                  <ArrowUp />
                </Button>
              )}
            </div>
          </form>
        </div>
      </main>

      {/* ── Sources rail — persistent, so the curator checks BEFORE approving ── */}
      <aside className="border-border bg-card hidden w-[360px] shrink-0 flex-col border-s lg:flex">
        <div className="border-border flex h-11 shrink-0 items-center gap-2 border-b px-4">
          <span className="text-sm font-medium">{t.sources}</span>
          {railSources.length > 0 && (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[0.7rem]">
              {railSources.length}
            </span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {railSources.length === 0 ? (
            <p lang="lo" className="text-muted-foreground px-2 py-6 text-center text-sm">
              {t.noSources}
            </p>
          ) : (
            railSources.map((s) => (
              <div
                key={s.id}
                className={cn(
                  "border-border mb-2 rounded-lg border px-3 py-2.5 transition-colors",
                  focusN === s.n && "border-primary/60 bg-primary/5",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="bg-citation/15 text-citation flex size-5 shrink-0 items-center justify-center rounded text-xs font-semibold">
                    {s.n}
                  </span>
                  <span className="truncate text-sm font-medium" title={s.title}>
                    {s.title}
                  </span>
                </div>
                {s.headingPath.length > 0 && (
                  <p lang="lo" className="text-muted-foreground mt-1 truncate text-xs">
                    {s.headingPath.join(" › ")}
                  </p>
                )}
                <p lang="lo" className="mt-1.5 line-clamp-4 text-[0.85rem] leading-[1.7] whitespace-pre-wrap">
                  {s.content}
                </p>
                <div className="text-muted-foreground mt-1.5 flex gap-2 text-[0.7rem]">
                  <span>{s.kind}</span>
                  {s.authority && <span>· {s.authority}</span>}
                  {s.effectiveDate && <span>· {s.effectiveDate}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="bg-muted-foreground size-1.5 animate-bounce rounded-full"
      style={{ animationDelay: delay }}
    />
  );
}

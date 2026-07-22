"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  BookOpen,
  Check,
  Copy,
  Flag,
  Loader2,
  Moon,
  PanelLeft,
  PenLine,
  Plus,
  Quote,
  Search,
  Square,
  Sun,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@arnfar/ui/components/button";
import { Input } from "@arnfar/ui/components/input";
import { Select } from "@arnfar/ui/components/select";
import { cn } from "@arnfar/ui/lib/utils";

import { renderMarkdown } from "./markdown";
import {
  groupByRecency,
  titleFrom,
  type Conversation,
  type StoredMessage,
  type StoredSource,
} from "./storage";
import {
  deleteConversation as deleteConversationApi,
  getConversation,
  listConversations,
  promoteToDataset,
  reportWrong,
  type ConversationSummary,
} from "./chatApi";

import { useCollections } from "@/features/studio/useCollections";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

/**
 * Chrome only. The language toggle never touches message content — Lao answers stay Lao
 * and are never machine-translated (CLAUDE.md).
 */
const UI = {
  lo: {
    placeholder: "ຖາມຄຳຖາມບັນຊີ…",
    greeting: "ຖາມກ່ຽວກັບ ບັນຊີ, ໝວດບັນຊີ, ພາສີ",
    subtitle: "ຕອບພ້ອມແຫຼ່ງອ້າງອີງ ຫຼື ບໍ່ຕອບ",
    newChat: "ສົນທະນາໃໝ່",
    send: "ສົ່ງ",
    stop: "ຢຸດ",
    promote: "ເພີ່ມເຂົ້າ dataset",
    promoted: "ເພີ່ມແລ້ວ",
    report: "ລາຍງານຜິດ",
    reported: "ລາຍງານແລ້ວ",
    copy: "ສຳເນົາ",
    sources: "ແຫຼ່ງອ້າງອີງ",
    empty: "ຍັງບໍ່ມີການສົນທະນາ",
    hint: "Enter ສົ່ງ · Shift+Enter ຂຶ້ນແຖວໃໝ່",
    phaseSearch: "ກຳລັງຄົ້ນຫາແຫຼ່ງອ້າງອີງ",
    phaseRead: "ອ່ານແຫຼ່ງອ້າງອີງ",
    phaseWrite: "ກຳລັງຮ່າງຄຳຕອບ",
  },
  en: {
    placeholder: "Ask an accounting question…",
    greeting: "Ask about accounting, chart of accounts, tax",
    subtitle: "cited or abstains",
    newChat: "New chat",
    send: "Send",
    stop: "Stop",
    promote: "Promote to dataset",
    promoted: "Promoted",
    report: "Report wrong",
    reported: "Reported",
    copy: "Copy",
    sources: "Sources",
    empty: "No conversations yet",
    hint: "Enter to send · Shift+Enter for a new line",
    phaseSearch: "Searching sources",
    phaseRead: "Reading sources",
    phaseWrite: "Composing answer",
  },
} as const;

type Lang = keyof typeof UI;
type Theme = "light" | "dark";

/** The visible stages of a streamed answer, in order. Driven by the SSE event sequence. */
type StreamPhase = "searching" | "reading" | "writing";
const PHASE_ORDER: readonly StreamPhase[] = ["searching", "reading", "writing"];

/** One SSE frame from `POST /chat/stream`. */
interface StreamEvent {
  readonly type: string;
  readonly t?: string;
  readonly error?: string;
  readonly sources?: readonly StoredSource[];
  readonly conversationId?: string;
}

export function ChatClient() {
  const COLLECTIONS = useCollections();
  // Sidebar list — summaries only (no messages) so the list stays cheap.
  const [summaries, setSummaries] = useState<readonly ConversationSummary[]>([]);
  // Full message thread for the active conversation (loaded on open).
  const [activeThread, setActiveThread] = useState<Conversation | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // Progress for the in-flight answer: which stage, and how many sources were retrieved.
  const [phase, setPhase] = useState<StreamPhase | null>(null);
  const [phaseSources, setPhaseSources] = useState(0);
  const [lang, setLang] = useState<Lang>("lo");
  const [theme, setTheme] = useState<Theme>("light");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panel, setPanel] = useState<StoredSource | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [k, setK] = useState(8);
  const [collection, setCollection] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const t = UI[lang];
  const messages = activeThread?.messages ?? [];

  // Load the conversation list from the server after mount (avoid hydration mismatch).
  useEffect(() => {
    void listConversations().then(setSummaries).catch(() => setSummaries([]));
    const storedLang = localStorage.getItem("arnfar.chat.lang");
    if (storedLang === "lo" || storedLang === "en") setLang(storedLang);
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    setHydrated(true);
  }, []);

  // When the active conversation changes, load its full message thread.
  useEffect(() => {
    if (!activeId) {
      setActiveThread(null);
      return;
    }
    let cancelled = false;
    void getConversation(activeId)
      .then((conv) => {
        if (!cancelled) setActiveThread(conv);
      })
      .catch(() => {
        if (!cancelled) setActiveThread(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    if (hydrated) localStorage.setItem("arnfar.chat.lang", lang);
  }, [lang, hydrated]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      localStorage.setItem("arnfar.theme", next);
      return next;
    });
  }, []);

  // Follow the stream, but only while the reader is already near the bottom — yanking the
  // viewport down while they are reading an earlier citation is infuriating.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 160) el.scrollTo({ top: el.scrollHeight });
  }, [messages]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Patch a message in the active thread by index. Pure updaters only (StrictMode). */
  const patchMessage = useCallback(
    (idx: number, patch: (m: StoredMessage) => StoredMessage) => {
      setActiveThread((cur) =>
        cur
          ? { ...cur, updatedAt: Date.now(), messages: cur.messages.map((m, j) => (j === idx ? patch(m) : m)) }
          : cur,
      );
    },
    [],
  );

  async function send(question: string) {
    const q = question.trim();
    if (!q || streaming) return;
    setInput("");
    if (composerRef.current) composerRef.current.style.height = "auto";

    const existingConvId = activeId;
    const assistantIdx = (activeThread?.messages.length ?? 0) + 1;

    // Optimistic: append the user turn + an empty assistant draft so the UI reacts instantly.
    const userMsg: StoredMessage = { role: "user", content: q };
    const draft: StoredMessage = { role: "assistant", content: "", sources: [], question: q };
    if (existingConvId && activeThread) {
      setActiveThread((cur) =>
        cur ? { ...cur, updatedAt: Date.now(), messages: [...cur.messages, userMsg, draft] } : cur,
      );
    } else {
      // No active conversation yet — create a transient local one. The server will assign
      // the real id (emitted in the `created` frame) and we reconcile on first event.
      setActiveThread({
        id: "pending",
        title: titleFrom(q),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [userMsg, draft],
      });
    }

    setStreaming(true);
    setPhase("searching");
    setPhaseSources(0);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(`${BASE}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Multi-turn: send the conversationId so the server loads history for context.
        // If absent the server creates a new conversation and returns its id via `created`.
        body: JSON.stringify({
          message: q,
          k,
          ...(existingConvId ? { conversationId: existingConvId } : {}),
          ...(collection ? { collections: [collection] } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`rag-api responded ${res.status}`);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let serverConvId: string | null = null;

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
            // Reconcile: the server assigned the real conversation id. Wire it into state
            // and refresh the sidebar so the new thread appears.
            serverConvId = ev.conversationId;
            setActiveThread((cur) => (cur && cur.id === "pending" ? { ...cur, id: serverConvId! } : cur));
            setActiveId(serverConvId);
            void listConversations().then(setSummaries).catch(() => {});
          } else if (ev.type === "citations") {
            patchMessage(assistantIdx, (m) => ({ ...m, sources: ev.sources ?? [] }));
            setPhaseSources(ev.sources?.length ?? 0);
            setPhase("reading");
          } else if (ev.type === "token") {
            setPhase((cur) => (cur === "writing" ? cur : "writing"));
            patchMessage(assistantIdx, (m) => ({ ...m, content: m.content + (ev.t ?? "") }));
          } else if (ev.type === "error") {
            patchMessage(assistantIdx, (m) => ({
              ...m,
              content: `${m.content}\n\n_[error: ${ev.error ?? "unknown"}]_`,
            }));
          }
        }
      }
      // After the stream finishes, refresh the sidebar ordering (updatedAt bumped server-side).
      if (serverConvId) void listConversations().then(setSummaries).catch(() => {});
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        patchMessage(assistantIdx, (m) => ({
          ...m,
          content: `${m.content}\n\n_[error: ${(e as Error).message}]_`,
        }));
      }
    } finally {
      setStreaming(false);
      setPhase(null);
      abortRef.current = null;
    }
  }

  async function promote(msg: StoredMessage, idx: number) {
    const ids = (msg.sources ?? []).map((s) => s.id);
    if (!ids.length) return;
    await promoteToDataset({ question: msg.question ?? "", answer: msg.content, citationIds: ids });
    patchMessage(idx, (m) => ({ ...m, promoted: true }));
  }

  async function report(msg: StoredMessage, idx: number) {
    const ids = (msg.sources ?? []).map((s) => s.id);
    if (!ids.length) return;
    await reportWrong(ids);
    patchMessage(idx, (m) => ({ ...m, reported: true }));
  }

  async function copy(text: string, idx: number) {
    await navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    window.setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1500);
  }

  function startNewChat() {
    abortRef.current?.abort();
    setActiveId(null);
    setInput("");
    setPanel(null);
    composerRef.current?.focus();
  }

  async function handleDeleteConversation(id: string) {
    await deleteConversationApi(id).catch(() => {});
    setSummaries((cs) => cs.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  }

  // Build the grouped list from server summaries (epochs for the recency buckets).
  const groupList = useMemo<Conversation[]>(
    () =>
      summaries.map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messages: [],
      })),
    [summaries],
  );
  const groups = useMemo(() => groupByRecency(groupList, Date.now()), [groupList]);

  return (
    <div className="bg-background text-foreground flex h-screen overflow-hidden">
      {/* Dismiss layer — only reachable on narrow viewports, where the sidebar overlays. */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
        />
      )}

      <aside
        className={cn(
          "border-sidebar-border bg-sidebar text-sidebar-foreground z-40 w-[264px] shrink-0 flex-col border-e",
          "max-md:fixed max-md:inset-y-0 max-md:start-0",
          sidebarOpen ? "flex" : "hidden",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-3">
          <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-7 items-center justify-center rounded-md text-sm font-bold">
            ✦
          </span>
          <span className="text-sm font-semibold">Arnfar</span>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setSidebarOpen(false)}
            title="Collapse sidebar"
            className="text-muted-foreground ms-auto"
          >
            <PanelLeft />
          </Button>
        </div>

        <div className="px-3 pb-2">
          <Button
            variant="outline"
            size="lg"
            onClick={startNewChat}
            className="w-full justify-start gap-2"
          >
            <Plus className="text-primary" />
            {t.newChat}
          </Button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {groups.length === 0 && (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t.empty}</p>
          )}
          {groups.map((group) => (
            <div key={group.label} className="mb-3">
              <p className="text-muted-foreground px-3 py-1.5 text-[0.7rem] font-medium">
                {group.label}
              </p>
              {group.items.map((c) => (
                <div
                  key={c.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-lg px-2 transition-colors",
                    c.id === activeId ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveId(c.id);
                      setPanel(null);
                      if (window.innerWidth < 768) setSidebarOpen(false);
                    }}
                    lang="lo"
                    title={c.title}
                    className="min-w-0 flex-1 truncate py-2 text-start text-sm"
                  >
                    {c.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteConversation(c.id)}
                    title="Delete"
                    className="text-muted-foreground hover:text-destructive rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </nav>

        <div className="border-sidebar-border flex items-center gap-1 border-t px-3 py-2.5">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={toggleTheme}
            title="Toggle theme"
            className="text-muted-foreground"
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setLang(lang === "lo" ? "en" : "lo")}
            className="text-muted-foreground"
          >
            {lang === "lo" ? "EN" : "ລາວ"}
          </Button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3">
          {!sidebarOpen && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setSidebarOpen(true)}
              title="Open sidebar"
              className="text-muted-foreground"
            >
              <PanelLeft />
            </Button>
          )}
          <span className="text-sm font-medium">Arnfar Chat</span>
          <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[0.7rem]">
            SEA-LION · {t.subtitle}
          </span>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-6">
            {messages.length === 0 ? (
              <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
                <span className="bg-primary text-primary-foreground mb-4 flex size-11 items-center justify-center rounded-xl text-lg">
                  ✦
                </span>
                <p lang="lo" className="text-xl font-semibold">
                  {t.greeting}
                </p>
                <p className="text-muted-foreground mt-1.5 text-sm">SEA-LION · {t.subtitle}</p>
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
                    <div className="text-[1.02rem]">
                      {msg.content ? (
                        renderMarkdown(msg.content, (n) => setPanel(msg.sources?.[n - 1] ?? null))
                      ) : streaming && i === messages.length - 1 ? (
                        <StreamProgress phase={phase ?? "searching"} sources={phaseSources} labels={t} />
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

                    {msg.content && !(streaming && i === messages.length - 1) && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => copy(msg.content, i)}
                          className="text-muted-foreground"
                        >
                          {copiedIdx === i ? <Check /> : <Copy />}
                          {t.copy}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={msg.promoted === true || (msg.sources ?? []).length === 0}
                          onClick={() => promote(msg, i)}
                          className={cn(
                            "text-muted-foreground",
                            msg.promoted && "text-primary disabled:opacity-100",
                          )}
                        >
                          {msg.promoted ? <Check /> : <Quote />}
                          {msg.promoted ? t.promoted : t.promote}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={msg.reported === true || (msg.sources ?? []).length === 0}
                          onClick={() => report(msg, i)}
                          className="text-muted-foreground"
                        >
                          {msg.reported ? <Check /> : <Flag />}
                          {msg.reported ? t.reported : t.report}
                        </Button>
                        {(msg.sources ?? []).length > 0 && (
                          <span className="text-muted-foreground ms-1 text-xs">
                            {t.sources}: {(msg.sources ?? []).length}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ),
              )
            )}
          </div>
        </div>

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
                // Grow with the text, then cap and scroll — a composer that swallows the
                // thread is worse than one that scrolls.
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
              }}
              onKeyDown={(e) => {
                // isComposing guards the IME: a Lao/keyboard candidate commit also fires
                // Enter, and sending mid-composition would truncate the word.
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
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
                className="h-7"
              >
                <option value="">all collections</option>
                {COLLECTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>

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

      {panel && (
        <aside className="border-border bg-card flex w-[380px] shrink-0 flex-col border-s max-lg:fixed max-lg:inset-y-0 max-lg:end-0 max-lg:z-40 max-lg:shadow-xl">
          <div className="border-border flex items-center gap-2 border-b px-4 py-3">
            <span className="bg-citation/15 text-citation flex size-5 items-center justify-center rounded text-xs font-semibold">
              {panel.n}
            </span>
            <span className="text-sm font-medium">{panel.kind}</span>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setPanel(null)}
              className="text-muted-foreground ms-auto"
            >
              <X />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            <p className="text-sm font-medium">{panel.title}</p>
            {panel.headingPath.length > 0 && (
              <p lang="lo" className="text-muted-foreground mt-1 text-xs">
                {panel.headingPath.join(" › ")}
              </p>
            )}
            <dl className="text-muted-foreground mt-2 space-y-0.5 text-xs">
              {panel.authority && (
                <div className="flex gap-1.5">
                  <dt>authority:</dt>
                  <dd className="text-foreground">{panel.authority}</dd>
                </div>
              )}
              {panel.effectiveDate && (
                <div className="flex gap-1.5">
                  <dt>effective:</dt>
                  <dd className="text-foreground">{panel.effectiveDate}</dd>
                </div>
              )}
            </dl>
            {/* The pristine `content` column, verbatim — never reflowed or normalised.
              * This pane is what a reviewer checks the answer against. */}
            <p
              lang="lo"
              className="border-border mt-3 border-t pt-3 text-[0.95rem] leading-[1.8] whitespace-pre-wrap"
            >
              {panel.content}
            </p>
          </div>
        </aside>
      )}
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

/**
 * A modern, phased progress indicator for a streaming answer. Mirrors the pipeline the
 * server actually runs — retrieve → read → generate — so the reader sees *what* is taking
 * time, not just *that* it is. Completed steps check off; the active step spins and shimmers.
 */
function StreamProgress({
  phase,
  sources,
  labels,
}: {
  phase: StreamPhase;
  sources: number;
  labels: (typeof UI)[Lang];
}) {
  const active = PHASE_ORDER.indexOf(phase);
  const text: Record<StreamPhase, string> = {
    searching: labels.phaseSearch,
    reading: sources > 0 ? `${labels.phaseRead} · ${sources}` : labels.phaseRead,
    writing: labels.phaseWrite,
  };
  const Icon: Record<StreamPhase, typeof Search> = {
    searching: Search,
    reading: BookOpen,
    writing: PenLine,
  };
  return (
    <div className="flex flex-col gap-2 py-1.5">
      {PHASE_ORDER.map((p, idx) => {
        const state = idx < active ? "done" : idx === active ? "active" : "pending";
        const StepIcon = Icon[p];
        return (
          <div
            key={p}
            className={cn(
              "flex items-center gap-2.5 text-sm transition-colors duration-300",
              state === "active"
                ? "text-foreground"
                : state === "done"
                  ? "text-muted-foreground"
                  : "text-muted-foreground/40",
            )}
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              {state === "active" ? (
                <Loader2 className="text-primary size-4 animate-spin" />
              ) : state === "done" ? (
                <Check className="text-primary size-4" />
              ) : (
                <StepIcon className="size-4" />
              )}
            </span>
            <span
              lang="lo"
              className={cn(
                state === "active" &&
                  "from-foreground via-muted-foreground to-foreground animate-shimmer bg-gradient-to-r bg-[length:200%_100%] bg-clip-text text-transparent",
              )}
            >
              {text[p]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

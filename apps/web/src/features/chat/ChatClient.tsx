"use client";

import { useRef, useState } from "react";

const BASE = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

interface Source {
  n: number;
  id: string;
  content: string;
  headingPath: string[];
  kind: string;
  title: string;
  authority: string | null;
  effectiveDate: string | null;
}
interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  question?: string; // for assistant: the question it answered
  promoted?: boolean;
  reported?: boolean;
}

const UI = {
  lo: { placeholder: "ຖາມຄຳຖາມບັນຊີ…", send: "ສົ່ງ", stop: "ຢຸດ", promote: "ເພີ່ມເຂົ້າ dataset", report: "ລາຍງານຜິດ", sources: "ແຫຼ່ງອ້າງອີງ" },
  en: { placeholder: "Ask an accounting question…", send: "Send", stop: "Stop", promote: "Promote to dataset", report: "Report wrong", sources: "Sources" },
};

function renderWithCitations(text: string, onCite: (n: number) => void) {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = /^\[(\d+)\]$/.exec(part);
    if (m) {
      const n = Number(m[1]);
      return (
        <sup
          key={i}
          onClick={() => onCite(n)}
          style={{ cursor: "pointer", color: "#2563eb", fontWeight: 700, padding: "0 2px" }}
          title="view source"
        >
          [{n}]
        </sup>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function ChatClient() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [lang, setLang] = useState<"lo" | "en">("lo");
  const [panel, setPanel] = useState<Source | null>(null);
  const [k, setK] = useState(8);
  const [collection, setCollection] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const t = UI[lang];

  async function send(question: string) {
    if (!question.trim() || streaming) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: question }]);
    const idx = messages.length + 1;
    setMessages((m) => [...m, { role: "assistant", content: "", sources: [], question }]);
    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(`${BASE}/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: question,
          k,
          ...(collection ? { collections: [collection] } : {}),
        }),
        signal: ctrl.signal,
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const ev = JSON.parse(line.slice(5).trim());
          // Pure update (no mutation): React StrictMode invokes updaters twice, so
          // mutating the message object would double every token.
          setMessages((m) =>
            m.map((msg, j) => {
              if (j !== idx) return msg;
              if (ev.type === "citations") return { ...msg, sources: ev.sources };
              if (ev.type === "token") return { ...msg, content: msg.content + ev.t };
              if (ev.type === "error") return { ...msg, content: `${msg.content}\n[error: ${ev.error}]` };
              return msg;
            }),
          );
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setMessages((m) => {
          const copy = [...m];
          if (copy[idx]) copy[idx]!.content += `\n[error: ${(e as Error).message}]`;
          return copy;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  async function promote(msg: Message, i: number) {
    const ids = (msg.sources ?? []).map((s) => s.id);
    if (!ids.length) return;
    await fetch(`${BASE}/chat/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: msg.question ?? "", answer: msg.content, citationIds: ids }),
    });
    setMessages((m) => m.map((x, j) => (j === i ? { ...x, promoted: true } : x)));
  }
  async function report(msg: Message, i: number) {
    const ids = (msg.sources ?? []).map((s) => s.id);
    if (!ids.length) return;
    await fetch(`${BASE}/chat/report-wrong`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chunkIds: ids }),
    });
    setMessages((m) => m.map((x, j) => (j === i ? { ...x, reported: true } : x)));
  }

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header style={{ display: "flex", gap: "0.75rem", alignItems: "center", padding: "0.6rem 1rem", borderBottom: "1px solid #e5e7eb" }}>
          <strong>Arnfar Chat</strong>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>SEA-LION · cited or abstains</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.8rem" }}>
            <label>k <input type="number" min={1} max={20} value={k} onChange={(e) => setK(Number(e.target.value))} style={{ width: 44 }} /></label>
            <select value={collection} onChange={(e) => setCollection(e.target.value)}>
              <option value="">all collections</option>
              {["lao-accounting-law", "coa", "tax", "sop", "lao-style"].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button onClick={() => setLang(lang === "lo" ? "en" : "lo")}>{lang === "lo" ? "EN" : "ລາວ"}</button>
          </div>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: "1rem" }}>
          {messages.length === 0 && <p style={{ color: "#9ca3af" }} lang="lo">ຖາມກ່ຽວກັບ ບັນຊີ, ໝວດບັນຊີ, ພາສີ…</p>}
          {messages.map((msg, i) => (
            <div key={i} style={{ marginBottom: "1rem", maxWidth: 760 }}>
              <div style={{ fontSize: "0.7rem", color: "#94a3b8" }}>{msg.role}</div>
              <div lang="lo" style={{ fontSize: "1.05rem", whiteSpace: "pre-wrap", background: msg.role === "user" ? "#eff6ff" : "transparent", padding: msg.role === "user" ? "0.4rem 0.6rem" : 0, borderRadius: 6 }}>
                {msg.role === "assistant" ? renderWithCitations(msg.content || "…", (n) => setPanel(msg.sources?.[n - 1] ?? null)) : msg.content}
              </div>
              {msg.role === "assistant" && msg.content && !streaming && (
                <div style={{ display: "flex", gap: "0.5rem", marginTop: 4, fontSize: "0.8rem" }}>
                  <button disabled={msg.promoted} onClick={() => promote(msg, i)}>{msg.promoted ? "✓ promoted" : t.promote}</button>
                  <button disabled={msg.reported} onClick={() => report(msg, i)}>{msg.reported ? "✓ reported" : t.report}</button>
                  {msg.sources && msg.sources.length > 0 && (
                    <span style={{ color: "#94a3b8" }}>{t.sources}: {msg.sources.length}</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); send(input); }}
          style={{ display: "flex", gap: "0.5rem", padding: "0.75rem 1rem", borderTop: "1px solid #e5e7eb" }}
        >
          <input lang="lo" value={input} onChange={(e) => setInput(e.target.value)} placeholder={t.placeholder} style={{ flex: 1, padding: "0.5rem", fontSize: "1rem" }} />
          {streaming ? (
            <button type="button" onClick={() => abortRef.current?.abort()}>{t.stop}</button>
          ) : (
            <button type="submit">{t.send}</button>
          )}
        </form>
      </div>

      {panel && (
        <aside style={{ width: 360, borderLeft: "1px solid #e5e7eb", padding: "1rem", overflowY: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>[{panel.n}] {panel.kind}</strong>
            <button onClick={() => setPanel(null)}>✕</button>
          </div>
          <div style={{ fontSize: "0.8rem", color: "#6b7280", margin: "0.5rem 0" }}>
            {panel.title}
            {panel.headingPath.length > 0 && <div lang="lo">{panel.headingPath.join(" › ")}</div>}
            {panel.authority && <div>authority: {panel.authority}</div>}
            {panel.effectiveDate && <div>effective: {panel.effectiveDate}</div>}
          </div>
          <pre lang="lo" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "0.95rem" }}>{panel.content}</pre>
        </aside>
      )}
    </div>
  );
}

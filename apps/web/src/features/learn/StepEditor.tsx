"use client";

import type { LessonStep } from "@arnfar/contracts";
import { Button } from "@arnfar/ui/components/button";
import { Input } from "@arnfar/ui/components/input";
import { Select } from "@arnfar/ui/components/select";
import { Textarea } from "@arnfar/ui/components/textarea";
import { cn } from "@arnfar/ui/lib/utils";
import { ChevronDown, ChevronUp, Loader2, Pencil, Trash2, X } from "lucide-react";
import { useCallback, useState } from "react";

import { deleteStep, moveStep, updateStep } from "./api";
import { Visual } from "./Visuals";

/**
 * Edit one lesson step in place.
 *
 * Collapsed by default: this list is a review queue, and a page of open textareas is a
 * form, not something you read. Reading is the common act and editing the exception, so
 * reading is what the default state serves.
 *
 * The visual is edited as JSON. A full builder for eight shapes is a large amount of UI
 * for a rare act — the drafter produces the visual, and a curator's realistic jobs are
 * "fix a number in it" or "this picture is wrong, remove it". Both are one textarea and a
 * Remove button, and the server validates against the same zod schema the renderer uses,
 * so a mistake comes back naming the field.
 */

const KINDS = ["intro", "concept", "example", "check", "recap"] as const;

const UI = {
  edit: "Edit",
  cancel: "Cancel",
  save: "Save",
  remove: "Delete step",
  moveUp: "Move up",
  moveDown: "Move down",
  kind: "Kind",
  titleLo: "Title (Lao)",
  bodyLo: "Body (Lao)",
  bodyEn: "Body (English)",
  visual: "Visual (JSON)",
  clearVisual: "Remove visual",
  cites: "cites",
  citeIds: "Citation chunk ids (comma separated)",
  checkNote: "A check step's question comes from the verified QA bank and is not edited here.",
  saving: "Saving…",
} as const;

export function StepEditor({
  step,
  isFirst,
  isLast,
  onChanged,
}: {
  step: LessonStep;
  isFirst: boolean;
  isLast: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<string>(step.kind);
  const [titleLo, setTitleLo] = useState(step.titleLo ?? "");
  const [bodyLo, setBodyLo] = useState(step.bodyLo ?? "");
  const [bodyEn, setBodyEn] = useState(step.bodyEn ?? "");
  const [cites, setCites] = useState(step.citationIds.join(", "));
  const [visualText, setVisualText] = useState(
    step.visual ? JSON.stringify(step.visual, null, 2) : "",
  );

  const reset = useCallback(() => {
    setKind(step.kind);
    setTitleLo(step.titleLo ?? "");
    setBodyLo(step.bodyLo ?? "");
    setBodyEn(step.bodyEn ?? "");
    setCites(step.citationIds.join(", "));
    setVisualText(step.visual ? JSON.stringify(step.visual, null, 2) : "");
    setError(null);
  }, [step]);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await onChanged();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const save = useCallback(async () => {
    // The visual is parsed here only to catch malformed JSON early with a clearer message
    // than the server's. Its SHAPE is still the server's call — the zod schema there is the
    // same one the renderer trusts, so there is exactly one authority on what is valid.
    let visual: unknown;
    const raw = visualText.trim();
    if (raw === "") {
      visual = null;
    } else {
      try {
        visual = JSON.parse(raw);
      } catch {
        setError("The visual is not valid JSON.");
        return;
      }
    }

    const ok = await run(() =>
      updateStep(step.id, {
        kind,
        titleLo: titleLo.trim() || null,
        bodyLo: bodyLo.trim() || null,
        bodyEn: bodyEn.trim() || null,
        visual,
        citationIds: cites
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
      }),
    );
    if (ok) setOpen(false);
  }, [run, step.id, kind, titleLo, bodyLo, bodyEn, cites, visualText]);

  if (!open) {
    return (
      <div className="border-border/60 group mb-4 border-s-2 ps-3 last:mb-0">
        <div className="text-muted-foreground mb-1 flex items-center gap-2 text-[0.65rem] font-medium tracking-wide uppercase">
          <span>
            {step.seq + 1}. {step.kind}
          </span>
          <span className="tabular-nums">
            {step.citationIds.length} {UI.cites}
          </span>
          <div className="flex-1" />
          <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={isFirst || busy}
              onClick={() => void run(() => moveStep(step.id, "up"))}
              title={UI.moveUp}
              aria-label={UI.moveUp}
            >
              <ChevronUp />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={isLast || busy}
              onClick={() => void run(() => moveStep(step.id, "down"))}
              title={UI.moveDown}
              aria-label={UI.moveDown}
            >
              <ChevronDown />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                reset();
                setOpen(true);
              }}
              title={UI.edit}
              aria-label={UI.edit}
            >
              <Pencil />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => deleteStep(step.id))}
              title={UI.remove}
              aria-label={UI.remove}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
        {step.titleLo && (
          <div lang="lo" className="text-sm font-medium">
            {step.titleLo}
          </div>
        )}
        {step.bodyLo && (
          <p lang="lo" className="mt-0.5 text-sm leading-relaxed whitespace-pre-wrap">
            {step.bodyLo}
          </p>
        )}
        {step.bodyEn && (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed whitespace-pre-wrap">
            {step.bodyEn}
          </p>
        )}
        {step.visual && <Visual spec={step.visual} />}
        {error && <p className="text-destructive mt-1 text-xs">{error}</p>}
      </div>
    );
  }

  return (
    <div className="border-primary/40 bg-card/60 mb-4 rounded-e-lg border-s-2 p-3 last:mb-0">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted-foreground text-[0.65rem] font-medium tracking-wide uppercase">
          {step.seq + 1}
        </span>
        <Select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="h-7 w-32"
          title={UI.kind}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          aria-label={UI.cancel}
        >
          <X />
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <Input
          value={titleLo}
          onChange={(e) => setTitleLo(e.target.value)}
          placeholder={UI.titleLo}
          lang="lo"
          className="h-8"
        />
        <Textarea
          value={bodyLo}
          onChange={(e) => setBodyLo(e.target.value)}
          placeholder={UI.bodyLo}
          lang="lo"
          rows={4}
        />
        <Textarea
          value={bodyEn}
          onChange={(e) => setBodyEn(e.target.value)}
          placeholder={UI.bodyEn}
          rows={3}
        />

        {kind === "check" ? (
          <p className="text-muted-foreground text-xs">{UI.checkNote}</p>
        ) : (
          <Input
            value={cites}
            onChange={(e) => setCites(e.target.value)}
            placeholder={UI.citeIds}
            className="h-8 font-mono text-xs"
          />
        )}

        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-muted-foreground text-[0.65rem] font-medium tracking-wide uppercase">
              {UI.visual}
            </span>
            {visualText.trim() !== "" && (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground h-5"
                onClick={() => setVisualText("")}
              >
                {UI.clearVisual}
              </Button>
            )}
          </div>
          <Textarea
            value={visualText}
            onChange={(e) => setVisualText(e.target.value)}
            rows={visualText ? 8 : 2}
            className="font-mono text-xs"
            spellCheck={false}
          />
        </div>
      </div>

      {error && <p className="text-destructive mt-2 text-xs">{error}</p>}

      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {busy ? UI.saving : UI.save}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={busy}
          className={cn("text-muted-foreground")}
        >
          {UI.cancel}
        </Button>
      </div>
    </div>
  );
}

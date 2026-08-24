/**
 * Route-level loading state. Every Studio page fetches from rag-api on mount, and a local
 * Ollama box is not always fast — without this the browser shows the previous route until
 * the new one is ready, which reads as a dead click.
 */
export default function Loading() {
  return (
    <output className="flex min-h-[60vh] items-center justify-center" aria-live="polite">
      <span className="sr-only">Loading</span>
      <span className="flex gap-1.5" aria-hidden="true">
        {["0ms", "150ms", "300ms"].map((delay) => (
          <span
            key={delay}
            className="bg-muted-foreground/60 size-2 animate-bounce rounded-full"
            style={{ animationDelay: delay }}
          />
        ))}
      </span>
    </output>
  );
}

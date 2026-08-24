"use client";

import { Button } from "@arnfar/ui/components/button";
import { useEffect } from "react";

/**
 * Root error boundary.
 *
 * Without this file a render error in a production build shows Next's bare "Application
 * error: a client-side exception has occurred" with no way back — the dev overlay that
 * makes this survivable locally does not ship. The Studio is a long-session tool, so the
 * recovery that matters is retrying in place rather than losing the page.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server-side digest is the only handle on the real stack in a production build.
    console.error("[arnfar] render error", { digest: error.digest, message: error.message });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <div className="glass glass-blur-lg rounded-3xl p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Something broke on this page</h1>
        <p lang="lo" className="mt-1.5 text-lg">
          ໜ້ານີ້ມີບັນຫາ
        </p>
        <p className="text-muted-foreground mt-4 text-sm">
          Nothing you were working on was sent anywhere. Try again — if it keeps happening, the API
          log has the detail.
        </p>
        {error.digest && (
          <p className="text-muted-foreground mt-3 text-xs">
            Reference <code className="glass-field rounded-md px-1.5 py-0.5">{error.digest}</code>
          </p>
        )}
        <div className="mt-6 flex gap-2">
          <Button onClick={reset} className="rounded-full px-5">
            Try again
          </Button>
          <Button
            variant="glass"
            onClick={() => {
              window.location.href = "/";
            }}
            className="rounded-full px-5"
          >
            Go home
          </Button>
        </div>
      </div>
    </main>
  );
}

import { buttonVariants } from "@arnfar/ui/components/button";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <div className="glass glass-blur-lg rounded-3xl p-8">
        <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">No such page</h1>
        <p lang="lo" className="mt-1.5 text-lg">
          ບໍ່ພົບໜ້ານີ້
        </p>
        <div className="mt-6 flex gap-2">
          <Link href="/chat" className={buttonVariants({ className: "rounded-full px-5" })}>
            Open chat
          </Link>
          <Link
            href="/studio"
            className={buttonVariants({ variant: "glass", className: "rounded-full px-5" })}
          >
            Studio
          </Link>
        </div>
      </div>
    </main>
  );
}

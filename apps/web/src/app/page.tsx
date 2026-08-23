import Link from "next/link";

import { buttonVariants } from "@arnfar/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@arnfar/ui/components/card";

const RAG_API_URL = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <div className="glass glass-blur-lg rounded-3xl p-8 sm:p-10">
        <span className="bg-primary text-primary-foreground shadow-primary/30 mb-5 flex size-12 items-center justify-center rounded-2xl text-lg shadow-xl">
          ✦
        </span>
        <h1 className="text-4xl font-semibold tracking-tight">Arnfar AI</h1>
        <p className="text-muted-foreground mt-1.5">
          Lao Accounting RAG + Dataset Platform — local-first, offline-capable.
        </p>
        <p lang="lo" className="mt-4 text-xl leading-[1.7]">
          ຜູ້ຊ່ວຍ AI ບັນຊີພາສາລາວ — ອອບໄລນ໌, ອ້າງອີງແຫຼ່ງທຸກຄຳຕອບ.
        </p>

        <div className="mt-7 flex gap-2">
          <Link href="/chat" className={buttonVariants({ size: "lg", className: "rounded-full px-5" })}>
            Open chat
          </Link>
          <Link
            href="/studio/review"
            className={buttonVariants({ variant: "glass", size: "lg", className: "rounded-full px-5" })}
          >
            Studio
          </Link>
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">The platform</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <ul className="grid gap-1.5">
            <li>
              <span className="text-foreground font-medium">Studio</span> — ingest → review →
              QA/glossary → eval → export (the dataset factory)
            </li>
            <li>
              <span className="text-foreground font-medium">Chat</span> — cited Lao accounting
              answers (SEA-LION), cite-or-abstain
            </li>
            <li>
              API:{" "}
              <code className="glass-field rounded-md px-1.5 py-0.5">{RAG_API_URL}</code>{" "}
              <span className="text-muted-foreground">(browser talks only to rag-api)</span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}

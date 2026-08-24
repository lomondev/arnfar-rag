import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Transpile the workspace packages consumed as source (TS, no build step).
  transpilePackages: ["@arnfar/ui", "@arnfar/contracts"],
  // The browser talks ONLY to rag-api (CLAUDE.md). No Ollama/sidecar access from here.
  //
  // NEXT_PUBLIC_RAG_API_URL is passed through EMPTY when unset, deliberately. Baking a
  // `http://localhost:7730` default here would compile "the browser's own machine" into
  // the bundle for every visitor, which is why the site only ever worked on the host.
  // Left empty, src/lib/api.ts derives the address from the page the visitor loaded.
  // Set it explicitly for a deployment behind a hostname or reverse proxy.
  env: {
    NEXT_PUBLIC_RAG_API_URL: process.env.NEXT_PUBLIC_RAG_API_URL ?? "",
    NEXT_PUBLIC_RAG_API_PORT: process.env.RAG_API_PORT ?? "7730",
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Transpile the workspace packages consumed as source (TS, no build step).
  transpilePackages: ["@arnfar/ui", "@arnfar/contracts"],
  // The browser talks ONLY to rag-api (CLAUDE.md). No Ollama/sidecar access from here.
  env: {
    NEXT_PUBLIC_RAG_API_URL: process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730",
  },
};

export default nextConfig;

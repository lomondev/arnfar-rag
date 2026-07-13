const RAG_API_URL = process.env.NEXT_PUBLIC_RAG_API_URL ?? "http://localhost:7730";

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "3rem 1.5rem" }}>
      <h1 style={{ marginBottom: "0.25rem" }}>Arnfar AI</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        Lao Accounting RAG + Dataset Platform — local-first, offline-capable.
      </p>

      <p lang="lo" style={{ fontSize: "1.25rem" }}>
        ຜູ້ຊ່ວຍ AI ບັນຊີພາສາລາວ — ອອບໄລນ໌, ອ້າງອີງແຫຼ່ງທຸກຄຳຕອບ.
      </p>

      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1rem" }}>Scaffold — Phase 0</h2>
        <ul style={{ lineHeight: 1.8 }}>
          <li>Studio (ingest → review → qa → glossary → eval → export): coming Phase 3+</li>
          <li>Chat (cited Lao answers): coming Phase 7</li>
          <li>
            API endpoint: <code>{RAG_API_URL}</code> (browser talks only to rag-api)
          </li>
        </ul>
      </section>
    </main>
  );
}

/**
 * Domain registry — the modular-RAG backbone from ERP-RAG-VISION.md.
 *
 * Each ERP module gets its own RAG domain: its own collections, retrieval
 * parameters, tool set, allowed roles, and prompt preamble. Phase 1 activates
 * only `accounting`; the rest are registered as `planned` so the orchestrator,
 * routes, and UI can enumerate the roadmap without being able to query into
 * an empty domain by accident.
 *
 * Adding a domain later = flip status to active, point it at its collections,
 * and (if needed) give it domain-specific tools. No orchestrator changes.
 */

export interface RetrievalConfig {
  /** top-k hits fed to the generator */
  k: number;
}

export interface DomainConfig {
  key: string;
  nameEn: string;
  nameLo: string;
  status: "active" | "planned";
  /** rag_chunk collections this domain retrieves over (empty for planned domains) */
  collections: string[];
  retrieval: RetrievalConfig;
  /** tool keys from features/tools this domain's agent may invoke */
  tools: string[];
  /** persona keys from domains/roles.ts this domain supports */
  roles: string[];
  /** domain-specific system-prompt preamble, prepended to the shared rules */
  systemPreamble: string;
}

const planned = (key: string, nameEn: string, nameLo: string): DomainConfig => ({
  key,
  nameEn,
  nameLo,
  status: "planned",
  collections: [],
  retrieval: { k: 8 },
  tools: [],
  roles: [],
  systemPreamble: "",
});

const DOMAINS: DomainConfig[] = [
  {
    key: "accounting",
    nameEn: "Accounting (Laos + international)",
    nameLo: "ການບັນຊີ",
    status: "active",
    // Everything ingested today belongs to the accounting domain.
    collections: ["lao-accounting-law", "coa", "tax", "sop", "lao-style"],
    retrieval: { k: 8 },
    tools: ["coa_search", "glossary_lookup", "vat_calc", "doc_search"],
    roles: [
      "accountant",
      "auditor",
      "financial_consultant",
      "erp_consultant",
      "bookkeeper",
      "cfo_assistant",
      "tax_advisor",
      "financial_analyst",
    ],
    systemPreamble:
      "Domain: Lao accounting, chart of accounts, Lao tax and VAT regulation, " +
      "and accounting procedure. Prefer Lao Ministry of Finance sources over " +
      "general knowledge; when Lao and international treatment differ, present " +
      "the Lao treatment first and label the international one explicitly.",
  },
  // ── Roadmap (ERP-RAG-VISION.md) — registered, not yet queryable ──────────────
  planned("lao-tax", "Lao Tax", "ອາກອນລາວ"),
  planned("ifrs", "International Accounting Standards (IFRS/IAS)", "ມາດຕະຖານບັນຊີສາກົນ"),
  planned("financial-reporting", "Financial Reporting", "ການລາຍງານການເງິນ"),
  planned("inventory", "Inventory Management", "ການຄຸ້ມຄອງສາງ"),
  planned("pos", "POS", "ລະບົບຂາຍໜ້າຮ້ານ"),
  planned("purchasing", "Purchasing", "ການຈັດຊື້"),
  planned("sales", "Sales", "ການຂາຍ"),
  planned("crm", "CRM", "ການຄຸ້ມຄອງລູກຄ້າ"),
  planned("payroll", "Payroll", "ເງິນເດືອນ"),
  planned("hr", "Human Resources", "ຊັບພະຍາກອນມະນຸດ"),
  planned("fixed-assets", "Fixed Asset Management", "ຊັບສິນຄົງທີ່"),
  planned("banking", "Banking", "ທະນາຄານ"),
  planned("treasury", "Treasury", "ຄັງເງິນ"),
  planned("manufacturing", "Manufacturing", "ການຜະລິດ"),
  planned("projects", "Project Management", "ການຄຸ້ມຄອງໂຄງການ"),
  planned("hotel", "Hotel Management", "ການຄຸ້ມຄອງໂຮງແຮມ"),
  planned("restaurant", "Restaurant Management", "ການຄຸ້ມຄອງຮ້ານອາຫານ"),
  planned("dms", "Document Management", "ການຄຸ້ມຄອງເອກະສານ"),
  planned("bi", "Business Intelligence", "ຂໍ້ມູນທຸລະກິດ"),
  planned("sysadmin", "System Administration", "ການບໍລິຫານລະບົບ"),
];

const byKey = new Map(DOMAINS.map((d) => [d.key, d]));

export function listDomains(): DomainConfig[] {
  return DOMAINS;
}

/** Resolve a domain key; undefined key falls back to the Phase-1 default. */
export function getDomain(key?: string): DomainConfig | null {
  if (!key) return byKey.get("accounting") ?? null;
  return byKey.get(key) ?? null;
}

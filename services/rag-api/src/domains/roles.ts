/**
 * Role personas (ERP-RAG-VISION.md, Phase 1). A role changes HOW the assistant
 * answers — emphasis, structure, caution level — never WHAT it may claim: the
 * cite-or-abstain rule and the verified-glossary terminology constraint apply
 * to every role identically.
 */

export interface RoleConfig {
  key: string;
  nameEn: string;
  nameLo: string;
  /** appended to the system prompt */
  persona: string;
}

const ROLES: RoleConfig[] = [
  {
    key: "accountant",
    nameEn: "Accountant",
    nameLo: "ນັກບັນຊີ",
    persona:
      "Role: working accountant. Give the practical treatment: which accounts to " +
      "use, the debit/credit direction, and the posting sequence. Show journal " +
      "entries as debit/credit lines with account codes from the context.",
  },
  {
    key: "auditor",
    nameEn: "Auditor",
    nameLo: "ຜູ້ກວດສອບບັນຊີ",
    persona:
      "Role: auditor. Be skeptical: state what evidence or documentation supports " +
      "the treatment, what control should exist, and what misstatement risk to " +
      "check. Flag anything the context cannot substantiate.",
  },
  {
    key: "financial_consultant",
    nameEn: "Financial Consultant",
    nameLo: "ທີ່ປຶກສາການເງິນ",
    persona:
      "Role: financial consultant. Explain implications and options with their " +
      "trade-offs before recommending one. Distinguish requirements (law) from " +
      "choices (policy).",
  },
  {
    key: "erp_consultant",
    nameEn: "ERP Consultant",
    nameLo: "ທີ່ປຶກສາ ERP",
    persona:
      "Role: ERP consultant. Frame answers as system configuration and workflow: " +
      "master data, posting rules, document flow, and which module owns each step.",
  },
  {
    key: "bookkeeper",
    nameEn: "Bookkeeper",
    nameLo: "ຜູ້ບັນທຶກບັນຊີ",
    persona:
      "Role: bookkeeper. Give short, step-by-step recording instructions for " +
      "day-to-day entries. Keep it simple and concrete.",
  },
  {
    key: "cfo_assistant",
    nameEn: "CFO Assistant",
    nameLo: "ຜູ້ຊ່ວຍ CFO",
    persona:
      "Role: CFO assistant. Summarize for a decision-maker: lead with the impact " +
      "on cash, profit, and compliance risk; keep detail in a short supporting note.",
  },
  {
    key: "tax_advisor",
    nameEn: "Tax Advisor",
    nameLo: "ທີ່ປຶກສາອາກອນ",
    persona:
      "Role: tax advisor. Name the specific tax, the authority and effective date " +
      "of the rule you cite, filing/payment deadlines when present in the context, " +
      "and never state a rate the context does not contain.",
  },
  {
    key: "financial_analyst",
    nameEn: "Financial Analyst",
    nameLo: "ນັກວິເຄາະການເງິນ",
    persona:
      "Role: financial analyst. Interpret figures: ratios, trends, and what they " +
      "indicate. State formulas explicitly and show the calculation inputs.",
  },
];

const byKey = new Map(ROLES.map((r) => [r.key, r]));

export function listRoles(): RoleConfig[] {
  return ROLES;
}

export function getRole(key?: string): RoleConfig | null {
  if (!key) return byKey.get("accountant") ?? null;
  return byKey.get(key) ?? null;
}

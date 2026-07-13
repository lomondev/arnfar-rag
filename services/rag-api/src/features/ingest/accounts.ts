/** Infer account attributes from the code's leading digit — a common CoA
 *  convention (1=asset, 2=liability, 3=equity, 4=revenue, 5/6=expense). This is a
 *  HEURISTIC: every inferred row is verified=false and must be human-confirmed.
 *  normal_balance/statement/account_class are NOT NULL + CHECK-constrained, so we
 *  need valid values even for a draft. */

const LAO_DIGITS: Record<string, string> = {
  "໐": "0",
  "໑": "1",
  "໒": "2",
  "໓": "3",
  "໔": "4",
  "໕": "5",
  "໖": "6",
  "໗": "7",
  "໘": "8",
  "໙": "9",
};

export interface AccountAttrs {
  accountClass: string;
  normalBalance: "debit" | "credit";
  statement: "BS" | "PL" | "CF" | "NONE";
}

const BY_LEAD: Record<string, AccountAttrs> = {
  "1": { accountClass: "asset", normalBalance: "debit", statement: "BS" },
  "2": { accountClass: "liability", normalBalance: "credit", statement: "BS" },
  "3": { accountClass: "equity", normalBalance: "credit", statement: "BS" },
  "4": { accountClass: "revenue", normalBalance: "credit", statement: "PL" },
  "5": { accountClass: "expense", normalBalance: "debit", statement: "PL" },
  "6": { accountClass: "expense", normalBalance: "debit", statement: "PL" },
};

export function inferAccountAttrs(code: string): AccountAttrs {
  const first = code.trim()[0] ?? "";
  const lead = LAO_DIGITS[first] ?? first;
  return BY_LEAD[lead] ?? { accountClass: "asset", normalBalance: "debit", statement: "BS" };
}

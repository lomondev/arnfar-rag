"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@arnfar/ui/components/badge";
import { Button } from "@arnfar/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@arnfar/ui/components/dialog";
import { Input } from "@arnfar/ui/components/input";
import { Label } from "@arnfar/ui/components/label";
import { Select } from "@arnfar/ui/components/select";

import {
  createAccount,
  deleteAccount,
  fetchAccounts,
  updateAccount,
  verifyAccount,
  type Account,
} from "./api";

const CLASSES = ["asset", "liability", "equity", "revenue", "expense"] as const;
const BALANCES = ["debit", "credit"] as const;
const STATEMENTS = ["BS", "PL", "CF", "NONE"] as const;

function AccountFormDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: Account | null;
  onSaved: (msg: string) => void;
}) {
  const [code, setCode] = useState(initial?.code ?? "");
  const [nameLo, setNameLo] = useState(initial?.nameLo ?? "");
  const [nameEn, setNameEn] = useState(initial?.nameEn ?? "");
  const [parentCode, setParentCode] = useState(initial?.parentCode ?? "");
  const [accountClass, setAccountClass] = useState(initial?.accountClass ?? "asset");
  const [normalBalance, setNormalBalance] = useState(initial?.normalBalance ?? "debit");
  const [statement, setStatement] = useState(initial?.statement ?? "BS");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const body = {
        code: code.trim(),
        nameLo: nameLo.trim(),
        nameEn: nameEn.trim(),
        parentCode: parentCode.trim(),
        accountClass,
        normalBalance,
        statement,
      };
      if (initial) {
        await updateAccount(initial.id, body);
        onSaved(`updated ${body.code} (re-verify)`);
      } else {
        await createAccount(body);
        onSaved(`added ${body.code}`);
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? `Edit account ${initial.code}` : "Add account"}</DialogTitle>
          <DialogDescription>
            {initial
              ? "Editing resets verification — a human must re-confirm the row."
              : "Extraction proposes; a person disposes. New rows start unverified."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="acc-code">Code</Label>
              <Input id="acc-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="1010" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="acc-parent">Parent code (optional)</Label>
              <Input id="acc-parent" value={parentCode} onChange={(e) => setParentCode(e.target.value)} placeholder="10" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="acc-name-lo">Name (Lao)</Label>
            <Input id="acc-name-lo" lang="lo" className="text-base" value={nameLo} onChange={(e) => setNameLo(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="acc-name-en">Name (English, optional)</Label>
            <Input id="acc-name-en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="acc-class">Class</Label>
              <Select id="acc-class" value={accountClass} onChange={(e) => setAccountClass(e.target.value)}>
                {CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="acc-balance">Normal balance</Label>
              <Select id="acc-balance" value={normalBalance} onChange={(e) => setNormalBalance(e.target.value)}>
                {BALANCES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="acc-statement">Statement</Label>
              <Select id="acc-statement" value={statement} onChange={(e) => setStatement(e.target.value)}>
                {STATEMENTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !code.trim() || !nameLo.trim()}>
            {saving ? "Saving…" : initial ? "Save changes" : "Add account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AccountsClient() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [status, setStatus] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);

  const load = useCallback(() => {
    fetchAccounts().then(setAccounts).catch((e) => setStatus(`error: ${e.message}`));
  }, []);
  useEffect(load, [load]);

  const verifiedCount = accounts.filter((a) => a.verified).length;

  return (
    <main className="px-6 py-5">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-lg font-semibold">Chart of accounts</h2>
        <span className="text-muted-foreground text-sm">
          {verifiedCount}/{accounts.length} verified
        </span>
        <Button
          className="ml-auto"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          Add account
        </Button>
        <span className="text-muted-foreground text-sm">{status}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-b text-left">
            <tr>
              <th className="p-2 font-medium">code</th>
              <th className="p-2 font-medium">name_lo</th>
              <th className="p-2 font-medium">name_en</th>
              <th className="p-2 font-medium">class</th>
              <th className="p-2 font-medium">balance</th>
              <th className="p-2 font-medium">stmt</th>
              <th className="p-2 font-medium">status</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="hover:bg-muted/40 border-b last:border-0">
                <td className="p-2 font-mono">{a.code}</td>
                <td lang="lo" className="p-2 text-base">
                  {a.nameLo}
                </td>
                <td className="text-muted-foreground p-2">{a.nameEn ?? "—"}</td>
                <td className="p-2">{a.accountClass}</td>
                <td className="p-2">{a.normalBalance}</td>
                <td className="p-2">{a.statement}</td>
                <td className="p-2">
                  {a.verified ? (
                    <Badge variant="secondary">● verified</Badge>
                  ) : (
                    <Badge variant="muted">○ draft</Badge>
                  )}
                </td>
                <td className="p-2">
                  <span className="flex items-center gap-1.5">
                    {!a.verified && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          await verifyAccount(a.id);
                          setStatus(`verified ${a.code}`);
                          load();
                        }}
                      >
                        Verify
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(a);
                        setFormOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => setDeleting(a)}>
                      Delete
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {accounts.length === 0 && (
          <p className="text-muted-foreground p-6 text-center text-sm">
            No accounts yet — add one manually, or ingest a chart-of-accounts document.
          </p>
        )}
      </div>

      {formOpen && (
        <AccountFormDialog
          key={editing?.id ?? "new"}
          open={formOpen}
          onOpenChange={setFormOpen}
          initial={editing}
          onSaved={(msg) => {
            setStatus(msg);
            load();
          }}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete account {deleting?.code}?</DialogTitle>
            <DialogDescription lang="lo">{deleting?.nameLo}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!deleting) return;
                try {
                  await deleteAccount(deleting.id);
                  setStatus(`deleted ${deleting.code}`);
                } catch (e) {
                  setStatus(`error: ${e instanceof Error ? e.message : e}`);
                }
                setDeleting(null);
                load();
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

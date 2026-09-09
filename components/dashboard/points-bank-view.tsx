"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, Landmark, RefreshCw, Save, Square, TrendingDown, TrendingUp, UsersRound, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { StreamlabsConfig, StreamlabsState } from "@/lib/automation/streamlabs-controller";

type Account = { id: string; displayName: string; channelName?: string | null; status: string };
type Notify = (kind: "success" | "error", text: string) => void;

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/streamlabs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Points Bank action failed.");
  return result;
}

export function PointsBankView({ state, accounts, refresh, onToast }: { state: StreamlabsState | null; accounts: Account[]; refresh: () => Promise<void>; onToast: Notify }) {
  const [form, setForm] = useState<StreamlabsConfig | null>(state?.config ?? null);
  const [fromAccountId, setFromAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [amount, setAmount] = useState(100);
  const [busy, setBusy] = useState(false);
  const hydrated = useRef(false);
  useEffect(() => { if (state && !hydrated.current) { hydrated.current = true; setForm(state.config); } }, [state]);
  const connected = useMemo(() => accounts.filter(account => account.status === "CONNECTED" && account.channelName?.startsWith("@")), [accounts]);
  const selected = useMemo(() => connected.filter(account => form?.accountIds.includes(account.id)), [connected, form?.accountIds]);
  useEffect(() => {
    if (!selected.length) return;
    setFromAccountId(value => selected.some(account => account.id === value) ? value : selected[0].id);
    setToAccountId(value => selected.some(account => account.id === value && account.id !== fromAccountId) ? value : selected.find(account => account.id !== fromAccountId)?.id ?? "");
  }, [selected, fromAccountId]);
  if (!state || !form) return <div className="loading-grid">{Array.from({ length: 5 }).map((_, index) => <div className="skeleton" key={index}/>)}</div>;

  const intelligence = state.intelligence;
  const operationBusy = !["IDLE", "ERROR", "PAUSED_FOR_HEIST"].includes(intelligence.phase);
  const editable = !state.enabled && !operationBusy;
  const verified = selected.map(account => intelligence.balances[account.id]).filter(Boolean);
  const totalPoints = verified.reduce((total, item) => total + item.balance, 0);
  const bankBalance = form.bankAccountId ? intelligence.balances[form.bankAccountId]?.balance : undefined;
  const heistNet = intelligence.recentHeists.reduce((total, heist) => total + heist.totalNet, 0);
  const outcomes = intelligence.recentHeists.flatMap(heist => heist.participants);
  const wins = outcomes.filter(item => item.outcome === "WON").length;
  const losses = outcomes.filter(item => item.outcome === "LOST").length;
  const accountNet = new Map(connected.map(account => [account.id, intelligence.recentHeists.reduce((total, heist) => total + (heist.participants.find(item => item.accountId === account.id)?.net ?? 0), 0)]));

  const run = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    try { await post(body); onToast("success", success); await refresh(); }
    catch (error) { onToast("error", error instanceof Error ? error.message : "Points Bank action failed."); }
    finally { setBusy(false); }
  };
  const toggleAccount = (id: string) => setForm(value => value ? ({ ...value, accountIds: value.accountIds.includes(id) ? value.accountIds.filter(item => item !== id) : [...value.accountIds, id] }) : value);

  return <div className="content-stack points-bank">
    <section className="page-action-row"><div><span className="eyebrow">STREAMLABS POINTS CONTROL</span><h1>Points Bank</h1><p>Verified balances, reserve-aware consolidation, transfers, and heist performance.</p></div><div className="points-page-actions"><Button variant="secondary" disabled={busy || operationBusy || !selected.length} onClick={() => run({ action: "check-points" }, "Balance inquiry started.")}><RefreshCw size={16}/>Inquire all balances</Button>{operationBusy && <Button variant="danger" disabled={busy} onClick={() => run({ action: "cancel-points" }, "Points operation stopped.")}><Square size={15}/>Stop operation</Button>}</div></section>
    <section className="metrics-grid"><BankMetric label="Tracked accounts" value={selected.length} hint={`${connected.length} connected handles`} icon={UsersRound} tone="blue"/><BankMetric label="Verified total" value={totalPoints.toLocaleString()} hint={`${verified.length} of ${selected.length} balances verified`} icon={WalletCards} tone="purple"/><BankMetric label="Bank balance" value={bankBalance?.toLocaleString() ?? "Unknown"} hint={selected.find(account => account.id === form.bankAccountId)?.channelName ?? "Choose a bank account"} icon={Landmark} tone="green"/><BankMetric label="Heist profit / loss" value={heistNet.toLocaleString()} hint={`${wins} wins · ${losses} losses`} icon={heistNet >= 0 ? TrendingUp : TrendingDown} tone={heistNet >= 0 ? "green" : "red"}/><BankMetric label="Transfers" value={intelligence.transfers.length} hint={`${intelligence.transfers.filter(item => item.status === "CONFIRMED").length} confirmed`} icon={ArrowRightLeft} tone="amber"/></section>

    <div className="points-bank-grid"><Card><CardHeader className="section-heading"><div><h2>Account balances</h2><p>Handles come directly from connected YouTube profiles.</p></div><span className="badge">{intelligence.phase.replaceAll("_", " ")}</span></CardHeader><div className="table-scroll"><table className="points-table"><thead><tr><th>Include</th><th>Account</th><th>Current points</th><th>Heist P/L</th><th>Verified</th></tr></thead><tbody>{connected.map(account => { const balance = intelligence.balances[account.id], net = accountNet.get(account.id) ?? 0; return <tr key={account.id}><td><input type="checkbox" disabled={!editable} checked={form.accountIds.includes(account.id)} onChange={() => toggleAccount(account.id)}/></td><td><b>{account.displayName}</b><small>{account.channelName}</small></td><td><strong>{balance ? balance.balance.toLocaleString() : "Unknown"}</strong></td><td className={net < 0 ? "streamlabs-error" : "points-positive"}>{net > 0 ? "+" : ""}{net.toLocaleString()}</td><td><small>{balance ? new Date(balance.verifiedAt).toLocaleString() : "Never"}</small></td></tr>; })}</tbody></table></div></Card>

      <div className="points-bank-side"><Card><CardHeader><div><h2>Bank configuration</h2><p>Accumulate points while keeping a reserve in every donor.</p></div></CardHeader><CardContent className="settings-fields"><label className="field"><span>Destination bank account</span><select disabled={!editable} value={form.bankAccountId ?? ""} onChange={event => setForm({ ...form, bankAccountId: event.target.value || null })}><option value="">Choose bank account</option>{selected.map(account => <option value={account.id} key={account.id}>{account.displayName} — {account.channelName}</option>)}</select></label><div className="streamlabs-number-grid"><NumberField label="Reserve in each account" value={form.protectedReserve} disabled={!editable} onChange={value => setForm({ ...form, protectedReserve: value })}/><NumberField label="Minimum transfer" value={form.minimumTransfer} min={1} disabled={!editable} onChange={value => setForm({ ...form, minimumTransfer: value })}/></div><div className="streamlabs-number-grid"><NumberField label="Maximum per transfer" value={form.maximumTransfer} min={1} disabled={!editable} onChange={value => setForm({ ...form, maximumTransfer: value })}/><NumberField label="Heist wager" value={form.heistWager} min={1} disabled={!editable} onChange={value => setForm({ ...form, heistWager: value })}/></div><div className="streamlabs-number-grid"><label className="field"><span>Presence message</span><input disabled={!editable} maxLength={200} value={form.bankPresenceMessage} onChange={event => setForm({ ...form, bankPresenceMessage: event.target.value })}/></label><NumberField label="Response timeout" value={form.responseTimeoutSeconds} min={10} disabled={!editable} onChange={value => setForm({ ...form, responseTimeoutSeconds: value })}/></div><div className="streamlabs-check"><input id="bank-auto" disabled={!editable} type="checkbox" checked={form.autoConsolidate} onChange={event => setForm({ ...form, autoConsolidate: event.target.checked })}/><label htmlFor="bank-auto"><b>Auto-accumulate after verified results</b><small>Unconfirmed transfers are never retried automatically.</small></label></div><div className="points-action-row"><Button variant="secondary" disabled={!editable || busy} onClick={() => run({ action: "save", config: form }, "Points Bank settings saved.")}><Save size={15}/>Save settings</Button><Button disabled={busy || operationBusy || !form.bankAccountId || selected.length < 2} onClick={() => run({ action: "sweep-points" }, "Reserve-aware accumulation started.")}><Landmark size={15}/>Accumulate all</Button></div>{state.enabled && <small className="helper">Pause Streamlabs Mode to change bank configuration. Balance and transfer actions remain available.</small>}</CardContent></Card>

      <Card><CardHeader><div><h2>Send points</h2><p>Move points between any two tracked accounts.</p></div></CardHeader><CardContent className="settings-fields"><label className="field"><span>From</span><select value={fromAccountId} onChange={event => setFromAccountId(event.target.value)}>{selected.map(account => <option value={account.id} key={account.id}>{account.displayName} — {account.channelName}</option>)}</select></label><label className="field"><span>To</span><select value={toAccountId} onChange={event => setToAccountId(event.target.value)}>{selected.filter(account => account.id !== fromAccountId).map(account => <option value={account.id} key={account.id}>{account.displayName} — {account.channelName}</option>)}</select></label><label className="field"><span>Amount</span><input type="number" min={1} max={form.maximumTransfer} value={amount} onChange={event => setAmount(Number(event.target.value))}/><small className="helper">Sender keeps {form.protectedReserve.toLocaleString()} points. Maximum {form.maximumTransfer.toLocaleString()} per transfer.</small></label><Button disabled={busy || operationBusy || !fromAccountId || !toAccountId || amount < 1} onClick={() => run({ action: "transfer-points", fromAccountId, toAccountId, amount }, "Transfer operation started.")}><ArrowRightLeft size={15}/>Send points</Button></CardContent></Card></div></div>

    <div className="points-history-grid"><Card><CardHeader><div><h2>Heist profit and loss</h2><p>Performance calculated from verified Streamlabs results.</p></div></CardHeader><div className="table-scroll"><table className="points-table"><thead><tr><th>Completed</th><th>Participants</th><th>Winners</th><th>Wager</th><th>Net</th></tr></thead><tbody>{intelligence.recentHeists.map(heist => <tr key={heist.resultsMessageId}><td><small>{new Date(heist.completedAt).toLocaleString()}</small></td><td>{heist.participants.length}</td><td>{heist.participants.filter(item => item.outcome === "WON").length}</td><td>{heist.wager.toLocaleString()}</td><td className={heist.totalNet < 0 ? "streamlabs-error" : "points-positive"}>{heist.totalNet > 0 ? "+" : ""}{heist.totalNet.toLocaleString()}</td></tr>)}{!intelligence.recentHeists.length && <tr><td colSpan={5}>No verified heist results yet.</td></tr>}</tbody></table></div></Card><Card><CardHeader><div><h2>Transfer ledger</h2><p>Confirmed, failed, and uncertain movements.</p></div></CardHeader><div className="table-scroll"><table className="points-table"><thead><tr><th>Time</th><th>From</th><th>To</th><th>Amount</th><th>Status</th></tr></thead><tbody>{intelligence.transfers.map(transfer => <tr key={transfer.id}><td><small>{new Date(transfer.createdAt).toLocaleString()}</small></td><td>{transfer.donor}</td><td>{transfer.recipient}</td><td>{transfer.amount.toLocaleString()}</td><td><span className={`badge badge-${transfer.status === "CONFIRMED" ? "connected" : transfer.status === "FAILED" ? "error" : "paused"}`}>{transfer.status}</span></td></tr>)}{!intelligence.transfers.length && <tr><td colSpan={5}>No transfers recorded yet.</td></tr>}</tbody></table></div></Card></div>
    {intelligence.lastDecision && <p className="points-decision" role="status">{intelligence.lastDecision}</p>}
  </div>;
}

function NumberField({ label, value, min = 0, disabled, onChange }: { label: string; value: number; min?: number; disabled: boolean; onChange: (value: number) => void }) {
  return <label className="field"><span>{label}</span><input type="number" min={min} disabled={disabled} value={value} onChange={event => onChange(Number(event.target.value))}/></label>;
}

function BankMetric({ label, value, hint, icon: Icon, tone }: { label: string; value: string | number; hint: string; icon: typeof WalletCards; tone: string }) {
  return <Card className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={19}/></div><span>{label}</span><strong>{value}</strong><small>{hint}</small></Card>;
}

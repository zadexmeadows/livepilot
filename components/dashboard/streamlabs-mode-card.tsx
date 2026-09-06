"use client";

import { useEffect, useState } from "react";
import { Pause, Play, Radio, Save, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { StreamlabsConfig, StreamlabsState } from "@/lib/automation/streamlabs-controller";

type Account = { id: string; displayName: string; status: string };
type Log = { id: string; action: string; message: string; createdAt: string };

export function StreamlabsModeCard({ state, refresh }: { state: StreamlabsState | null; automations: { googleAccount: Account }[]; refresh: () => Promise<void> }) {
  const [form, setForm] = useState<StreamlabsConfig>({ youtubeUrl: "", accountIds: [], messages: [], delaySeconds: 10, fallbackSeconds: 300, noMessageRepeats: false });
  const [messageText, setMessageText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [accounts, setAccounts] = useState<Account[]>([]), [logs, setLogs] = useState<Log[]>([]);
  const active = state?.enabled ?? false, editable = !active;
  useEffect(() => { if (state && !state.enabled) { setForm(state.config); setMessageText(state.config.messages.join("\n")); } }, [state]);
  useEffect(() => { Promise.all([fetch("/api/accounts").then(response => response.json()), fetch("/api/logs?take=50").then(response => response.json())]).then(([nextAccounts, nextLogs]) => { setAccounts(nextAccounts); setLogs(nextLogs.filter((log: Log) => log.action.startsWith("STREAMLABS_"))); }).catch(() => undefined); }, [state]);
  const submit = async (action: "save" | "start" | "pause" | "stop") => {
    setBusy(true); setError("");
    try {
      const config = { ...form, messages: messageText.split("\n").map(value => value.trim()).filter(Boolean) };
      const response = await fetch("/api/streamlabs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "save" || action === "start" ? { action, config } : { action }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Could not update Streamlabs Mode."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update Streamlabs Mode."); } finally { setBusy(false); }
  };
  const toggleAccount = (id: string) => setForm(value => ({ ...value, accountIds: value.accountIds.includes(id) ? value.accountIds.filter(item => item !== id) : [...value.accountIds, id] }));
  const setMonitor = (id: string) => setForm(value => ({ ...value, accountIds: [id, ...value.accountIds.filter(item => item !== id)] }));
  const current = state?.participants.find(account => account.id === state.currentAccountId);

  return <Card className={`streamlabs-card ${active ? "streamlabs-on" : ""}`}>
    <CardHeader className="section-heading wrap"><div><h2><Radio size={19}/> Streamlabs Mode</h2><p>Independent announcement-first rounds with a timer fallback. Regular automations keep running.</p></div><div className="streamlabs-controls"><span className="streamlabs-phase" role="status">{state?.phase ?? "OFF"}</span>{active ? <><Button variant="secondary" disabled={busy} onClick={() => submit("pause")}><Pause size={15}/>Pause</Button><Button variant="danger" disabled={busy} onClick={() => submit("stop")}><Square size={14}/>Stop</Button></> : <Button disabled={busy} onClick={() => submit("start")}><Play size={15}/>{state?.phase === "PAUSED" ? "Resume" : "Start"}</Button>}</div></CardHeader>
    <CardContent className="streamlabs-layout"><div className="streamlabs-settings">
      <label className="field"><span>Livestream URL</span><input disabled={!editable} value={form.youtubeUrl} onChange={event => setForm({ ...form, youtubeUrl: event.target.value })} placeholder="https://www.youtube.com/watch?v=…"/></label>
      <div className="streamlabs-number-grid"><label className="field"><span>Delay between accounts (seconds)</span><input disabled={!editable} type="number" min={1} max={3600} value={form.delaySeconds} onChange={event => setForm({ ...form, delaySeconds: Number(event.target.value) })}/></label><label className="field"><span>Fallback round after no announcement (seconds)</span><input disabled={!editable} type="number" min={10} max={86400} value={form.fallbackSeconds} onChange={event => setForm({ ...form, fallbackSeconds: Number(event.target.value) })}/></label></div>
      <div className="field"><span>Accounts</span><small className="helper">Select accounts; choose which one watches Streamlabs announcements.</small><div className="streamlabs-accounts">{accounts.filter(account => account.status === "CONNECTED").map(account => { const selected = form.accountIds.includes(account.id), monitor = form.accountIds[0] === account.id; return <div key={account.id}><label><input disabled={!editable} type="checkbox" checked={selected} onChange={() => toggleAccount(account.id)}/><span>{account.displayName}</span></label>{selected && <button type="button" disabled={!editable || monitor} onClick={() => setMonitor(account.id)}>{monitor ? "Watching" : "Make watcher"}</button>}</div>; })}</div></div>
      <label className="field"><span>Message pool (one message per line)</span><textarea disabled={!editable} rows={4} value={messageText} onChange={event => setMessageText(event.target.value)} placeholder={'!heist 100\nLet’s go!\nJoining now'}/></label>
      <div className="streamlabs-check"><input id="streamlabs-no-repeats" disabled={!editable} type="checkbox" checked={form.noMessageRepeats} onChange={event => setForm({ ...form, noMessageRepeats: event.target.checked })}/><label htmlFor="streamlabs-no-repeats"><b>No message repeats per round</b><small>When off, each account independently chooses from the pool and repeats are allowed.</small></label></div>
      {editable && <Button variant="secondary" disabled={busy} onClick={() => submit("save")}><Save size={15}/>Save settings</Button>}
    </div><div className="streamlabs-status-panel"><h3>Mode status</h3><dl><div><dt>Round</dt><dd>{state?.round ?? 0}</dd></div><div><dt>Last trigger</dt><dd>{state?.lastRoundTrigger?.toLowerCase() ?? "—"}</dd></div><div><dt>Current account</dt><dd>{current?.name ?? "—"}</dd></div><div><dt>Next action</dt><dd>{state?.nextActionAt ? new Date(state.nextActionAt).toLocaleTimeString() : "—"}</dd></div></dl>{state?.reason && <p role="status" className="helper">{state.reason}</p>}{error && <p role="alert" className="streamlabs-error">{error}</p>}<h3>Streamlabs logs</h3><div className="streamlabs-logs">{logs.slice(0, 5).map(log => <div key={log.id}><time>{new Date(log.createdAt).toLocaleTimeString()}</time><span>{log.message}</span></div>)}{!logs.length && <p className="helper">No Streamlabs activity yet.</p>}</div></div></CardContent>
  </Card>;
}

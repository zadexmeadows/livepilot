"use client";

import { useState } from "react";
import { Bot, Radio, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import type { StreamlabsState } from "@/lib/automation/streamlabs-controller";

type Automation = { id: string; name: string; youtubeUrl: string; createdAt: string; googleAccount: { displayName: string; status: string } };
export function StreamlabsModeCard({ state, automations, refresh }: { state: StreamlabsState | null; automations: Automation[]; refresh: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const enabled = state?.enabled ?? false;
  const order = enabled ? state!.participants : automations.filter(a => a.googleAccount.status === "CONNECTED")
    .sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(a => ({ id: a.id, name: a.name, accountName: a.googleAccount.displayName, youtubeUrl: a.youtubeUrl }));
  const change = async (stop = false) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(stop ? "/api/emergency-stop" : "/api/streamlabs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not change mode.");
      setConfirm(false); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not change mode."); }
    finally { setBusy(false); }
  };
  return <><Card className={`streamlabs-card ${enabled ? "streamlabs-on" : ""}`}>
    <CardHeader className="section-heading wrap"><div><h2><Radio size={19}/> Streamlabs Mode</h2><p>{enabled ? "Normal intervals are suspended. Listening for a new treasure-hunt announcement." : "Announcement → first automation → 10 seconds → next automation."}</p></div>
      <div className="streamlabs-controls"><span className="streamlabs-phase" role="status">{enabled ? state?.phase.replaceAll("_", " ") : "OFF"}</span>
        <Button role="switch" aria-checked={enabled} aria-label="Streamlabs Mode" disabled={busy || !state || (!enabled && !order.length)} variant={enabled ? "default" : "outline"} onClick={() => setConfirm(true)}><Bot size={17}/>{enabled ? "ON" : "OFF"}</Button>
        {enabled && <Button disabled={busy} variant="danger" onClick={() => change(true)}><Square size={14}/>Stop sequence</Button>}
      </div></CardHeader>
    <CardContent><p className="helper">{order.length ? `Watches ${order[0].name}'s chat. Sends each automation's saved message to its own configured stream, oldest automation first.` : "Create an automation and connect its account to enable this mode."}</p>
      <ol className="streamlabs-order">{order.map((a, i) => <li key={a.id} className={a.id === state?.currentAutomationId ? "current" : ""}><span>{i + 1}</span><div><b>{a.name}</b><small>{a.accountName}</small></div>{i > 0 && <em>+10s</em>}</li>)}</ol>
      {enabled && <p className="helper">Round {state?.round ?? 0} · {state?.lastAnnouncementAt ? `Last announcement: ${new Date(state.lastAnnouncementAt).toLocaleTimeString()}` : "Waiting for the first NEW announcement"}{state?.nextSendAt ? ` · Next action: ${new Date(state.nextSendAt).toLocaleTimeString()}` : ""}</p>}
      {state?.reason && <p role="status" className="helper">{state.reason}</p>}{error && <p role="alert" className="streamlabs-error">{error}</p>}
    </CardContent>
  </Card><Dialog open={confirm} onClose={() => !busy && setConfirm(false)} title={enabled ? "Turn Streamlabs mode off?" : "Turn Streamlabs mode on?"} description={enabled ? "Cancels this sequence and resumes only interval workers that were running before you turned the mode on." : "Uses the connected-account automations listed above. Existing interval workers are paused; schedule and session limits are suspended until you stop this mode."}>
      <div className="confirm-body"><Radio/><p>{enabled ? "Use Stop sequence instead if you want all sending to remain stopped." : "Only new Streamlabs announcements trigger a round. Each automation sends once, with 10 seconds between sends. Old announcements and overlapping rounds are not replayed. Slow mode and account restrictions still apply. Editing or stopping a participating automation stops the whole sequence."}</p></div>
      <footer className="dialog-footer"><Button variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button><Button disabled={busy} onClick={() => change()}>{busy ? "Changing mode…" : enabled ? "Turn off & restore intervals" : "Turn on & listen"}</Button></footer>
    </Dialog></>;
}

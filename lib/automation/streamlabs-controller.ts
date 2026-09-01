import type { Automation, GoogleAccount } from "@prisma/client";
import type { Page } from "playwright";
import { db } from "@/lib/db/client";
import { browserManager } from "@/lib/browser/browser-manager";
import { sendChatMessage, detectAccountStatus, detectStreamStatus, type ChatResult } from "@/lib/browser/youtube-chat";
import { readStreamlabsChat } from "@/lib/browser/streamlabs-chat";
import { activityLog } from "@/lib/logger/activity-logger";
import { emitDashboardEvent } from "@/lib/events";
import { AnnouncementTracker } from "./streamlabs-matcher";
import { cancellableDelay } from "./cancellation";
import { isTransientBrowserError, MAX_TRANSIENT_RETRIES, retryDelaySeconds } from "./retry-policy";

type Participant = Automation & { googleAccount: GoogleAccount };
export type StreamlabsState = {
  enabled: boolean;
  phase: "OFF" | "STARTING" | "LISTENING" | "SENDING" | "RETRYING" | "ERROR";
  reason: string | null;
  participants: { id: string; name: string; accountName: string; youtubeUrl: string }[];
  round: number;
  currentAutomationId: string | null;
  lastAnnouncementAt: string | null;
  nextSendAt: string | null;
};

export class StreamlabsController {
  private state: StreamlabsState = { enabled: false, phase: "OFF", reason: null, participants: [], round: 0, currentAutomationId: null, lastAnnouncementAt: null, nextSendAt: null };
  private abort?: AbortController;
  private task?: Promise<void>;
  private pages = new Map<string, Page>();
  private executions = new Map<string, string>();
  private blocked = new Set<string>();
  private cooldown = new Map<string, number>();
  private failures = new Map<string, number>();
  private participants: Participant[] = [];

  constructor(private readonly delay = cancellableDelay) {}
  snapshot() { return { ...this.state, participants: [...this.state.participants] }; }
  isRunning(id: string) { return (this.state.enabled || !!this.task) && this.participants.some(a => a.id === id); }
  runningCount() { return this.state.enabled ? this.participants.filter(a => !this.blocked.has(a.id)).length : 0; }

  private async publish(patch: Partial<StreamlabsState>) {
    this.state = { ...this.state, ...patch };
    await db.appSetting.upsert({ where: { key: "streamlabsMode" }, create: { key: "streamlabsMode", value: JSON.stringify(this.state) }, update: { value: JSON.stringify(this.state) } });
    emitDashboardEvent("streamlabs.updated", this.snapshot());
  }

  private async status(id: string, status: string, reason: string | null = null, nextSendAt: Date | null = null) {
    const row = await db.automation.update({ where: { id }, data: { status, lastError: reason, nextSendAt } });
    emitDashboardEvent("automation.updated", row);
  }

  async start(participants: Participant[]) {
    if (this.state.enabled || this.task) throw new Error("Streamlabs mode is already running.");
    if (!participants.length) throw new Error("Create an automation with a connected account first.");
    this.participants = participants;
    this.blocked.clear(); this.cooldown.clear(); this.failures.clear(); this.executions.clear();
    this.abort = new AbortController();
    await this.publish({ enabled: true, phase: "STARTING", reason: null, round: 0, lastAnnouncementAt: null, currentAutomationId: null, nextSendAt: null,
      participants: participants.map(a => ({ id: a.id, name: a.name, accountName: a.googleAccount.displayName, youtubeUrl: a.youtubeUrl })) });
    this.task = this.run(this.abort.signal).catch(async error => {
      // Even logging/storage failures must not become an unhandled worker rejection.
      this.abort?.abort();
      this.state = { ...this.state, enabled: false, phase: "ERROR", reason: error instanceof Error ? error.message : "Streamlabs worker failed.", currentAutomationId: null, nextSendAt: null };
      emitDashboardEvent("streamlabs.updated", this.snapshot());
    }).finally(() => { this.task = undefined; });
    return this.snapshot();
  }

  async stop(reason = "Streamlabs mode stopped manually.") {
    this.abort?.abort();
    await this.task;
    this.task = undefined;
    if (this.state.enabled) {
      for (const item of this.participants) {
        if (!this.blocked.has(item.id)) await this.status(item.id, "STOPPED");
      }
    }
    await this.publish({ enabled: false, phase: "OFF", reason, currentAutomationId: null, nextSendAt: null });
    return this.snapshot();
  }

  private async pageFor(item: Participant, signal: AbortSignal) {
    let page = this.pages.get(item.id);
    if (!page || page.isClosed()) {
      page = await browserManager.newPage(item.googleAccountId);
      this.pages.set(item.id, page);
      signal.throwIfAborted();
      await page.goto(item.youtubeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    return page;
  }

  private async claim(videoId: string, messageId: string) {
    try { await db.streamlabsTrigger.create({ data: { videoId, messageId } }); return true; }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") return false;
      throw error;
    }
  }

  private async run(signal: AbortSignal) {
    const source = this.participants[0];
    const tracker = new AnnouncementTracker();
    let monitor: Page | undefined;
    let roundTask: Promise<void> | undefined;
    let roundError: unknown;
    let monitorFailures = 0;
    const closeOnAbort = () => {
      void monitor?.close().catch(() => undefined);
      for (const page of this.pages.values()) void page.close().catch(() => undefined);
    };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      for (const item of this.participants) {
        signal.throwIfAborted();
        const execution = await db.automationExecution.create({ data: { automationId: item.id, status: "WAITING_FOR_TRIGGER" } });
        this.executions.set(item.id, execution.id);
        await db.automation.update({ where: { id: item.id }, data: { sessionMessagesSent: 0 } });
        await this.status(item.id, "WAITING_FOR_TRIGGER");
        // Warm up each isolated page before listening, so the first send does not
        // have to launch a browser or navigate after the announcement arrives.
        try { await this.pageFor(item, signal); }
        catch (error) {
          if (signal.aborted || !isTransientBrowserError(error)) throw error;
          const page = this.pages.get(item.id);
          if (page) await browserManager.closePage(item.googleAccountId, page);
          this.pages.delete(item.id);
        }
      }
      await activityLog({ action: "STREAMLABS_STARTED", status: "WAITING_FOR_TRIGGER", message: `Streamlabs mode enabled for ${this.participants.length} automations. Watching ${source.name}; normal repeat intervals and session limits are suspended.` });
      while (!signal.aborted) {
        if (roundError) throw roundError;
        try {
          if (!monitor || monitor.isClosed()) {
            monitor = await browserManager.newPage(source.googleAccountId);
            signal.throwIfAborted();
            await monitor.goto(source.youtubeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
            tracker.resetBaseline();
            // Let the existing transcript populate before setting its baseline.
            await this.delay(2000, signal);
          }
          const account = await detectAccountStatus(monitor);
          if (!account.authenticated && account.signedOut) throw new Error("Reconnect the monitoring account. It is signed out of YouTube.");
          const stream = await detectStreamStatus(monitor);
          if (stream.ended) throw new Error("The monitored livestream has ended.");
          if (!stream.active) {
            await this.publish({ phase: "RETRYING", reason: stream.reason ?? "Waiting for the livestream.", nextSendAt: new Date(Date.now() + 60_000).toISOString() });
            await this.delay(60_000, signal); continue;
          }
          const messages = await readStreamlabsChat(monitor);
          if (messages === null) { const error = new Error("Live chat is still loading or unavailable."); error.name = "TimeoutError"; throw error; }
          monitorFailures = 0;
          if (!roundTask && this.state.phase !== "LISTENING") await this.publish({ phase: "LISTENING", reason: null, nextSendAt: null });
          for (const announcement of tracker.observe(messages)) {
            signal.throwIfAborted();
            if (!await this.claim(source.videoId, announcement.id)) continue;
            if (roundTask) {
              await activityLog({ action: "STREAMLABS_OVERLAP_SKIPPED", level: "WARNING", status: "RUNNING", message: "A new announcement arrived during a round. It was not queued; waiting for a fresh announcement after this round." });
              continue;
            }
            await this.publish({ phase: "SENDING", round: this.state.round + 1, lastAnnouncementAt: new Date().toISOString() });
            await activityLog({ automationId: source.id, action: "STREAMLABS_TRIGGER", status: "RUNNING", message: `New Streamlabs treasure-hunt announcement detected. Starting round ${this.state.round}.`, stream: source.youtubeUrl });
            roundTask = this.runRound(signal).catch(error => { roundError = error; }).finally(() => { roundTask = undefined; });
          }
          await this.delay(750, signal);
        } catch (error) {
          if (signal.aborted || !isTransientBrowserError(error)) throw error;
          if (++monitorFailures > MAX_TRANSIENT_RETRIES) throw new Error("Streamlabs monitor could not recover after five delayed retries. Check the browser session.");
          const seconds = retryDelaySeconds(monitorFailures, 30);
          await this.publish({ phase: "RETRYING", reason: "Temporary chat-monitor failure; reconnecting after a delay.", nextSendAt: new Date(Date.now() + seconds * 1000).toISOString() });
          await activityLog({ action: "STREAMLABS_MONITOR_RETRY", level: "WARNING", status: "RETRYING", message: `Chat monitor retry ${monitorFailures}/5 in ${seconds} seconds.` });
          if (monitor) await browserManager.closePage(source.googleAccountId, monitor);
          monitor = undefined;
          await this.delay(seconds * 1000, signal);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        const reason = error instanceof Error ? error.message : "Streamlabs mode failed.";
        this.abort?.abort();
        await this.publish({ enabled: false, phase: "ERROR", reason, nextSendAt: null, currentAutomationId: null });
        await activityLog({ action: "STREAMLABS_ERROR", level: "ERROR", status: "ERROR", message: "Streamlabs mode stopped. Normal interval workers remain stopped.", errorMessage: reason });
        for (const item of this.participants) if (!this.blocked.has(item.id)) await this.status(item.id, "ERROR", reason);
      }
    } finally {
      await roundTask;
      signal.removeEventListener("abort", closeOnAbort);
      if (monitor) await browserManager.closePage(source.googleAccountId, monitor);
      for (const item of this.participants) {
        const page = this.pages.get(item.id);
        if (page) await browserManager.closePage(item.googleAccountId, page);
        const executionId = this.executions.get(item.id);
        if (executionId && !this.blocked.has(item.id)) await db.automationExecution.update({ where: { id: executionId }, data: { endedAt: new Date(), status: this.state.phase === "ERROR" ? "ERROR" : "STOPPED", completionNote: "Streamlabs session ended." } }).catch(() => undefined);
      }
      this.pages.clear();
    }
  }

  private async runRound(signal: AbortSignal) {
    let lastAttemptAt = 0;
    for (const item of this.participants) {
      signal.throwIfAborted();
      if (this.blocked.has(item.id)) continue;
      const eligibleAt = this.cooldown.get(item.id) ?? 0;
      if (eligibleAt > Date.now()) {
        await activityLog({ automationId: item.id, action: "STREAMLABS_COOLDOWN", level: "WARNING", status: "RATE_LIMITED", message: "This announcement was skipped for this account because its cooldown is still active." });
        continue;
      }
      const delay = Math.max(0, lastAttemptAt + 10_000 - Date.now());
      if (delay) {
        await this.status(item.id, "TRIGGER_QUEUED", null, new Date(Date.now() + delay));
        await this.publish({ currentAutomationId: item.id, nextSendAt: new Date(Date.now() + delay).toISOString() });
        await this.delay(delay, signal);
      }
      signal.throwIfAborted();
      await this.publish({ currentAutomationId: item.id, nextSendAt: null });
      await this.status(item.id, "RUNNING");
      let result: ChatResult;
      try {
        const account = await db.googleAccount.findUniqueOrThrow({ where: { id: item.googleAccountId } });
        if (account.status !== "CONNECTED") result = { ok: false, status: "AUTH_REQUIRED", reason: "Reconnect the selected account." };
        else {
          const page = await this.pageFor(item, signal);
          signal.throwIfAborted();
          result = await sendChatMessage(page, item.youtubeUrl, item.message, signal, { prepared: true });
        }
      } catch (error) {
        if (signal.aborted) throw error;
        result = { ok: false, status: "ERROR", retryable: isTransientBrowserError(error), reason: error instanceof Error ? error.message : "Send failed." };
      }
      signal.throwIfAborted();
      lastAttemptAt = Date.now();
      // Shared-account automations must not collectively bypass a cooldown.
      const imposeCooldown = (seconds: number) => {
        for (const peer of this.participants.filter(a => a.googleAccountId === item.googleAccountId)) this.cooldown.set(peer.id, Date.now() + seconds * 1000);
      };
      const executionId = this.executions.get(item.id)!;
      if (result.ok) {
        this.failures.delete(item.id);
        imposeCooldown(30);
        const updated = await db.automation.update({ where: { id: item.id }, data: { status: "WAITING_FOR_TRIGGER", lastError: null, nextSendAt: null, lastSentAt: new Date(), messagesSent: { increment: 1 }, sessionMessagesSent: { increment: 1 } } });
        await db.automationExecution.update({ where: { id: executionId }, data: { status: "WAITING_FOR_TRIGGER", messagesSent: { increment: 1 } } });
        await activityLog({ automationId: item.id, action: "MESSAGE_SENT", level: "SUCCESS", status: "WAITING_FOR_TRIGGER", message: `Streamlabs round ${this.state.round}: configured message sent through YouTube live chat.`, stream: item.youtubeUrl });
        emitDashboardEvent("message.sent", updated);
      } else {
        const reason = result.reason ?? "YouTube did not accept the message.";
        const failures = result.retryable ? (this.failures.get(item.id) ?? 0) + 1 : 0;
        if (result.retryable) this.failures.set(item.id, failures);
        const retry = result.status === "RATE_LIMITED" || result.status === "WAITING_FOR_STREAM" || (result.retryable && failures <= MAX_TRANSIENT_RETRIES);
        await db.automationExecution.update({ where: { id: executionId }, data: { errorCount: { increment: 1 } } });
        if (retry) {
          const seconds = Math.max(result.retryAfterSeconds ?? 60, retryDelaySeconds(Math.max(1, failures), 30));
          imposeCooldown(seconds);
          await this.status(item.id, "WAITING_FOR_TRIGGER", reason);
          await activityLog({ automationId: item.id, action: "STREAMLABS_SEND_DEFERRED", level: "WARNING", status: "WAITING_FOR_TRIGGER", message: `This round will not resend this account's message. Wait at least ${seconds} seconds and a new announcement.`, errorMessage: reason });
          const page = this.pages.get(item.id);
          if (page) await browserManager.closePage(item.googleAccountId, page);
          this.pages.delete(item.id);
        } else {
          const status = result.status === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "ERROR";
          this.blocked.add(item.id);
          if (status === "AUTH_REQUIRED") await db.googleAccount.update({ where: { id: item.googleAccountId }, data: { status } });
          await this.status(item.id, status, reason);
          await db.automationExecution.update({ where: { id: executionId }, data: { status, endedAt: new Date(), completionNote: reason } });
          await activityLog({ automationId: item.id, action: "STREAMLABS_ACCOUNT_BLOCKED", level: "ERROR", status, message: "This automation cannot send and has been removed from the Streamlabs sequence until you restart the mode.", errorMessage: reason });
        }
      }
    }
    if (this.blocked.size === this.participants.length) throw new Error("No automation can send. Check the account errors before restarting Streamlabs mode.");
    await this.publish({ phase: "LISTENING", currentAutomationId: null, nextSendAt: null });
    await activityLog({ action: "STREAMLABS_ROUND_COMPLETE", status: "WAITING_FOR_TRIGGER", message: `Round ${this.state.round} finished. Waiting for a NEW Streamlabs announcement.` });
  }
}

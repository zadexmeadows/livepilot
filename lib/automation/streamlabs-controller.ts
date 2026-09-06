import type { GoogleAccount } from "@prisma/client";
import type { Page } from "playwright";
import { db } from "@/lib/db/client";
import { browserManager } from "@/lib/browser/browser-manager";
import { sendChatMessage, detectAccountStatus, detectStreamStatus, parseYouTubeUrl, type ChatResult } from "@/lib/browser/youtube-chat";
import { readStreamlabsChat } from "@/lib/browser/streamlabs-chat";
import { activityLog } from "@/lib/logger/activity-logger";
import { emitDashboardEvent } from "@/lib/events";
import { AnnouncementTracker } from "./streamlabs-matcher";
import { cancellableDelay } from "./cancellation";
import { accountAccess } from "./account-access";
import { isTransientBrowserError, MAX_TRANSIENT_RETRIES, retryDelaySeconds } from "./retry-policy";

export type StreamlabsConfig = {
  youtubeUrl: string;
  accountIds: string[];
  messages: string[];
  delaySeconds: number;
  fallbackSeconds: number;
  noMessageRepeats: boolean;
};
export type StreamlabsState = {
  enabled: boolean;
  phase: "OFF" | "PAUSED" | "STARTING" | "LISTENING" | "SENDING" | "RETRYING" | "ERROR";
  reason: string | null;
  participants: { id: string; name: string }[];
  round: number;
  currentAccountId: string | null;
  lastAnnouncementAt: string | null;
  lastRoundTrigger: "ANNOUNCEMENT" | "TIMER" | null;
  nextActionAt: string | null;
  config: StreamlabsConfig;
};

const defaults: StreamlabsConfig = { youtubeUrl: "", accountIds: [], messages: [], delaySeconds: 10, fallbackSeconds: 300, noMessageRepeats: false };
const shuffle = <T,>(items: T[]) => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
};

export class StreamlabsController {
  private state: StreamlabsState = { enabled: false, phase: "OFF", reason: null, participants: [], round: 0, currentAccountId: null, lastAnnouncementAt: null, lastRoundTrigger: null, nextActionAt: null, config: defaults };
  private abort?: AbortController;
  private task?: Promise<void>;
  private pages = new Map<string, Page>();
  private blocked = new Set<string>();
  private cooldown = new Map<string, number>();
  private failures = new Map<string, number>();
  private participants: GoogleAccount[] = [];

  constructor(private readonly delay = cancellableDelay) {}
  snapshot() { return { ...this.state, participants: [...this.state.participants], config: { ...this.state.config, accountIds: [...this.state.config.accountIds], messages: [...this.state.config.messages] } }; }
  isRunning() { return this.state.enabled || !!this.task; }
  runningCount() { return this.state.enabled ? this.participants.filter(a => !this.blocked.has(a.id)).length : 0; }

  async load() {
    const stored = await db.appSetting.findUnique({ where: { key: "streamlabsConfig" } });
    if (stored) { try { this.state.config = { ...defaults, ...JSON.parse(stored.value) }; } catch { /* retain safe defaults */ } }
    else {
      const legacy = await db.automation.findMany({ where: { googleAccount: { status: "CONNECTED" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      if (legacy.length) {
        const migrated = { ...defaults, youtubeUrl: legacy[0].youtubeUrl, accountIds: [...new Set(legacy.map(item => item.googleAccountId))], messages: [...new Set(legacy.map(item => item.message).filter(Boolean))] };
        this.state.config = migrated;
        await db.appSetting.create({ data: { key: "streamlabsConfig", value: JSON.stringify(migrated) } });
      }
    }
    return this.snapshot();
  }

  private async publish(patch: Partial<StreamlabsState>) {
    this.state = { ...this.state, ...patch };
    await db.appSetting.upsert({ where: { key: "streamlabsState" }, create: { key: "streamlabsState", value: JSON.stringify(this.state) }, update: { value: JSON.stringify(this.state) } });
    emitDashboardEvent("streamlabs.updated", this.snapshot());
  }

  async configure(config: StreamlabsConfig) {
    if (this.isRunning()) throw new Error("Pause or stop Streamlabs Mode before changing its settings.");
    const parsed = parseYouTubeUrl(config.youtubeUrl);
    const clean: StreamlabsConfig = {
      youtubeUrl: parsed.canonicalUrl,
      accountIds: [...new Set(config.accountIds)],
      messages: [...new Set(config.messages.map(value => value.trim()).filter(Boolean))],
      delaySeconds: Math.max(1, Math.round(config.delaySeconds)),
      fallbackSeconds: Math.max(10, Math.round(config.fallbackSeconds)),
      noMessageRepeats: Boolean(config.noMessageRepeats),
    };
    if (!clean.accountIds.length) throw new Error("Select at least one connected Google account.");
    if (!clean.messages.length) throw new Error("Add at least one chat message.");
    if (clean.noMessageRepeats && clean.messages.length < clean.accountIds.length) throw new Error("Add at least one unique message per selected account when no repeats is enabled.");
    const count = await db.googleAccount.count({ where: { id: { in: clean.accountIds }, status: "CONNECTED" } });
    if (count !== clean.accountIds.length) throw new Error("Every selected account must be connected.");
    await db.appSetting.upsert({ where: { key: "streamlabsConfig" }, create: { key: "streamlabsConfig", value: JSON.stringify(clean) }, update: { value: JSON.stringify(clean) } });
    await this.publish({ config: clean, reason: null });
    return this.snapshot();
  }

  async start(config?: StreamlabsConfig) {
    if (config) await this.configure(config); else await this.load();
    if (this.state.enabled || this.task) throw new Error("Streamlabs Mode is already running.");
    const cfg = this.state.config;
    if (!cfg.youtubeUrl || !cfg.accountIds.length || !cfg.messages.length) throw new Error("Complete and save the Streamlabs settings first.");
    const accounts = await db.googleAccount.findMany({ where: { id: { in: cfg.accountIds }, status: "CONNECTED" } });
    const byId = new Map(accounts.map(account => [account.id, account]));
    this.participants = cfg.accountIds.map(id => byId.get(id)).filter((account): account is GoogleAccount => !!account);
    if (this.participants.length !== cfg.accountIds.length) throw new Error("Reconnect every selected account before starting Streamlabs Mode.");
    this.blocked.clear(); this.cooldown.clear(); this.failures.clear();
    this.abort = new AbortController();
    await this.publish({ enabled: true, phase: "STARTING", reason: null, currentAccountId: null, nextActionAt: null, participants: this.participants.map(a => ({ id: a.id, name: a.displayName })) });
    this.task = this.run(this.abort.signal).catch(async error => {
      if (this.state.phase !== "ERROR") await this.publish({ enabled: false, phase: "ERROR", reason: error instanceof Error ? error.message : "Streamlabs worker failed.", currentAccountId: null, nextActionAt: null });
    }).finally(() => { this.task = undefined; });
    return this.snapshot();
  }

  async pause() { return this.finish("PAUSED", "Streamlabs Mode paused. Regular automations continue unchanged."); }
  async stop(reason = "Streamlabs Mode stopped.") { return this.finish("OFF", reason); }
  private async finish(phase: "PAUSED" | "OFF", reason: string) {
    this.abort?.abort(); await this.task?.catch(() => undefined); this.task = undefined;
    await this.publish({ enabled: false, phase, reason, currentAccountId: null, nextActionAt: null });
    await activityLog({ action: phase === "PAUSED" ? "STREAMLABS_PAUSED" : "STREAMLABS_STOPPED", status: phase, message: reason });
    return this.snapshot();
  }

  private async pageFor(accountId: string, signal: AbortSignal) {
    let page = this.pages.get(accountId);
    if (!page || page.isClosed()) { page = await browserManager.newPage(accountId); this.pages.set(accountId, page); signal.throwIfAborted(); await page.goto(this.state.config.youtubeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }); }
    return page;
  }

  private async claim(videoId: string, messageId: string) {
    try { await db.streamlabsTrigger.create({ data: { videoId, messageId } }); return true; }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "P2002") return false; throw error; }
  }

  private async run(signal: AbortSignal) {
    const cfg = this.state.config, source = this.participants[0], videoId = parseYouTubeUrl(cfg.youtubeUrl).videoId;
    const tracker = new AnnouncementTracker();
    let monitor: Page | undefined, roundTask: Promise<void> | undefined, roundError: unknown, queuedAnnouncement = false, monitorFailures = 0;
    let fallbackAt = Date.now() + cfg.fallbackSeconds * 1000;
    const closeOnAbort = () => { void monitor?.close().catch(() => undefined); for (const page of this.pages.values()) void page.close().catch(() => undefined); };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    const beginRound = async (trigger: "ANNOUNCEMENT" | "TIMER") => {
      fallbackAt = Date.now() + cfg.fallbackSeconds * 1000;
      await this.publish({ phase: "SENDING", round: this.state.round + 1, lastRoundTrigger: trigger, nextActionAt: null });
      roundTask = this.runRound(signal, trigger).catch(error => { roundError = error; }).finally(() => { fallbackAt = Date.now() + cfg.fallbackSeconds * 1000; roundTask = undefined; });
    };
    try {
      for (const account of this.participants) { signal.throwIfAborted(); try { await this.pageFor(account.id, signal); } catch (error) { if (!isTransientBrowserError(error)) throw error; this.pages.delete(account.id); } }
      await activityLog({ action: "STREAMLABS_STARTED", status: "LISTENING", message: `Streamlabs Mode started with ${this.participants.length} accounts. Regular automations continue independently.`, stream: cfg.youtubeUrl });
      while (!signal.aborted) {
        if (roundError) throw roundError;
        try {
          if (!monitor || monitor.isClosed()) { monitor = await browserManager.newPage(source.id); signal.throwIfAborted(); await monitor.goto(cfg.youtubeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }); tracker.resetBaseline(); await this.delay(2000, signal); }
          const account = await detectAccountStatus(monitor);
          if (!account.authenticated && account.signedOut) throw new Error("Reconnect the monitoring account. It is signed out of YouTube.");
          const stream = await detectStreamStatus(monitor);
          if (stream.ended) throw new Error("The monitored livestream has ended.");
          if (!stream.active) { await this.publish({ phase: "RETRYING", reason: stream.reason ?? "Waiting for the livestream.", nextActionAt: new Date(Date.now() + 60_000).toISOString() }); await this.delay(60_000, signal); continue; }
          const messages = await readStreamlabsChat(monitor);
          if (messages === null) { const error = new Error("Live chat is still loading or unavailable."); error.name = "TimeoutError"; throw error; }
          monitorFailures = 0;
          for (const announcement of tracker.observe(messages)) {
            if (!await this.claim(videoId, announcement.id)) continue;
            await this.publish({ lastAnnouncementAt: new Date().toISOString() });
            if (roundTask) queuedAnnouncement = true; else await beginRound("ANNOUNCEMENT");
          }
          if (!roundTask && queuedAnnouncement) { queuedAnnouncement = false; await beginRound("ANNOUNCEMENT"); }
          else if (!roundTask && Date.now() >= fallbackAt) await beginRound("TIMER");
          else if (!roundTask && this.state.phase !== "LISTENING") await this.publish({ phase: "LISTENING", reason: null, nextActionAt: new Date(fallbackAt).toISOString() });
          await this.delay(750, signal);
        } catch (error) {
          if (signal.aborted || !isTransientBrowserError(error)) throw error;
          if (++monitorFailures > MAX_TRANSIENT_RETRIES) throw new Error("Streamlabs monitor could not recover after five delayed retries. Check the browser session.");
          const seconds = retryDelaySeconds(monitorFailures, 30);
          await this.publish({ phase: "RETRYING", reason: "Temporary chat-monitor failure; reconnecting after a delay.", nextActionAt: new Date(Date.now() + seconds * 1000).toISOString() });
          if (monitor) await browserManager.closePage(source.id, monitor); monitor = undefined;
          await this.delay(seconds * 1000, signal);
        }
      }
    } catch (error) {
      if (!signal.aborted) { const reason = error instanceof Error ? error.message : "Streamlabs Mode failed."; await this.publish({ enabled: false, phase: "ERROR", reason, nextActionAt: null, currentAccountId: null }); await activityLog({ action: "STREAMLABS_ERROR", level: "ERROR", status: "ERROR", message: "Streamlabs Mode stopped. Regular automations were not changed.", errorMessage: reason }); }
    } finally {
      await roundTask; signal.removeEventListener("abort", closeOnAbort);
      if (monitor) await browserManager.closePage(source.id, monitor);
      for (const account of this.participants) { const page = this.pages.get(account.id); if (page) await browserManager.closePage(account.id, page); }
      this.pages.clear();
    }
  }

  private async runRound(signal: AbortSignal, trigger: "ANNOUNCEMENT" | "TIMER") {
    const cfg = this.state.config, accounts = shuffle(this.participants.filter(account => !this.blocked.has(account.id))), messageOrder = cfg.noMessageRepeats ? shuffle(cfg.messages) : [];
    let lastAttemptAt = 0;
    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index]; signal.throwIfAborted();
      if ((this.cooldown.get(account.id) ?? 0) > Date.now()) { await activityLog({ action: "STREAMLABS_COOLDOWN", level: "WARNING", status: "RATE_LIMITED", message: `${account.displayName} skipped this round because its cooldown is active.` }); continue; }
      const wait = Math.max(0, lastAttemptAt + cfg.delaySeconds * 1000 - Date.now());
      if (wait) { await this.publish({ currentAccountId: account.id, nextActionAt: new Date(Date.now() + wait).toISOString() }); await this.delay(wait, signal); }
      const message = cfg.noMessageRepeats && index < messageOrder.length ? messageOrder[index] : cfg.messages[Math.floor(Math.random() * cfg.messages.length)];
      await this.publish({ currentAccountId: account.id, nextActionAt: null });
      let result: ChatResult;
      try {
        result = await accountAccess.run(account.id, signal, async () => {
          const current = await db.googleAccount.findUniqueOrThrow({ where: { id: account.id } });
          if (current.status !== "CONNECTED") return { ok: false, status: "AUTH_REQUIRED", reason: "Reconnect this account." } satisfies ChatResult;
          return sendChatMessage(await this.pageFor(account.id, signal), cfg.youtubeUrl, message, signal, { prepared: true });
        });
      } catch (error) { if (signal.aborted) throw error; result = { ok: false, status: "ERROR", retryable: isTransientBrowserError(error), reason: error instanceof Error ? error.message : "Send failed." }; }
      lastAttemptAt = Date.now();
      if (result.ok) {
        this.failures.delete(account.id);
        await activityLog({ action: "STREAMLABS_MESSAGE_SENT", level: "SUCCESS", status: "RUNNING", message: `Round ${this.state.round}: ${account.displayName} sent “${message}”.`, stream: cfg.youtubeUrl });
      } else {
        const reason = result.reason ?? "YouTube did not accept the message.", failures = result.retryable ? (this.failures.get(account.id) ?? 0) + 1 : 0;
        if (result.retryable) this.failures.set(account.id, failures);
        const retry = result.status === "RATE_LIMITED" || result.status === "WAITING_FOR_STREAM" || (result.retryable && failures <= MAX_TRANSIENT_RETRIES);
        if (retry) {
          const seconds = Math.max(result.retryAfterSeconds ?? 60, retryDelaySeconds(Math.max(1, failures), 30)); this.cooldown.set(account.id, Date.now() + seconds * 1000);
          await activityLog({ action: "STREAMLABS_SEND_DEFERRED", level: "WARNING", status: "WAITING_FOR_TRIGGER", message: `${account.displayName} will not resend in this round.`, errorMessage: reason });
          const page = this.pages.get(account.id); if (page) await browserManager.closePage(account.id, page); this.pages.delete(account.id);
        } else { this.blocked.add(account.id); await activityLog({ action: "STREAMLABS_ACCOUNT_BLOCKED", level: "ERROR", status: result.status, message: `${account.displayName} was removed from Streamlabs Mode until it is restarted.`, errorMessage: reason }); }
      }
    }
    if (this.blocked.size === this.participants.length) throw new Error("No selected account can send. Check the Streamlabs logs before restarting.");
    await this.publish({ phase: "LISTENING", currentAccountId: null, nextActionAt: new Date(Date.now() + cfg.fallbackSeconds * 1000).toISOString() });
    await activityLog({ action: "STREAMLABS_ROUND_COMPLETE", status: "WAITING_FOR_TRIGGER", message: `Round ${this.state.round} (${trigger.toLowerCase()}) finished. Waiting for an announcement; timer fallback remains active.` });
  }
}

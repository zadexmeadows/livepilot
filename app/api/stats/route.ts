import { startOfDay } from "date-fns";
import { db } from "@/lib/db/client";
import { browserManager } from "@/lib/browser/browser-manager";
import { automationController } from "@/lib/automation/automation-controller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const today = startOfDay(new Date());
  const [connectedAccounts, activeAutomations, messagesSentToday, failedMessages] = await Promise.all([
    db.googleAccount.count({ where: { status: "CONNECTED" } }),
    db.automation.count({ where: { status: { in: ["STARTING", "RUNNING", "RETRYING", "WAITING_FOR_STREAM", "RATE_LIMITED", "WAITING_FOR_TRIGGER", "TRIGGER_QUEUED"] } } }),
    db.messageLog.count({ where: { action: "MESSAGE_SENT", createdAt: { gte: today } } }),
    db.messageLog.count({ where: { level: "ERROR", createdAt: { gte: today } } }),
  ]);
  return Response.json({ connectedAccounts, activeAutomations, messagesSentToday, failedMessages, browserStatus: browserManager.isRunning() ? "Running" : "Ready", browserContexts: browserManager.activeContextCount(), activeWorkers: automationController.runningCount() });
}

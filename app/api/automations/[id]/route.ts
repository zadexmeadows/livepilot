import { db } from "@/lib/db/client";
import { parseYouTubeUrl } from "@/lib/browser/youtube-chat";
import { automationInputSchema } from "@/lib/validation/schemas";
import { automationController } from "@/lib/automation/automation-controller";
import { activityLog } from "@/lib/logger/activity-logger";
import { emitDashboardEvent } from "@/lib/events";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const automation = await db.automation.findUnique({ where: { id }, include: { googleAccount: true, executions: { orderBy: { startedAt: "desc" }, take: 5 } } });
  return automation ? Response.json(automation) : Response.json({ error: "Automation not found." }, { status: 404 });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const input = automationInputSchema.parse(await request.json());
    await automationController.beforeMutation(id);
    const { videoId, canonicalUrl } = parseYouTubeUrl(input.youtubeUrl);
    const automation = await db.automation.update({ where: { id }, data: {
      name: input.name, youtubeUrl: canonicalUrl, videoId, message: input.message,
      googleAccountId: input.googleAccountId, intervalSeconds: input.intervalSeconds,
      scheduleMode: input.scheduleMode, scheduledStartAt: input.scheduledStartAt ? new Date(input.scheduledStartAt) : null,
      stopMode: input.stopMode, stopValue: input.stopValue, stopAt: input.stopAt ? new Date(input.stopAt) : null,
      maxMessages: input.maxMessages, runUntilStopped: input.runUntilStopped, status: "STOPPED", nextSendAt: null, lastError: null,
    }, include: { googleAccount: true } });
    await activityLog({ automationId: id, action: "AUTOMATION_UPDATED", status: "STOPPED", message: "Automation configuration updated." });
    emitDashboardEvent("automation.updated", automation);
    return Response.json(automation);
  } catch (error) { return apiError(error, "Could not update the automation."); }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await automationController.beforeMutation(id);
    await db.automation.delete({ where: { id } });
    emitDashboardEvent("automation.deleted", { id });
    return Response.json({ ok: true });
  } catch (error) { return apiError(error, "Could not delete the automation."); }
}

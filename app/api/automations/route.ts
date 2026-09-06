import { db } from "@/lib/db/client";
import { parseYouTubeUrl } from "@/lib/browser/youtube-chat";
import { automationInputSchema } from "@/lib/validation/schemas";
import { automationController } from "@/lib/automation/automation-controller";
import { activityLog } from "@/lib/logger/activity-logger";
import { emitDashboardEvent } from "@/lib/events";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await db.automation.findMany({ include: { googleAccount: true }, orderBy: { createdAt: "desc" } }));
}

export async function POST(request: Request) {
  try {
    const raw = await request.json();
    const input = automationInputSchema.parse(raw);
    const account = await db.googleAccount.findUnique({ where: { id: input.googleAccountId } });
    if (!account) return Response.json({ error: "Select a valid connected Google account." }, { status: 400 });
    const { videoId, canonicalUrl } = parseYouTubeUrl(input.youtubeUrl);
    const automation = await db.automation.create({ data: {
      name: input.name, youtubeUrl: canonicalUrl, videoId, message: input.message,
      googleAccountId: input.googleAccountId, intervalSeconds: input.intervalSeconds,
      scheduleMode: input.scheduleMode, scheduledStartAt: input.scheduledStartAt ? new Date(input.scheduledStartAt) : null,
      stopMode: input.stopMode, stopValue: input.stopValue, stopAt: input.stopAt ? new Date(input.stopAt) : null,
      maxMessages: input.maxMessages, runUntilStopped: input.runUntilStopped, status: raw.start ? "STARTING" : "DRAFT",
    }, include: { googleAccount: true } });
    await activityLog({ automationId: automation.id, action: "AUTOMATION_CREATED", status: automation.status, message: "Automation configuration saved.", stream: canonicalUrl });
    emitDashboardEvent("automation.created", automation);
    if (raw.start) await automationController.start(automation.id);
    return Response.json(automation, { status: 201 });
  } catch (error) { return apiError(error, "Could not create the automation."); }
}

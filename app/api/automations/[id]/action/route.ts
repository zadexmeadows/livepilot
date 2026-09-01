import { automationController } from "@/lib/automation/automation-controller";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { action } = await request.json();
    if (action === "start" || action === "resume") return Response.json(await automationController.start(id));
    if (action === "pause") { await automationController.pause(id); return Response.json({ ok: true }); }
    if (action === "stop") { await automationController.stop(id); return Response.json({ ok: true }); }
    return Response.json({ error: "Unsupported automation action." }, { status: 400 });
  } catch (error) { return apiError(error, "Automation action failed."); }
}

import { automationController } from "@/lib/automation/automation-controller";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";
export async function POST() {
  try { return Response.json({ ok: true, stopped: await automationController.stopAll() }); }
  catch (error) { return apiError(error, "Emergency stop did not complete."); }
}

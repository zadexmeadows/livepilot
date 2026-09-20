import { automationController } from "@/lib/automation/automation-controller";
import { apiError } from "@/lib/api";
import { bankWorker } from "@/lib/bank/worker";

export const runtime = "nodejs";
export async function POST() {
  try { const stopped=await automationController.stopAll();await bankWorker.stop();return Response.json({ ok: true, stopped }); }
  catch (error) { return apiError(error, "Emergency stop did not complete."); }
}

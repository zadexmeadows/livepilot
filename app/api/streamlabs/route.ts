import { z } from "zod";
import { automationController } from "@/lib/automation/automation-controller";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() { return Response.json(automationController.streamlabsState()); }

export async function POST(request: Request) {
  try {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Response.json({ error: "Expected application/json." }, { status: 415 });
    const origin = request.headers.get("origin");
    if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && new URL(origin).host !== (request.headers.get("host") || new URL(request.url).host))) return Response.json({ error: "Cross-site mode changes are not allowed." }, { status: 403 });
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await request.json());
    return Response.json(await automationController.setStreamlabsMode(enabled));
  } catch (error) { return apiError(error, "Could not change Streamlabs mode."); }
}

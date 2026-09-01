import { db } from "@/lib/db/client";
import { settingsSchema } from "@/lib/validation/schemas";
import { apiError } from "@/lib/api";
import { emitDashboardEvent } from "@/lib/events";

const defaults = {
  defaultIntervalSeconds: 60, maximumMessagesPerAutomation: 100, browserVisible: true,
  runBrowserMinimized: false, browserExecutablePath: "", dataDirectory: "./data",
  desktopNotifications: true, errorNotifications: true,
};

export const dynamic = "force-dynamic";
export async function GET() {
  const rows = await db.appSetting.findMany();
  const settings = { ...defaults } as Record<string, string | number | boolean>;
  for (const row of rows) {
    if (row.key in defaults) {
      const original = defaults[row.key as keyof typeof defaults];
      settings[row.key] = typeof original === "boolean" ? row.value === "true" : typeof original === "number" ? Number(row.value) : row.value;
    }
  }
  return Response.json(settings);
}

export async function PUT(request: Request) {
  try {
    const settings = settingsSchema.parse(await request.json());
    await db.$transaction(Object.entries(settings).map(([key, value]) => db.appSetting.upsert({ where: { key }, create: { key, value: String(value) }, update: { value: String(value) } })));
    emitDashboardEvent("settings.updated", settings);
    return Response.json(settings);
  } catch (error) { return apiError(error, "Could not save settings."); }
}

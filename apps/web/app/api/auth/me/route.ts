import { getSession } from "@/lib/auth";
import { apiError, json } from "@/lib/api";

export async function GET() {
  const user = await getSession();
  if (!user) return apiError("Unauthorized", 401);
  return json({ user });
}

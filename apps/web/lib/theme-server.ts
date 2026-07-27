import { cookies } from "next/headers";

import { parseThemePreference, THEME_COOKIE_NAME } from "./theme";

export async function readThemePreference() {
  const cookieStore = await cookies();
  return parseThemePreference(cookieStore.get(THEME_COOKIE_NAME)?.value);
}

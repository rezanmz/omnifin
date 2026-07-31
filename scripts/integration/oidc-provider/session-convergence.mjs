export async function waitForSemanticSessionThenCookie({ waitForCookie, waitForSession }) {
  if (typeof waitForSession !== "function" || typeof waitForCookie !== "function") {
    throw new TypeError("session_convergence_callbacks_required");
  }

  const sessionResult = await waitForSession();
  const sessionCookie = await waitForCookie();

  return { sessionCookie, sessionResult };
}

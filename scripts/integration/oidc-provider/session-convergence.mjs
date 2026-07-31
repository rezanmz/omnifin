export async function readSessionFromBrowserOrigin(page) {
  if (!page || typeof page.evaluate !== "function") {
    throw new TypeError("browser_session_page_required");
  }

  return page.evaluate(async () => {
    const response = await fetch("/api/auth/session", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      // The caller retains the bounded status and request ID when JSON is unavailable.
    }
    return {
      body,
      requestId: response.headers.get("x-request-id"),
      status: response.status,
    };
  });
}

export async function waitForSemanticSessionThenCookie({ waitForCookie, waitForSession }) {
  if (typeof waitForSession !== "function" || typeof waitForCookie !== "function") {
    throw new TypeError("session_convergence_callbacks_required");
  }

  const sessionResult = await waitForSession();
  const sessionCookie = await waitForCookie();

  return { sessionCookie, sessionResult };
}

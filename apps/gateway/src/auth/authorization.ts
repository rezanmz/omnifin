import type { Permission, SessionPrincipal } from "@omnifin/contracts/auth";
import { SafeHttpError } from "../http-error.js";

export function hasPermission(
  principal: SessionPrincipal | null | undefined,
  permission: Permission,
) {
  return principal?.permissions.includes(permission) ?? false;
}

export function requirePermission(
  principal: SessionPrincipal | null | undefined,
  permission: Permission,
) {
  if (!principal) {
    throw new SafeHttpError({
      code: "authentication_required",
      message: "Sign in to continue.",
      statusCode: 401,
    });
  }
  if (!hasPermission(principal, permission)) {
    throw new SafeHttpError({
      code: "permission_denied",
      message: "This action is not permitted.",
      statusCode: 403,
    });
  }
  return principal;
}

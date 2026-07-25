import type { FastifyReply } from "fastify";
import type { AppConfig } from "../config.js";

export const SESSION_COOKIE_NAME = "__Host-omnifin_session";
export const LOCAL_SESSION_COOKIE_NAME = "omnifin_local_session";
export const SESSION_CSRF_HEADER = "x-omnifin-csrf";

export function sessionCookieName(config: Pick<AppConfig, "secureCookies">) {
  return config.secureCookies ? SESSION_COOKIE_NAME : LOCAL_SESSION_COOKIE_NAME;
}

function cookieOptions(config: Pick<AppConfig, "secureCookies">) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax" as const,
    secure: config.secureCookies,
  };
}

export function writeSessionCookie(
  reply: FastifyReply,
  config: Pick<AppConfig, "secureCookies">,
  sessionToken: string,
  absoluteExpiresAt: Date,
) {
  reply.setCookie(sessionCookieName(config), sessionToken, {
    ...cookieOptions(config),
    expires: absoluteExpiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Pick<AppConfig, "secureCookies">) {
  reply.clearCookie(sessionCookieName(config), cookieOptions(config));
}

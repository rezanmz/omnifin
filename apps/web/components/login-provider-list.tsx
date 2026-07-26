"use client";

import type { PropsWithChildren } from "react";
import { handleDirectionalFocus } from "../lib/directional-focus";

export function LoginProviderList({ children }: PropsWithChildren) {
  return (
    <ul
      aria-label="Sign-in methods"
      className="login-card__providers"
      onKeyDown={(event) => handleDirectionalFocus(event, { axis: "vertical" })}
    >
      {children}
    </ul>
  );
}

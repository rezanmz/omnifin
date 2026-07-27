"use client";

import type { ReactNode } from "react";

import { handleDirectionalFocus } from "../lib/directional-focus";

export function DirectionalNavigationGroup({
  children,
  className,
}: Readonly<{
  children: ReactNode;
  className: string;
}>) {
  return (
    <div
      className={className}
      onKeyDown={(event) => handleDirectionalFocus(event, { axis: "horizontal" })}
    >
      {children}
    </div>
  );
}

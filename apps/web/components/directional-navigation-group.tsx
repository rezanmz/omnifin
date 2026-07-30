"use client";

import { createElement, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { handleDirectionalFocus, type DirectionalAxis } from "../lib/directional-focus";

export function DirectionalNavigationGroup({
  children,
  className,
  axis = "horizontal",
}: Readonly<{
  axis?: DirectionalAxis;
  children: ReactNode;
  className: string;
}>) {
  return (
    <div className={className} onKeyDown={(event) => handleDirectionalFocus(event, { axis })}>
      {children}
    </div>
  );
}

export function DirectionalNavigationRegion({
  ariaLabel,
  as,
  axis,
  children,
  className,
  liquidGlass = false,
}: Readonly<{
  ariaLabel?: string;
  as: "aside" | "header" | "nav";
  axis: DirectionalAxis;
  children: ReactNode;
  className: string;
  liquidGlass?: boolean;
}>) {
  return createElement(
    as,
    {
      ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
      className,
      ...(liquidGlass ? { "data-liquid-glass": true } : {}),
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) =>
        handleDirectionalFocus(event, { axis }),
    },
    children,
  );
}

import type { SVGProps } from "react";

export type ShellIconName =
  | "bookmark"
  | "calendar"
  | "check"
  | "clipboard"
  | "cloud-off"
  | "compass"
  | "gauge"
  | "library"
  | "search"
  | "settings"
  | "warning";

export function ShellIcon({
  name,
  size = 20,
  strokeWidth = 1.7,
  ...props
}: SVGProps<SVGSVGElement> & {
  name: ShellIconName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {name === "bookmark" ? (
        <path d="M6 4.8A2.8 2.8 0 0 1 8.8 2h6.4A2.8 2.8 0 0 1 18 4.8V22l-6-3.8L6 22z" />
      ) : null}
      {name === "calendar" ? (
        <>
          <path d="M8 2v4M16 2v4M3 10h18" />
          <rect height="18" rx="2" width="18" x="3" y="4" />
          <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
        </>
      ) : null}
      {name === "check" ? (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="m9 12 2 2 4-4" />
        </>
      ) : null}
      {name === "clipboard" ? (
        <>
          <rect height="4" rx="1" width="8" x="8" y="2" />
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2m1 10 2 2 4-4" />
        </>
      ) : null}
      {name === "cloud-off" ? (
        <>
          <path d="M10.94 5.274A7 7 0 0 1 15.71 10h1.79a4.5 4.5 0 0 1 4.222 6.057M18.796 18.81A4.5 4.5 0 0 1 17.5 19H9A7 7 0 0 1 5.79 5.78M2 2l20 20" />
        </>
      ) : null}
      {name === "compass" ? (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" />
        </>
      ) : null}
      {name === "gauge" ? <path d="m12 14 4-4M3.34 19a10 10 0 1 1 17.32 0" /> : null}
      {name === "library" ? <path d="m16 6 4 14M12 6v14M8 8v12M4 4v16" /> : null}
      {name === "search" ? (
        <>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.34-4.34" />
        </>
      ) : null}
      {name === "settings" ? (
        <>
          <path d="M14 17H5M19 7h-9" />
          <circle cx="17" cy="17" r="3" />
          <circle cx="7" cy="7" r="3" />
        </>
      ) : null}
      {name === "warning" ? (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4M12 16h.01" />
        </>
      ) : null}
    </svg>
  );
}

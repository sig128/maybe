import type { SVGProps } from "react";

/** Original line icons, 20px grid, 1.6 stroke. */
const P: Record<string, string> = {
  overview: "M3.5 4.5h5v5h-5zM11.5 4.5h5v3h-5zM11.5 10.5h5v5h-5zM3.5 12.5h5v3h-5z",
  discover: "M10 3.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6zM12.6 7.4l-1.3 3.9-3.9 1.3 1.3-3.9z",
  futures: "M5 16.5V9.2c0-2 1.6-3.6 3.6-3.6H15M15 5.6l-2.4-2.3M15 5.6 12.6 8M5 9.6c0 2 1.6 3.4 3.6 3.4H15M15 13l-2.4-2.3M15 13l-2.4 2.4",
  money: "M3.5 6.2h13v9.3h-13zM3.5 9.2h13M6.5 12.5h3M14 4.5H6",
  agents: "M4.5 6.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9.2l-3.2 2.4v-2.4h0a1.5 1.5 0 0 1-1.5-1.5zM8 9.2h.01M12 9.2h.01",
  rooms: "M4 16.5V7.8L10 3.5l6 4.3v8.7M8 16.5v-4.6h4v4.6",
  activity: "M3 10.5h3l2-5 4 9 2-4h3",
  ops: "M10 3.5v2M10 14.5v2M3.5 10h2M14.5 10h2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M5.4 14.6l1.4-1.4M13.2 6.8l1.4-1.4M10 7.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z",
  settings: "M4 6h8M15 6h1M4 14h1M8 14h8M12.5 4.3v3.4M6.5 12.3v3.4",
  search: "M9 3.8a5.2 5.2 0 1 0 0 10.4 5.2 5.2 0 0 0 0-10.4zM12.8 12.8l3.4 3.4",
  close: "M5.5 5.5l9 9M14.5 5.5l-9 9",
  plus: "M10 4.5v11M4.5 10h11",
  check: "M4.5 10.4l3.4 3.4 7.6-7.6",
  alert: "M10 4l7 12H3zM10 9v3M10 14.2h.01",
  info: "M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM10 9.2v4M10 6.8h.01",
  clock: "M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM10 6.5V10l2.4 1.6",
  lock: "M5.5 9h9v7h-9zM7.5 9V7a2.5 2.5 0 0 1 5 0v2",
  chevronRight: "M8 5l5 5-5 5",
  chevronDown: "M5 8l5 5 5-5",
  chevronLeft: "M12 5l-5 5 5 5",
  external: "M11 4.5h4.5V9M15.5 4.5 9 11M13.5 11.5v4h-9v-9h4",
  undo: "M7.5 6.5 4.5 9.5l3 3M4.5 9.5h7a4 4 0 0 1 0 8h-2",
  redo: "M12.5 6.5l3 3-3 3M15.5 9.5h-7a4 4 0 0 0 0 8h2",
  wallet: "M3.5 6.5h12a1 1 0 0 1 1 1v8h-13zM3.5 6.5l9-2.5v2.5M13 11h.01",
  pause: "M7.5 5v10M12.5 5v10",
  play: "M7 5l8 5-8 5z",
  arrowDown: "M10 4v12M5 11l5 5 5-5",
  arrowUp: "M10 16V4M5 9l5-5 5 5",
  swap: "M5 7.5h10l-3-3M15 12.5H5l3 3",
  trash: "M5 6.5h10M8 6.5V5h4v1.5M6.5 6.5l.7 9h5.6l.7-9",
  copy: "M7 7h8.5v8.5H7zM4.5 12.5V4.5h8",
  more: "M5 10h.01M10 10h.01M15 10h.01",
  branch: "M6 4v12M6 9c0-2.5 2-4 5-4h3M6 12c0 2 2 3.5 5 3.5h3",
  graph: "M5 5h3v3H5zM12 12h3v3h-3zM12 5h3v3h-3zM8 6.5h4M13.5 8v4",
  list: "M7 5.5h9M7 10h9M7 14.5h9M4 5.5h.01M4 10h.01M4 14.5h.01",
  sentence: "M3.5 6h13M3.5 10h9M3.5 14h11",
  sparkle: "M10 3.5l1.6 4.9L16.5 10l-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z",
  shield: "M10 3.5l5.5 2v4.3c0 3.3-2.3 5.8-5.5 6.7-3.2-.9-5.5-3.4-5.5-6.7V5.5z",
  power: "M10 3.5v6M6.2 6.2a5.5 5.5 0 1 0 7.6 0",
  time: "M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM10 6.5V10h3",
  dot: "M10 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z",
  filter: "M4 5.5h12l-4.5 5.2v4.3l-3 1.5v-5.8z",
  keyboard: "M3.5 6h13v8h-13zM6 9h.01M9 9h.01M12 9h.01M14.5 9h.01M7 11.8h6",
  refresh: "M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.5 4v3.4h-3.4",
  odds: "M5.5 14.5l9-9M6.8 4.8a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2zM13.2 12a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z",
  x: "M4.5 4.5l4.7 5.9-4.7 5.1M15.5 4.5l-4.7 5.1 4.7 5.9M4.5 4.5h3l8 11h-3z",
  telegram: "M16.5 4.2 3.6 9.2c-.6.2-.6 1 0 1.2l3.3 1.1 1.3 4c.2.5.8.6 1.1.2l1.9-2.1 3.3 2.4c.4.3 1 .1 1.1-.4l2.1-10.4c.1-.6-.5-1.1-1.2-.8zM6.9 11.5l7.1-4.4-5.2 5.5",
  globe: "M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM3.5 10h13M10 3.5c1.8 1.9 2.7 4.1 2.7 6.5s-.9 4.6-2.7 6.5c-1.8-1.9-2.7-4.1-2.7-6.5s.9-4.6 2.7-6.5z",
  bolt: "M11 3.5 5 11h4.5L8.8 16.5 15 9h-4.5z",
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={P[name]} />
    </svg>
  );
}

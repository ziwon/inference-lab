import type { ReactNode } from 'react';

// Minimal inline icon set (no icon dependency). Icons are decorative; buttons carry labels.

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const Icon = {
  play: () => <Svg><path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" /></Svg>,
  pause: () => <Svg><path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth={2.2} /></Svg>,
  prev: () => <Svg><path d="M4 3.5v9M12 3.5 6.5 8l5.5 4.5z" /></Svg>,
  next: () => <Svg><path d="M12 3.5v9M4 3.5 9.5 8 4 12.5z" /></Svg>,
  reset: () => <Svg><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 2.8v2.6h2.6" /></Svg>,
  end: () => <Svg><path d="M3.5 3.5 9 8l-5.5 4.5zM12.5 3.5v9" /></Svg>,
  share: () => <Svg><path d="M6.5 9.5 9.5 6.5M7 4.5l1.2-1.2a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.2 1.2a2.5 2.5 0 0 1-3.5-3.5L5.5 8" /></Svg>,
  download: () => <Svg><path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13.5h10" /></Svg>,
  upload: () => <Svg><path d="M8 10.5v-8M4.8 5.7 8 2.5l3.2 3.2M3 13.5h10" /></Svg>,
  zoomIn: () => <Svg><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14M5 7h4M7 5v4" /></Svg>,
  zoomOut: () => <Svg><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14M5 7h4" /></Svg>,
  fit: () => <Svg><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></Svg>,
  keyboard: () => <Svg><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6" /></Svg>,
  info: () => <Svg><circle cx="8" cy="8" r="6" /><path d="M8 7.2v3.8M8 5h.01" /></Svg>,
  close: () => <Svg><path d="M4 4l8 8M12 4l-8 8" /></Svg>,
  sliders: () => <Svg><path d="M3 4.5h10M3 11.5h10" /><circle cx="6" cy="4.5" r="1.6" fill="var(--surface)" /><circle cx="10" cy="11.5" r="1.6" fill="var(--surface)" /></Svg>,
};

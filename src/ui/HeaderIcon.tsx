const PATHS = {
  model: 'M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 0 0 0-12.5zM8 7.25v4M8 4.75v.25',
  keyboard: 'M1.75 4h12.5v8H1.75zM4.25 6.75h.5M7.25 6.75h1.5M11.25 6.75h.5M4.25 9.25h7.5',
  import: 'M8 10V2.5M5 5.25l3-3 3 3M2.5 10.5v3h11v-3',
  export: 'M8 2.5V10M5 7l3 3 3-3M2.5 10.5v3h11v-3',
  share: 'M6.5 9.5l3-3M7.25 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M8.75 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1',
} as const;

export type HeaderIconName = keyof typeof PATHS;

export const BrandMark = () => (
  <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4v16h16M8 8h5M10 12h8M8 16h4" />
  </svg>
);

export const HeaderIcon = ({ name }: { name: HeaderIconName }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d={PATHS[name]} />
  </svg>
);

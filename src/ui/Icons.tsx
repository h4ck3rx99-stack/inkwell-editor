import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const IconSidebar = (p: IconProps) => (
  <Svg {...p}><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11" /></Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M8 3.5v9M3.5 8h9" /></Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="7" cy="7" r="4" /><path d="M10 10l3 3" /></Svg>
);
export const IconList = (p: IconProps) => (
  <Svg {...p}><path d="M5.5 4.5h7M5.5 8h7M5.5 11.5h7" /><circle cx="3" cy="4.5" r=".6" fill="currentColor" /><circle cx="3" cy="8" r=".6" fill="currentColor" /><circle cx="3" cy="11.5" r=".6" fill="currentColor" /></Svg>
);
export const IconSettings = (p: IconProps) => (
  <Svg {...p}><path d="M3 4.5h6M11.5 4.5H13M3 11.5h1.5M7 11.5h6" /><circle cx="10.2" cy="4.5" r="1.3" /><circle cx="5.7" cy="11.5" r="1.3" /></Svg>
);
export const IconFocus = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" /><path d="M5.5 8h5" /></Svg>
);
export const IconClose = (p: IconProps) => (
  <Svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></Svg>
);
export const IconTrash = (p: IconProps) => (
  <Svg {...p}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></Svg>
);
export const IconDoc = (p: IconProps) => (
  <Svg {...p}><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></Svg>
);
export const IconCommand = (p: IconProps) => (
  <Svg {...p}><path d="M6 6h4v4H6z" /><path d="M6 6V4.5A1.5 1.5 0 1 0 4.5 6H6M10 6V4.5A1.5 1.5 0 1 1 11.5 6H10M6 10v1.5A1.5 1.5 0 1 1 4.5 10H6M10 10v1.5a1.5 1.5 0 1 0 1.5-1.5H10" /></Svg>
);
export const IconKeyboard = (p: IconProps) => (
  <Svg {...p}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6" /></Svg>
);
export const IconChevron = (p: IconProps) => (
  <Svg {...p}><path d="M6 4l4 4-4 4" /></Svg>
);
export const IconCopy = (p: IconProps) => (
  <Svg {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" /><path d="M10.5 5.5V3.7c0-.7-.5-1.2-1.2-1.2H3.7c-.7 0-1.2.5-1.2 1.2v5.6c0 .7.5 1.2 1.2 1.2h1.8" /></Svg>
);
export const IconPen = (p: IconProps) => (
  <Svg {...p}><path d="M10.5 2.5l3 3-7.5 7.5H3v-3z" /><path d="M9 4l3 3" /></Svg>
);

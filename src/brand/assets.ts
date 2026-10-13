// Standalone SVG brand assets (mono / light / dark variants) for reuse outside React.
const mark = (ring: string, a: string, b: string, ink: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><defs><linearGradient id="g" x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><path d="M24.5 8.2A11 11 0 1 0 27 16" stroke="${ring}" stroke-width="3.2" stroke-linecap="round"/><path d="M11 19.5 16 12.5l5 4" stroke="${ink}" stroke-opacity=".55" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11" cy="19.5" r="2.3" fill="${ink}"/><circle cx="16" cy="12.5" r="2.3" fill="${a}"/><circle cx="21" cy="16.5" r="2.3" fill="${b}"/><circle cx="27" cy="9" r="1.6" fill="${b}"/></svg>`

export const brandSvg = {
  markDark: mark('url(#g)', '#8b7dff', '#4ee6d2', '#e9ebf1'),
  markLight: mark('url(#g)', '#5a48ee', '#0aa596', '#12141b'),
  markMono: mark('currentColor', 'currentColor', 'currentColor', 'currentColor'),
}

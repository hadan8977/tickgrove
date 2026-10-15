import geometry from "./mark.json";

// The same vector master powers the React mark and standalone exports.
const mark = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${geometry.viewBox}" role="img" aria-label="Tickgrove"><title>Tickgrove</title><path d="${geometry.path}" fill="${color}"/></svg>`;

export const brandSvg = {
  markDark: mark("#b2f0cc"),
  markLight: mark("#236449"),
  markMono: mark("currentColor"),
};

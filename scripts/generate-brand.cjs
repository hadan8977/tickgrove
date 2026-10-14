// Deterministic SVG assets. Geometry is shared with the React logo; no raster dependencies.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const mark = JSON.parse(fs.readFileSync(path.join(root, 'src/brand/mark.json'), 'utf8'));
const wordmark = JSON.parse(fs.readFileSync(path.join(root, 'src/brand/wordmark.json'), 'utf8'));
const lettering = color => wordmark.glyphs.map(g => `<path transform="translate(${g.x} ${g.y})" fill="${color}" d="${g.path}"/>`).join('');
const shapes = (color) => `<path d="${mark.stems}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="${mark.bodies}" fill="${color}"/>`;
const svg = (box, body, label='Tickgrove') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" role="img" aria-label="${label}"><title>${label}</title>${body}</svg>\n`;
const directory = path.join(root, 'public/brand');fs.mkdirSync(directory,{recursive:true});
for (const [file,color] of [['tickgrove-mark.svg','#236449'],['tickgrove-mark-mono.svg','#17241d'],['tickgrove-mark-inverse.svg','#9de2b6']]) fs.writeFileSync(path.join(directory,file),svg(mark.viewBox,shapes(color)));
const icon=svg('0 0 40 40',`<rect width="40" height="40" rx="10" fill="#163f30"/><g transform="translate(4 3)">${shapes('#a1e5ba')}</g>`);
fs.writeFileSync(path.join(root,'public/favicon.svg'),icon);fs.writeFileSync(path.join(directory,'tickgrove-icon.svg'),icon);
for (const [mode,background,foreground,accent] of [['light','#f6f7f2','#17241d','#236449'],['dark','#111c17','#edf3ed','#9de2b6']]) {
  const body=`<rect width="480" height="144" rx="20" fill="${background}"/><g transform="translate(40 36) scale(2)">${shapes(accent)}</g><g transform="translate(130 88) scale(${47/wordmark.unitsPerEm} ${-47/wordmark.unitsPerEm})">${lettering(foreground)}</g>`;
  fs.writeFileSync(path.join(directory,`tickgrove-lockup-${mode}.svg`),svg('0 0 480 144',body));
}
console.log('Generated Tickgrove SVG assets from src/brand/mark.json');

fs.writeFileSync(path.join(directory,'tickgrove-wordmark.svg'),svg(`0 0 ${Math.ceil(wordmark.advance)} ${wordmark.unitsPerEm*1.2}`,`<g transform="translate(0 ${wordmark.unitsPerEm*.9}) scale(1 -1)">${lettering('#17241d')}</g>`));

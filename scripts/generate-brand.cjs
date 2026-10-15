// Deterministic brand assets. React, favicon, lockups and social exports share one vector master.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const mark = JSON.parse(fs.readFileSync(path.join(root, 'src/brand/mark.json'), 'utf8'));
const wordmark = JSON.parse(fs.readFileSync(path.join(root, 'src/brand/wordmark.json'), 'utf8'));
const lettering = color => wordmark.glyphs.map(g => `<path transform="translate(${g.x} ${g.y})" fill="${color}" d="${g.path}"/>`).join('');
const shapes = color => `<path d="${mark.path}" fill="${color}"/>`;
const svg = (box, body, label='Tickgrove') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" role="img" aria-label="${label}"><title>${label}</title>${body}</svg>\n`;
const directory = path.join(root, 'public/brand'); fs.mkdirSync(directory,{recursive:true});
for (const [file,color] of [['tickgrove-mark.svg','#236449'],['tickgrove-mark-mono.svg','#17241d'],['tickgrove-mark-inverse.svg','#b2f0cc']])
  fs.writeFileSync(path.join(directory,file),svg(mark.viewBox,shapes(color)));
const icon=svg('0 0 40 40',`<rect width="40" height="40" rx="10" fill="#153f32"/><g transform="translate(6 6) scale(.875)">${shapes('#b2f0cc')}</g>`);
fs.writeFileSync(path.join(root,'public/favicon.svg'),icon);
fs.writeFileSync(path.join(directory,'tickgrove-icon.svg'),icon);
for (const [mode,foreground,accent] of [['light','#17241d','#236449'],['dark','#edf3ed','#b2f0cc']]) {
  const body=`<g transform="translate(20 20) scale(2)">${shapes(accent)}</g><g transform="translate(106 69) scale(${47/wordmark.unitsPerEm} ${-47/wordmark.unitsPerEm})">${lettering(foreground)}</g>`;
  fs.writeFileSync(path.join(directory,`tickgrove-lockup-${mode}.svg`),svg('0 0 390 104',body));
}
fs.writeFileSync(path.join(directory,'tickgrove-wordmark.svg'),svg(`0 0 ${Math.ceil(wordmark.advance)} ${wordmark.unitsPerEm*1.2}`,`<g transform="translate(0 ${wordmark.unitsPerEm*.9}) scale(1 -1)">${lettering('#17241d')}</g>`));
const fontData = fs.readFileSync(path.join(root, 'public/fonts/geist-latin.woff2')).toString('base64');
const social=svg('0 0 1200 630',`<style>@font-face{font-family:Geist;src:url(data:font/woff2;base64,${fontData})}text{font-family:Geist,sans-serif}</style><rect width="1200" height="630" fill="#f4f4ee"/><g transform="translate(76 88) scale(3)">${shapes('#236449')}</g><g transform="translate(202 163) scale(${73/wordmark.unitsPerEm} ${-73/wordmark.unitsPerEm})">${lettering('#17241d')}</g><text x="82" y="308" fill="#17241d" font-family="Arial, sans-serif" font-size="52" letter-spacing="-1.5">Your market workspace.</text><text x="84" y="366" fill="#637168" font-family="Arial, sans-serif" font-size="26">Charts, Pine scripts, backtests and paper trading.</text><path d="M84 488H1116" stroke="#d6ddd3"/><text x="84" y="542" fill="#236449" font-family="Arial, sans-serif" font-size="18" letter-spacing="2">OPEN SOURCE / SELF HOSTED</text><g transform="translate(890 350) scale(6)">${shapes('#dce7db')}</g>`);
fs.writeFileSync(path.join(directory,'tickgrove-social.svg'),social);
console.log('Generated Tickgrove vector identity from src/brand/mark.json');

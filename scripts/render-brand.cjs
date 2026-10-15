// Optional design export tooling; no browser dependency in the application runtime.
// PLAYWRIGHT_MODULE=/path/to/playwright BROWSER_EXECUTABLE=/path/to/chromium node scripts/render-brand.cjs
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'public/brand', name), 'utf8');
(async () => {
 const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox'] });
 const page = await browser.newPage({ deviceScaleFactor: 1 });
 try {
  for (const [source, output, width, height] of [['tickgrove-icon.svg','public/brand/tickgrove-avatar.png',512,512],['tickgrove-social.svg','public/brand/tickgrove-social.png',1200,630]]) {
   await page.setViewportSize({width,height});
   await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style>${read(source)}`);
   await page.evaluate(() => document.fonts.ready);
   await page.screenshot({path:path.join(root,output),omitBackground:true});
  }
  const font = fs.readFileSync(path.join(root,'public/fonts/geist-latin.woff2')).toString('base64');
  const mark = read('tickgrove-mark-mono.svg');
  await page.setViewportSize({width:1440,height:900});
  await page.setContent(`<style>@font-face{font-family:Geist;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}body{margin:0;background:#f4f4ee;color:#17241d;font-family:Geist,sans-serif;padding:64px 80px}header{display:flex;justify-content:space-between;font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:#687269}.hero{height:430px;display:flex;align-items:center;gap:96px}.hero>svg{width:260px;height:260px;fill:#17241d}.hero h1{font-weight:600;font-size:84px;letter-spacing:-.055em;margin:0}.hero p{font-size:19px;color:#687269;margin-top:18px;line-height:1.6}.samples{border-top:1px solid #d5dcd1;display:flex;padding-top:42px;gap:38px;align-items:center}.tile{width:180px;height:180px;border-radius:32px;display:grid;place-items:center;background:#153f32}.tile svg{width:100px;height:100px}.sizes{display:flex;align-items:end;gap:32px;margin-left:60px}.size{text-align:center;color:#687269;font-size:11px}.size svg{display:block;margin:0 auto 20px}.caption{margin-top:42px;color:#687269;font-size:12px;letter-spacing:.05em}</style><header><span>Tickgrove / Identity</span><span>01 · Open structure</span></header><div class="hero">${mark}<div><h1>Tickgrove</h1><p>Your market workspace.<br>Open source. Self hosted. Yours to extend.</p></div></div><div class="samples"><div class="tile">${read('tickgrove-mark-inverse.svg')}</div><div class="tile" style="background:#e6ebdf">${read('tickgrove-mark.svg')}</div><div class="sizes">${[16,24,32,48,64].map(size=>`<div class="size">${mark.replace('<svg ','<svg width="'+size+'" height="'+size+'" ')}${size}px</div>`).join('')}</div></div><div class="caption">One vector master · Monochrome first · Geist typography · Forest / Mint / Ivory</div>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({path:path.join(root,'docs/images/tickgrove-brand.png')});
 } finally { await browser.close(); }
 console.log('Rendered avatar, social preview and identity board from vector masters.');
})().catch(e=>{console.error(e);process.exitCode=1});

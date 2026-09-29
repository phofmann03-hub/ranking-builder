// End-to-End-Test mit Playwright/Chromium.
// Aufruf: node tests/e2e.mjs <fixture-dir> <out-dir>
// Erwartet im fixture-dir: c1_landscape.webm, c2_portrait.mp4, c3_short_noaudio.webm, c4_full.webm
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [fixtures, outDir] = process.argv.slice(2).map((p) => path.resolve(p));
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(0);
const port = server.address().port;

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
page.on('console', (m) => console.log('  [browser]', m.type(), m.text()));
page.on('pageerror', (e) => { console.log('  [pageerror]', e.message); failures++; });

await page.goto(`http://localhost:${port}/`);
await page.fill('#title', 'Top 4 Testclips mit einem langen Titel');
await page.setInputFiles('#fileInput', ['c1_landscape.webm', 'c2_portrait.mp4', 'c3_short_noaudio.webm', 'c4_full.webm'].map((f) => path.join(fixtures, f)));
await page.waitForFunction(() => window.__rvb.state.clips.every((c) => c.srcDuration !== null || c.loadError), null, { timeout: 30000 });

const places = () => page.$$eval('.place-input', (xs) => xs.map((x) => x.value));
check(JSON.stringify(await places()) === '["4","3","2","1"]', 'Automatische Countdown-Plätze 4,3,2,1');
check((await page.textContent('#totalTime')) === '0:25', `Gesamtlänge 0:25 (7+7+4+7) – ist ${await page.textContent('#totalTime')}`);
check(await page.isVisible('#totalWarn'), 'Warnung unter 61 s sichtbar');
check((await page.$$eval('.clip-info.short', (x) => x.length)) === 1, 'Kurzer Clip (4 s) markiert');
check((await page.$$eval('.thumb img', (x) => x.length)) === 4, 'Vorschaubilder erzeugt');
await page.screenshot({ path: path.join(outDir, 'ui-list.png'), fullPage: true });

const order = () => page.evaluate(() => window.__rvb.state.clips.map((c) => c.file.name[1]).join(''));
// Pfeiltasten-Buttons
await page.click('.clip:nth-child(1) .down');
check((await order()) === '2134', `Pfeil ▼ verschiebt (Reihenfolge ${await order()})`);
check(JSON.stringify(await places()) === '["4","3","2","1"]', 'Plätze nach Verschieben neu nummeriert');
await page.click('.clip:nth-child(2) .up');
check((await order()) === '1234', 'Pfeil ▲ verschiebt zurück');

// Drag & Drop per Griff: Clip 1 unter Clip 3 ziehen
await page.evaluate(() => document.querySelector('.clip:nth-child(1)').scrollIntoView({ block: 'center' }));
const h = await page.$('.clip:nth-child(1) .handle');
const hb = await h.boundingBox();
const c3 = await (await page.$('.clip:nth-child(2)')).boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + 20);
await page.mouse.down();
for (let i = 1; i <= 20; i++) {
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 20 + ((c3.y + c3.height * 0.8 - hb.y) * i) / 20);
  await page.waitForTimeout(16);
}
await page.mouse.up();
check((await order()) === '2134', `Drag & Drop verschiebt (Reihenfolge ${await order()})`);

// Zurück per Tastatur (Pfeiltasten am Griff)
await page.focus('.clip:nth-child(2) .handle');
await page.keyboard.press('ArrowUp');
check((await order()) === '1234', `Tastatur-Pfeile am Griff (Reihenfolge ${await order()})`);

// Touch-Drag (wie iPhone) über CDP: Clip 4 ganz nach oben ziehen (mit Auto-Scroll)
{
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => document.querySelector('.clip:nth-child(4)').scrollIntoView({ block: 'end' }));
  const tb = await (await page.$('.clip:nth-child(4) .handle')).boundingBox();
  const x = tb.x + tb.width / 2;
  let y = tb.y + 20;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  // nach oben an den Rand ziehen und dort halten, damit Auto-Scroll läuft
  while (y > 100) { y -= 25; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await page.waitForTimeout(16); }
  for (let i = 0; i < 150 && (await page.evaluate(() => window.scrollY)) > 0; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (i % 2) }] });
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(300);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 60 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check((await order()) === '4123', `Touch-Drag mit Auto-Scroll (Reihenfolge ${await order()})`);
  await page.click('.clip:nth-child(1) .down');
  await page.click('.clip:nth-child(2) .down');
  await page.click('.clip:nth-child(3) .down');
  check((await order()) === '1234', 'Zurück sortiert');
}

// Namen, Dauer, Startzeit
const names = ['Bugatti Chiron Super Sport', 'Koenigsegg Jesko', 'SSC Tuatara', 'Rimac Nevera'];
for (let i = 0; i < 4; i++) await page.fill(`.clip:nth-child(${i + 1}) .name-input`, names[i]);
await page.fill('.clip:nth-child(4) .start-input', '3');
await page.fill('.clip:nth-child(2) .dur-input', '5');
check((await page.textContent('#totalTime')) === '0:23', `Dauer-Änderung wirkt (0:23) – ist ${await page.textContent('#totalTime')}`);

// Manueller Platz schaltet Automatik aus
await page.fill('.clip:nth-child(1) .place-input', '10');
check(!(await page.isChecked('#autoPlaces')), 'Manueller Platz schaltet Automatik aus');

// Vorschau starten und abbrechen
await page.click('#previewBtn');
await page.waitForTimeout(2500);
check(await page.isVisible('#renderView'), 'Vorschau läuft');
check((await page.textContent('#progressText')).startsWith('Clip 1 von 4'), 'Vorschau-Fortschritt');
await page.click('#cancelBtn');
await page.waitForTimeout(300);
check(!(await page.isVisible('#renderView')), 'Vorschau beendet');

// Export
const t0 = Date.now();
await page.click('#exportBtn');
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(outDir, 'ui-render.png') });
await page.waitForSelector('#resultView:not([hidden])', { timeout: 90000 });
const secs = (Date.now() - t0) / 1000;
console.log(`  Export dauerte ${secs.toFixed(1)} s`);
await page.screenshot({ path: path.join(outDir, 'ui-result.png') });
const info = await page.textContent('#resultInfo');
console.log('  Ergebnis:', info);
const b64 = await page.evaluate(async () => {
  const r = await fetch(document.getElementById('downloadLink').href);
  const buf = new Uint8Array(await r.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
});
const dl = await page.getAttribute('#downloadLink', 'download');
const out = path.join(outDir, dl);
fs.writeFileSync(out, Buffer.from(b64, 'base64'));
console.log('  Datei:', out, fs.statSync(out).size, 'Bytes');
check(fs.statSync(out).size > 100000, 'Video-Datei nicht leer');

await browser.close();
server.close();
console.log(failures ? `\n${failures} Fehler` : '\nAlle Checks bestanden');
process.exit(failures ? 1 : 0);

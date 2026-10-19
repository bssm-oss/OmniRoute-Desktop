// Renders build/icon.svg to build/icon.png (1024) + build/icon.ico (16..256) without extra deps.
// Usage: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const BUILD = path.join(__dirname, '..', 'build');
const SVG = path.join(BUILD, 'icon.svg');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function render(win, size) {
  const svg = fs.readFileSync(SVG, 'utf8');
  const html = `<html><body style="margin:0;background:transparent">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`;
  win.setContentSize(size, size);
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 150));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, frame: false, transparent: true, useContentSize: true,
    width: 256, height: 256, webPreferences: { offscreen: true } });
  try {
    fs.writeFileSync(path.join(BUILD, 'icon.png'), await render(win, 1024));
    const pngs = [];
    for (const size of ICO_SIZES) pngs.push({ size, data: await render(win, size) });
    fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(pngs));
    fs.writeFileSync(path.join(BUILD, 'icon-256.png'), pngs[pngs.length - 1].data);
    console.log('icon.png, icon.ico written to', BUILD);
  } catch (e) { console.error(e); process.exitCode = 1; }
  app.quit();
});

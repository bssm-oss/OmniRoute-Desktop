// Multi-monitor computer-use check (runs inside Electron, isolated profile):
//   electron scripts/test-multimonitor.js
// Verifies: all displays enumerated, "all" composite covers every display, per-display capture,
// and that moving to the center of each display region lands on the right physical point.
process.env.OMNI_PROFILE = process.env.OMNI_PROFILE || 'mmtest';
const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
app.setName('OmniRoute MM Test');
app.setPath('userData', path.join(app.getPath('appData'), 'omniroute-desktop-mmtest'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const computer = require('../src/computer');
  const out = { checks: [], errors: [] };
  const check = (name, ok, detail) => {
    out.checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
    if (!ok) out.errors.push(name);
  };
  try {
    // composite unit check: two 2x1 images side by side with an offset
    const red = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255, 0, 0, 255, 255]), { width: 2, height: 1 });
    const blue = nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255, 255, 0, 0, 255]), { width: 2, height: 1 });
    const c = computer._composite([{ img: red, x: 0, y: 0 }, { img: blue, x: 2, y: 1 }], 4, 2).toBitmap();
    check('composite blit', c[2] === 255 && c[0] === 0 && c[(1 * 4 + 2) * 4] === 255 && c[(0 * 4 + 2) * 4 + 2] === 0);

    const displays = computer.listDisplays();
    out.displays = displays.map((d) => ({ index: d.index, primary: d.primary, rect: d.rect, phys: `${d.physW}x${d.physH}`, sf: d.display.scaleFactor }));
    check('displays enumerated', displays.length >= 1, `${displays.length} display(s)`);

    // "all" screenshot
    const all = await computer.perform({ action: 'screenshot', display: displays.length > 1 ? 'all' : 0 });
    out.allText = all.text;
    const img = nativeImage.createFromDataURL(all.image);
    const sz = img.getSize();
    check('all screenshot size matches reported', all.text.includes(`${sz.width}x${sz.height}`), `${sz.width}x${sz.height}`);
    if (displays.length > 1) {
      // Every display region of the composite should contain non-black pixels (actually captured).
      const bmp = img.toBitmap();
      const union = {
        x: Math.min(...displays.map((d) => d.rect.x)),
        y: Math.min(...displays.map((d) => d.rect.y)),
        r: Math.max(...displays.map((d) => d.rect.x + d.rect.width)),
        b: Math.max(...displays.map((d) => d.rect.y + d.rect.height))
      };
      const s = sz.width / (union.r - union.x);
      for (const d of displays) {
        const x0 = Math.round((d.rect.x - union.x) * s);
        const y0 = Math.round((d.rect.y - union.y) * s);
        const w = Math.round(d.rect.width * s);
        const h = Math.round(d.rect.height * s);
        let lit = 0;
        let n = 0;
        for (let yy = y0 + 2; yy < y0 + h - 2; yy += Math.max(1, Math.floor(h / 40))) {
          for (let xx = x0 + 2; xx < x0 + w - 2; xx += Math.max(1, Math.floor(w / 40))) {
            const i = (yy * sz.width + xx) * 4;
            n++;
            if (bmp[i] + bmp[i + 1] + bmp[i + 2] > 30) lit++;
          }
        }
        check(`display ${d.index} visible in composite`, lit / n > 0.2, `${Math.round((100 * lit) / n)}% non-black`);
      }
      fs.writeFileSync(path.join(app.getPath('temp'), 'omniroute-mm-all.jpg'), img.toJPEG(70));
    }

    // Move to the center of each display (in "all" coordinates) and verify physical cursor position.
    for (const d of displays) {
      await computer.perform({ action: 'screenshot', display: displays.length > 1 ? 'all' : 0 });
      const L = displays.length > 1 ? null : null;
      void L;
      const cx = d.rect.x + Math.floor(d.rect.width / 2);
      const cy = d.rect.y + Math.floor(d.rect.height / 2);
      const [sx, sy] = computer.fromScreen(cx, cy);
      await computer.perform({ action: 'move', x: sx, y: sy });
      await sleep(30);
      const pos = await computer.perform({ action: 'cursor_position' });
      const m = /\((-?\d+), (-?\d+)\)/.exec(pos.text);
      const ok = m && Math.abs(Number(m[1]) - sx) <= 2 && Math.abs(Number(m[2]) - sy) <= 2;
      check(`move to display ${d.index} center via "all" coords`, ok, `target (${sx},${sy}) got ${pos.text}`);
    }

    // Per-display screenshot + mapping
    for (const d of displays) {
      const shot = await computer.perform({ action: 'screenshot', display: String(d.index) });
      const im = nativeImage.createFromDataURL(shot.image).getSize();
      check(`display ${d.index} screenshot`, im.width > 0 && shot.text.includes(`display ${d.index}`), `${im.width}x${im.height}`);
      await computer.perform({ action: 'move', x: 40, y: 40 });
      await sleep(30);
      const pos = await computer.perform({ action: 'cursor_position' });
      const m = /\((-?\d+), (-?\d+)\)/.exec(pos.text);
      check(`move inside display ${d.index} (40,40)`, m && Math.abs(Number(m[1]) - 40) <= 2 && Math.abs(Number(m[2]) - 40) <= 2, pos.text);
    }
  } catch (e) {
    out.errors.push('exception: ' + e.stack);
  }
  process.stdout.write('MM_RESULT ' + JSON.stringify(out, null, 2) + '\n');
  computer.shutdown();
  app.exit(out.errors.length ? 1 : 0);
});

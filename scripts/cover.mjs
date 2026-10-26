// Generates cover.png (800x534) for gladys-maxcube: plain Node, no dependency.
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
// Background: diagonal gradient, deep slate blue to warm grey.
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [30 + 40 * t, 45 + 50 * t, 90 + 30 * t]);
  }
}
const white = [255, 255, 255];
const amber = [255, 190, 50];
const orange = [250, 120, 50];
const dark = [35, 40, 60];
const grey = [215, 220, 230];
const green = [90, 210, 150];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const ring = (cx, cy, r, width, color, from = -Math.PI, to = Math.PI) => {
  for (let y = Math.floor(cy - r - width); y <= cy + r + width; y += 1) {
    for (let x = Math.floor(cx - r - width); x <= cx + r + width; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      const angle = Math.atan2(y - cy, x - cx);
      if (angle < from || angle > to) continue;
      const a = Math.max(0, Math.min(1, width / 2 - Math.abs(d - r) + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};
const roundRect = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};

// Soft halos.
disc(250, 280, 220, white, 0.06);
disc(600, 260, 180, white, 0.05);
// The Cube: a white rounded cube seen in isometric view (three faces).
const cube = (cx, cy, s) => {
  // Top face (lighter), left and right faces.
  const top = [
    [cx, cy - s],
    [cx + s, cy - s / 2],
    [cx, cy],
    [cx - s, cy - s / 2],
  ];
  const left = [
    [cx - s, cy - s / 2],
    [cx, cy],
    [cx, cy + s],
    [cx - s, cy + s / 2],
  ];
  const right = [
    [cx, cy],
    [cx + s, cy - s / 2],
    [cx + s, cy + s / 2],
    [cx, cy + s],
  ];
  const poly = (points, color) => {
    const ys = points.map((p) => p[1]);
    const xs = points.map((p) => p[0]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.max(...ys); y += 1) {
      for (let x = Math.floor(Math.min(...xs)); x <= Math.max(...xs); x += 1) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
          const [xi, yi] = points[i];
          const [xj, yj] = points[j];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) set(x, y, color);
      }
    }
  };
  poly(top, white);
  poly(left, grey);
  poly(right, [180, 188, 200]);
  // The green status light of the Cube on the left face.
  disc(cx - s / 2, cy + s / 2, 9, green);
};
cube(560, 300, 120);
// Radio waves from the Cube.
for (const r of [150, 180, 210]) ring(560, 240, r, 6, white, -Math.PI * 0.85, -Math.PI * 0.45);
// A radiator thermostat: the round white dial with the setpoint arc and a valve body.
disc(230, 250, 130, white);
disc(230, 250, 102, dark);
ring(230, 250, 86, 12, [80, 90, 120], -Math.PI, Math.PI);
ring(230, 250, 86, 12, orange, -Math.PI * 0.95, -Math.PI * 0.1);
disc(230 + 86 * Math.cos(-Math.PI * 0.1), 250 + 86 * Math.sin(-Math.PI * 0.1), 10, white);
// "21.5" shown as amber bars (a seven-segment feel).
roundRect(190, 236, 206, 266, 3, amber);
roundRect(214, 236, 246, 266, 3, amber);
disc(256, 262, 4, amber);
roundRect(266, 236, 282, 266, 3, amber);
// The valve body below the dial.
roundRect(195, 380, 265, 470, 18, white);
roundRect(170, 455, 290, 490, 12, grey);
// A window contact (small white bar with a magnet) bottom right.
roundRect(640, 420, 700, 500, 12, white);
roundRect(708, 440, 730, 480, 6, white);
disc(670, 445, 6, green);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');

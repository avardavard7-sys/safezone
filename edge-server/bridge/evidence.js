import sharp from 'sharp';

const W = 640;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = ms => new Date(ms).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Almaty' });

async function panel(frame, marks, label, color) {
  const img = sharp(frame).resize({ width: W });
  const { height: H } = await img.metadata().then(m => ({ height: Math.round((m.height / m.width) * W) }));
  const px = (x, y) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`;
  const shapes = marks.map(m => {
    if (m.poly) {
      const c = m.color || '#F59E0B';
      return `<polygon points="${m.poly.map(([x, y]) => px(x, y)).join(' ')}" fill="${c}" fill-opacity="0.16" stroke="${c}" stroke-width="3"/>`
        + (m.label ? `<text x="${(m.poly[0][0] * W + 6).toFixed(1)}" y="${(m.poly[0][1] * H + 20).toFixed(1)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="16" font-weight="bold" fill="${c}">${esc(m.label)}</text>` : '');
    }
    if (m.box) return `<rect x="${m.box.x1 * W}" y="${m.box.y1 * H}" width="${(m.box.x2 - m.box.x1) * W}" height="${(m.box.y2 - m.box.y1) * H}" fill="none" stroke="${color}" stroke-width="3" rx="4"/>`;
    if (m.point) return `<circle cx="${m.point.x * W}" cy="${m.point.y * H}" r="14" fill="none" stroke="${color}" stroke-width="4"/>`;
    return '';
  }).join('');
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${shapes}
    <rect x="0" y="0" width="${W}" height="38" fill="rgba(0,0,0,0.65)"/>
    <text x="12" y="26" font-family="DejaVu Sans, Arial, sans-serif" font-size="20" font-weight="bold" fill="${color}">${esc(label)}</text></svg>`;
  return { buf: await img.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 82 }).toBuffer(), H };
}

/** Снимок для охраны: слева — момент у полки, справа — рука у кармана. */
export async function concealmentEvidence(alert, concealFrame) {
  const right = await panel(concealFrame, [{ box: alert.conceal.box }, { point: alert.conceal.point }],
    `2 · рука ${alert.spot === 'карман' ? 'у кармана' : 'под одежду'} · ${clock(alert.conceal.at)}`, '#EF4444');
  if (!alert.reach.frame) return right.buf;
  const left = await panel(alert.reach.frame, [{ poly: alert.shelf.poly }, { box: alert.reach.box }, { point: alert.reach.point }],
    `1 · взял с полки · ${clock(alert.reach.at)}`, '#F59E0B');
  const H = Math.max(left.H, right.H);
  return sharp({ create: { width: W * 2 + 8, height: H, channels: 3, background: '#0B0F1A' } })
    .composite([{ input: left.buf, left: 0, top: 0 }, { input: right.buf, left: W + 8, top: 0 }])
    .jpeg({ quality: 82 }).toBuffer();
}

/** Касса: «без покупателя» — один кадр с ящиком и пустой зоной покупателя;
 *  «к карману» — два кадра, как у полки. */
export async function cashEvidence(alert, frame, customerPolys = []) {
  if (alert.kind === 'pocket') {
    const right = await panel(frame, [{ box: alert.conceal.box }, { point: alert.conceal.point }],
      `2 · рука у кармана · ${clock(alert.conceal.at)}`, '#EF4444');
    if (!alert.reach.frame) return right.buf;
    const left = await panel(alert.reach.frame, [{ poly: alert.drawer.poly, color: '#EF4444', label: alert.drawer.name }, { box: alert.reach.box }, { point: alert.reach.point }],
      `1 · рука в денежном ящике · ${clock(alert.reach.at)}`, '#F59E0B');
    const H = Math.max(left.H, right.H);
    return sharp({ create: { width: W * 2 + 8, height: H, channels: 3, background: '#0B0F1A' } })
      .composite([{ input: left.buf, left: 0, top: 0 }, { input: right.buf, left: W + 8, top: 0 }])
      .jpeg({ quality: 82 }).toBuffer();
  }
  const marks = [
    ...customerPolys.map(p => ({ poly: p, color: '#60A5FA', label: 'покупателя нет' })),
    { poly: alert.drawer.poly, color: '#EF4444', label: alert.drawer.name },
    { box: alert.box }, { point: alert.point },
  ];
  return (await panel(frame, marks, `рука в ящике без покупателя · ${clock(alert.at)}`, '#EF4444')).buf;
}

/** Чёрный список: слева лицо из списка, справа лицо с камеры. */
export async function blacklistEvidence(match, frame, face) {
  const S = 300;
  const meta = await sharp(frame).metadata();
  const w = face.x2 - face.x1, h = face.y2 - face.y1;
  const side = Math.round(Math.max(w, h) * 1.6);
  const left = Math.max(0, Math.round((face.x1 + face.x2) / 2 - side / 2));
  const top = Math.max(0, Math.round((face.y1 + face.y2) / 2 - side / 2));
  const cw = Math.min(side, meta.width - left), ch = Math.min(side, meta.height - top);
  const current = await sharp(frame).extract({ left, top, width: cw, height: ch }).resize(S, S, { fit: 'cover' }).jpeg().toBuffer();
  const ref = match.entry.thumb
    ? await sharp(Buffer.from(match.entry.thumb, 'base64')).resize(S, S).jpeg().toBuffer()
    : await sharp({ create: { width: S, height: S, channels: 3, background: '#1C2236' } }).jpeg().toBuffer();
  const head = 44;
  const svg = `<svg width="${S * 2 + 8}" height="${head}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#0B0F1A"/>
    <text x="10" y="29" font-family="DejaVu Sans, Arial, sans-serif" font-size="18" font-weight="bold" fill="#F59E0B">${esc(`Возможное совпадение · ${Math.round(match.score * 100)}% · проверьте`)}</text></svg>`;
  const foot = `<svg width="${S * 2 + 8}" height="28" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#0B0F1A"/>
    <text x="10" y="19" font-family="DejaVu Sans, Arial, sans-serif" font-size="14" fill="#94A3B8">в списке: ${esc(match.entry.label)}</text>
    <text x="${S + 18}" y="19" font-family="DejaVu Sans, Arial, sans-serif" font-size="14" fill="#94A3B8">с камеры · ${clock(Date.now())}</text></svg>`;
  return sharp({ create: { width: S * 2 + 8, height: S + head + 28, channels: 3, background: '#0B0F1A' } })
    .composite([
      { input: Buffer.from(svg), left: 0, top: 0 },
      { input: ref, left: 0, top: head },
      { input: current, left: S + 8, top: head },
      { input: Buffer.from(foot), left: 0, top: head + S },
    ]).jpeg({ quality: 85 }).toBuffer();
}

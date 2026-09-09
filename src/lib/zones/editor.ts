/**
 * Логика редактора зон: геометрия и сборка zones.json.
 *
 * Вынесено из компонента специально: чистые функции без React и без DOM
 * можно прогнать реальными тестами, а внутри браузерного компонента —
 * практически нельзя. Компонент занимается только отрисовкой.
 */

export type Point = { x: number; y: number };

export type ZoneKind = 'guest_zone' | 'staff_zone' | 'zone';

export type DrawnZone = {
  id: string;
  name: string;
  kind: ZoneKind;
  cameraName: string;
  seconds: number;
  points: Point[];
};

export type ZoneRule = {
  id: string;
  name: string;
  camera: string;
  rule: 'no_staff' | 'uncleaned' | 'empty_zone';
  seconds: number;
  repeat_sec: number;
  severity: string;
  enabled: boolean;
  zone?: number[][];
  guest_zone?: number[][];
  staff_zone?: number[][];
};

export const KIND_LABELS: Record<ZoneKind, string> = {
  guest_zone: 'Зона гостей (где сидит гость)',
  staff_zone: 'Зона персонала (за стойкой)',
  zone: 'Стол / общая зона',
};

export const KIND_COLORS: Record<ZoneKind, string> = {
  guest_zone: '#4EA8FF',
  staff_zone: '#FF4D00',
  zone: '#5BD66F',
};

/** Координаты храним долями кадра (0..1) — не зависят от разрешения камеры. */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Площадь многоугольника по формуле шнурков. Для проверки, что зона не вырожденная. */
export function polygonArea(pts: Point[]): number {
  if (pts.length < 3) return 0;
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return Math.abs(s / 2);
}

/** Точка внутри многоугольника (ray casting) — тот же алгоритм, что в бридже. */
export function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const hit = (poly[i].y > y) !== (poly[j].y > y) &&
      x < ((poly[j].x - poly[i].x) * (y - poly[i].y)) / (poly[j].y - poly[i].y + 1e-12) + poly[i].x;
    if (hit) inside = !inside;
  }
  return inside;
}

/** Пересекаются ли отрезки — нужно для поиска наложения зон. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const sign = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const d1 = sign(c, d, a), d2 = sign(c, d, b), d3 = sign(a, b, c), d4 = sign(a, b, d);
  return d1 !== d2 && d3 !== d4;
}

/**
 * Накладываются ли зоны. Наложение — реальная проблема: гость за столом
 * попадёт и в зону стойки, и правила сработают крест-накрест.
 * Проверяем и пересечение границ, и вложенность одной зоны в другую.
 */
export function polygonsOverlap(a: Point[], b: Point[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return a.some(p => pointInPolygon(p.x, p.y, b)) || b.some(p => pointInPolygon(p.x, p.y, a));
}

/** Латиница/цифры для id правила: кириллица в ключах JSON читается плохо. */
export function slugify(name: string, fallback = 'zone'): string {
  const map: Record<string, string> = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
    н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',
    ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
  };
  const s = name.toLowerCase().split('').map(ch => map[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return s || fallback;
}

export type ValidationIssue = { level: 'error' | 'warning'; text: string };

/**
 * Проверка набора зон ДО сохранения. Ошибки блокируют, предупреждения нет.
 * Ловим именно те грабли, на которые уже наступали при тестах бриджа.
 */
export function validateZones(zones: DrawnZone[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!zones.length) return [{ level: 'error', text: 'Не нарисовано ни одной зоны' }];

  for (const z of zones) {
    if (z.points.length < 3) {
      issues.push({ level: 'error', text: `«${z.name}»: нужно минимум 3 точки` });
    } else if (polygonArea(z.points) < 0.002) {
      issues.push({ level: 'warning', text: `«${z.name}»: зона очень маленькая, детектор может её не поймать` });
    }
    if (!z.name.trim()) issues.push({ level: 'error', text: 'У зоны нет названия' });
    if (!z.cameraName) issues.push({ level: 'error', text: `«${z.name}»: не выбрана камера` });
    if (z.seconds < 5) issues.push({ level: 'warning', text: `«${z.name}»: меньше 5 секунд — будут ложные срабатывания` });
  }

  // парность зон стойки: правило no_staff требует ОБЕ зоны с одним именем
  const byName = new Map<string, DrawnZone[]>();
  for (const z of zones) {
    const key = `${z.cameraName}::${z.name.trim().toLowerCase()}`;
    byName.set(key, [...(byName.get(key) || []), z]);
  }
  for (const [, list] of byName) {
    const hasGuest = list.some(z => z.kind === 'guest_zone');
    const hasStaff = list.some(z => z.kind === 'staff_zone');
    if (hasGuest && !hasStaff) {
      issues.push({ level: 'warning', text: `«${list[0].name}»: есть зона гостей, но нет зоны персонала — правило «сотрудника нет» не соберётся` });
    }
    if (hasStaff && !hasGuest) {
      issues.push({ level: 'warning', text: `«${list[0].name}»: есть зона персонала, но нет зоны гостей` });
    }
  }

  // наложения — только в пределах одной камеры и разных правил
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i], b = zones[j];
      if (a.cameraName !== b.cameraName) continue;
      const samePair = a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
      if (samePair) continue; // гостевая и персонала одного правила рядом — это норма
      if (polygonsOverlap(a.points, b.points)) {
        issues.push({ level: 'error', text: `«${a.name}» и «${b.name}» накладываются — правила сработают крест-накрест` });
      }
    }
  }
  return issues;
}

/** Округление до 4 знаков: точность 0.01% кадра, файл читаемый. */
const pack = (pts: Point[]): number[][] =>
  pts.map(p => [+clamp01(p.x).toFixed(4), +clamp01(p.y).toFixed(4)]);

/** Собирает zones.json из нарисованного. Пары гость+персонал → правило no_staff. */
export function buildZonesJson(zones: DrawnZone[]): { rules: ZoneRule[] } {
  const groups = new Map<string, DrawnZone[]>();
  for (const z of zones) {
    const key = `${z.cameraName}::${z.name.trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) || []), z]);
  }

  const rules: ZoneRule[] = [];
  const usedIds = new Set<string>();

  for (const [, list] of groups) {
    const guest = list.find(z => z.kind === 'guest_zone');
    const staff = list.find(z => z.kind === 'staff_zone');
    const plain = list.find(z => z.kind === 'zone');
    const first = guest || staff || plain!;

    let id = slugify(first.name);
    let n = 2;
    while (usedIds.has(id)) id = `${slugify(first.name)}_${n++}`;
    usedIds.add(id);

    const base = {
      id, name: first.name.trim(), camera: first.cameraName,
      seconds: first.seconds, repeat_sec: first.seconds, enabled: true,
    };

    if (guest && staff) {
      rules.push({ ...base, rule: 'no_staff', severity: 'medium',
        guest_zone: pack(guest.points), staff_zone: pack(staff.points) });
    } else if (plain) {
      rules.push({ ...base, rule: 'uncleaned', severity: 'low', zone: pack(plain.points) });
    } else if (guest || staff) {
      rules.push({ ...base, rule: 'empty_zone', severity: 'low', zone: pack((guest || staff)!.points) });
    }
  }
  return { rules };
}

/** Обратное преобразование: правила из базы → зоны для отрисовки. */
export function parseZonesJson(cfg: any): DrawnZone[] {
  const out: DrawnZone[] = [];
  const unpack = (arr: number[][]): Point[] => (arr || []).map(([x, y]) => ({ x, y }));
  let i = 0;
  for (const r of cfg?.rules || []) {
    const common = { name: r.name || r.id, cameraName: r.camera || '', seconds: r.seconds ?? 300 };
    if (r.rule === 'no_staff') {
      out.push({ ...common, id: `r${i++}`, kind: 'guest_zone', points: unpack(r.guest_zone) });
      out.push({ ...common, id: `r${i++}`, kind: 'staff_zone', points: unpack(r.staff_zone) });
    } else {
      out.push({ ...common, id: `r${i++}`, kind: 'zone', points: unpack(r.zone) });
    }
  }
  return out.filter(z => z.points.length >= 3);
}

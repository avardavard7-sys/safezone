import { ComplianceSchedule } from './compliance.js';

let ok = 0, bad = 0;
const out = [];
const t = (n, f) => { try { f(); ok++; out.push(`  ok   ${n}`); }
  catch (e) { bad++; out.push(`  FAIL ${n}\n         ${e.message}`); } };
const eq = (a, b, w='') => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error(`${w} ожидалось ${JSON.stringify(b)}, пришло ${JSON.stringify(a)}`); };
const yes = (c, w) => { if (!c) throw new Error(w || 'не выполнено'); };

const CHECKS = [
  { code:'1.1', title:'Входная зона', mode:'snapshot',   engine:'cloud', interval_min:30, hint:'Мусор у входа' },
  { code:'1.2', title:'Двери',        mode:'snapshot',   engine:'cloud', interval_min:60, hint:'Грязь на стекле' },
  { code:'1.4', title:'Телефон',      mode:'continuous', engine:'local', rule_kind:'phone_use' },
  { code:'1.4c',title:'Контакт',      mode:'continuous', engine:'cloud', hint:'Приветствие гостя' },
  { code:'1.8', title:'Уборка стола', mode:'continuous', engine:'local', rule_kind:'uncleaned',
    threshold_sec:300, severity:'high' },
];
const CAM = 'cam-1';
const T0 = 1_700_000_000_000;
const MIN = 60_000;

console.log('\n=== Регламент видеоконтроля ===\n');

t('пункты разбираются', () => eq(new ComplianceSchedule(CHECKS).size, 5));

t('локальные отделены от облачных', () => {
  const s = new ComplianceSchedule(CHECKS);
  eq(s.localChecks().map(c => c.code), ['1.4','1.8']);
});

t('локальные правила уходят в движок зон', () => {
  const r = new ComplianceSchedule(CHECKS).toZoneRules();
  eq(r.length, 1, 'правил зон:');
  eq(r[0].rule, 'uncleaned');
  eq(r[0].seconds, 300, 'норматив 5 минут:');
  eq(r[0].id, 'compliance:1.8');
});

t('норматив по умолчанию — 5 минут регламента', () => {
  const s = new ComplianceSchedule([{ code:'x', title:'t', engine:'local', rule_kind:'uncleaned' }]);
  eq(s.toZoneRules()[0].seconds, 300);
});

t('слежение за телефоном включается пунктом 1.4', () => {
  yes(new ComplianceSchedule(CHECKS).watchesPhone());
  yes(!new ComplianceSchedule([CHECKS[0]]).watchesPhone(), 'без пункта 1.4 не должно');
});

t('локальные пункты НИКОГДА не идут в облако', () => {
  const codes = new ComplianceSchedule(CHECKS).due(CAM, T0).map(c => c.code);
  yes(!codes.includes('1.4'), 'телефон должен считаться локально');
  yes(!codes.includes('1.8'), 'уборка должна считаться локально');
});

t('в первый раз срабатывают все облачные', () => {
  eq(new ComplianceSchedule(CHECKS).due(CAM, T0).map(c => c.code), ['1.1','1.2','1.4c']);
});

t('непрерывные идут каждый цикл', () => {
  const s = new ComplianceSchedule(CHECKS);
  s.markRun(CAM, s.due(CAM, T0), T0);
  eq(s.due(CAM, T0 + 5000).map(c => c.code), ['1.4c']);
});

t('снимок раз в 30 минут — раньше не срабатывает', () => {
  const s = new ComplianceSchedule(CHECKS);
  s.markRun(CAM, s.due(CAM, T0), T0);
  yes(!s.due(CAM, T0 + 29*MIN).some(c => c.code === '1.1'), 'на 29-й минуте рано');
  yes(s.due(CAM, T0 + 30*MIN).some(c => c.code === '1.1'), 'на 30-й пора');
});

t('интервал 60 минут не путается с 30', () => {
  const s = new ComplianceSchedule(CHECKS);
  s.markRun(CAM, s.due(CAM, T0), T0);
  const at30 = s.due(CAM, T0 + 30*MIN).map(c => c.code);
  yes(at30.includes('1.1'), '30-минутная должна');
  yes(!at30.includes('1.2'), '60-минутной ещё рано');
  yes(s.due(CAM, T0 + 60*MIN).map(c => c.code).includes('1.2'), 'на 60-й пора');
});

t('расписание у камер раздельное', () => {
  const s = new ComplianceSchedule(CHECKS);
  s.markRun(CAM, s.due(CAM, T0), T0);
  yes(s.due('cam-2', T0).some(c => c.code === '1.1'), 'вторая камера не должна ждать первую');
});

t('проверка, привязанная к камере, чужую не трогает', () => {
  const s = new ComplianceSchedule([{ code:'z', title:'t', mode:'snapshot', engine:'cloud',
    interval_min:30, camera_id:'cam-9', hint:'h' }]);
  eq(s.due('cam-1', T0).length, 0);
  eq(s.due('cam-9', T0).length, 1);
});

t('обновление списка из панели сохраняет расписание', () => {
  const s = new ComplianceSchedule(CHECKS);
  s.markRun(CAM, s.due(CAM, T0), T0);
  s.replace(CHECKS);
  yes(!s.due(CAM, T0 + MIN).some(c => c.code === '1.1'), 'после обновления не должно сбрасываться');
});

t('выключённый пункт исчезает после обновления', () => {
  const s = new ComplianceSchedule(CHECKS);
  s.replace(CHECKS.filter(c => c.code !== '1.1'));
  yes(!s.due(CAM, T0).some(c => c.code === '1.1'));
});

t('промпт собирается только из подсказок', () => {
  const s = new ComplianceSchedule(CHECKS);
  const p = s.promptFor(s.due(CAM, T0));
  yes(p.includes('[1.1]') && p.includes('Мусор у входа'), 'подсказка должна попасть');
  yes(!p.includes('[1.8]'), 'локальные пункты в промпт не идут');
});

t('промпт требует конкретики и запрещает догадки', () => {
  const p = new ComplianceSchedule(CHECKS).promptFor([CHECKS[0]]);
  yes(p.includes('КОНКРЕТНО'), 'должно требовать конкретное описание');
  yes(p.includes('не угадывай'), 'должно запрещать догадки по перекрытому объекту');
  yes(p.includes('code'), 'должно требовать номер пункта в ответе');
});

t('без подсказок промпт пустой', () => eq(new ComplianceSchedule(CHECKS).promptFor([]), ''));

t('пустой список не роняет модуль', () => {
  const s = new ComplianceSchedule();
  eq(s.size, 0); eq(s.due(CAM, T0), []); eq(s.toZoneRules(), []);
  eq(s.summary(), 'нет активных пунктов');
});

t('мусор вместо списка игнорируется', () => {
  eq(new ComplianceSchedule(null).size, 0);
  eq(new ComplianceSchedule([null, {}, { code:'ok', title:'t' }]).size, 1);
});

t('сводка считает локальные и облачные', () => {
  yes(new ComplianceSchedule(CHECKS).summary().includes('2 локально'));
});

t('ближайшая проверка считается в минутах', () => {
  const s = new ComplianceSchedule(CHECKS);
  s.markRun(CAM, s.due(CAM, T0), T0);
  eq(s.nextInMinutes(CAM, T0 + 10*MIN), 20, 'через 10 минут до 30-минутной осталось:');
});


t('пункт выключили и включили заново — расписание не воскресает', () => {
  const s = new ComplianceSchedule(CHECKS);
  s.markRun(CAM, s.due(CAM, T0), T0);
  s.replace(CHECKS.filter(c => c.code !== '1.1'));   // выключили
  s.replace(CHECKS);                                  // включили обратно
  yes(s.due(CAM, T0 + MIN).some(c => c.code === '1.1'), 'заново включённый должен сработать сразу');
});

t('heartbeat каждые 5 секунд не сбивает интервалы', () => {
  const s = new ComplianceSchedule(CHECKS);
  s.markRun(CAM, s.due(CAM, T0), T0);
  for (let i = 1; i <= 200; i++) s.replace(CHECKS);   // ~17 минут heartbeat-ов
  yes(!s.due(CAM, T0 + 10*MIN).some(c => c.code === '1.1'),
      'после сотен обновлений снимок не должен уходить в облако раньше срока');
});

console.log(out.join('\n'));
console.log(`\n  Пройдено: ${ok}, провалено: ${bad}\n`);
process.exit(bad ? 1 : 0);

// Тесты облачной проверки через платформу: поддельный сервер платформы отвечает как настоящий.
import http from 'http';
import { platformVision, platformVisionUrl, PlatformVisionError } from './cloud.js';

let passed = 0, failed = 0;
const ok = (n, c, e = '') => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n} ${e}`); } };
const seen = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const token = req.headers['x-bridge-token'];
    seen.push({ token, ct: req.headers['content-type'], body });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (token === 'good') return send(200, { ok: true, provider: 'gemini', result: { is_safe: false, threats: [{ type: 'fight', confidence: 0.8 }], people_count: 2 } });
    if (token === 'paused') return send(403, { ok: false, reason: 'access' });
    if (token === 'deleted') return send(401, { ok: false, reason: 'unknown' });
    if (token === 'greedy') return send(429, { ok: false, reason: 'budget' });
    if (token === 'broken') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>ошибка шлюза</html>'); }
    if (token === 'empty') return send(200, { ok: true, provider: 'gemini', result: null });
    if (token === 'down') return send(503, { ok: false, reason: 'unavailable' });
    if (token === 'slow') return;
    send(400, { ok: false, reason: 'bad_request' });
  });
}).listen(0);
const url = `http://127.0.0.1:${srv.address().port}/api/bridge/vision`;
const call = (token, extra = {}) => platformVision({ url, token, prompt: 'что на кадре', base64: 'QUJD', ...extra });
const kindOf = async (p) => { try { await p; return 'ok'; } catch (e) { return e instanceof PlatformVisionError ? e.kind : 'other:' + e.message; } };

console.log('\nОблачная проверка через платформу');
{
  const r = await call('good');
  ok('активный клиент получает ответ модели', r.result.threats[0].type === 'fight' && r.result.people_count === 2);
  ok('видно, какая модель ответила', r.provider === 'platform:gemini');
  const last = seen.at(-1), sent = JSON.parse(last.body);
  ok('токен уходит в заголовке, кадр и запрос в теле', last.token === 'good' && sent.prompt === 'что на кадре' && sent.image === 'QUJD' && /json/.test(last.ct));
  ok('в запросе нет ключей моделей', !/sk-|api[_-]?key|Bearer/i.test(last.body));
  ok('клиент на паузе → отказ «доступ»', await kindOf(call('paused')) === 'access');
  ok('бридж удалён → отказ «токен не принят»', await kindOf(call('deleted')) === 'denied');
  ok('лимит за час исчерпан → отказ «лимит»', await kindOf(call('greedy')) === 'budget');
  ok('платформа вернула не JSON → сбой связи, бридж жив', await kindOf(call('broken')) === 'network');
  ok('пустой результат не принимается за ответ', await kindOf(call('empty')) === 'network');
  ok('платформа недоступна (503) → сбой связи', await kindOf(call('down')) === 'network');
  const t0 = Date.now(); const k = await kindOf(call('slow', { timeoutMs: 300 })); const took = Date.now() - t0;
  ok('платформа молчит → обрыв по таймауту', k === 'network' && took < 1500, `${k}, ${took} мс`);
  ok('порт закрыт → сбой связи', await kindOf(platformVision({ url: 'http://127.0.0.1:1/x', token: 't', prompt: 'p', base64: 'QQ==' })) === 'network');
  ok('без адреса или токена запрос не уходит', await kindOf(platformVision({ url: '', token: 't', prompt: 'p', base64: 'QQ==' })) === 'config' && await kindOf(platformVision({ url, token: '', prompt: 'p', base64: 'QQ==' })) === 'config');
}

console.log('\nАдрес платформы');
{
  ok('адрес собирается из адреса дашборда', platformVisionUrl('https://safezone-gamma.vercel.app') === 'https://safezone-gamma.vercel.app/api/bridge/vision');
  ok('лишний слеш в конце не мешает', platformVisionUrl('https://x.kz///') === 'https://x.kz/api/bridge/vision');
  ok('пустой или битый адрес выключает проверку', platformVisionUrl('') === '' && platformVisionUrl('не адрес') === '' && platformVisionUrl(undefined) === '');
}

srv.closeAllConnections?.(); srv.close();
console.log(`\n  Пройдено: ${passed}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);

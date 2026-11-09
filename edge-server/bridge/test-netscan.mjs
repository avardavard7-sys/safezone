// Тесты поиска камер без ONVIF: поднимаем поддельные камеры и опрашиваем их по-настоящему.
import net from 'net';
import crypto from 'crypto';
import {
  tcpOpen, scanSubnet, parseAuthHeader, digestResponse, rtspHello, rtspDescribe, codecFromSdp,
  vendorByMac, identifyBrand, findRtspCameras, parseArpTable, parseSsdp,
} from './netscan.js';

let passed = 0, failed = 0;
const ok = (n, c, e = '') => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n} ${e}`); } };
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const SDP = (codec) => `v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=Media\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 ${codec}/90000\r\na=control:track1\r\n`;

// Поддельная RTSP-камера: требует digest-пароль, отдаёт каналы, какие заданы.
function fakeCamera({ user = 'admin', pass = '1234', server = 'Dahua Rtsp Server', channels = { 1: 'H264' }, noAuth = false } = {}) {
  const server_ = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
        const head = buf.slice(0, i); buf = buf.slice(i + 4);
        const [reqLine, ...hdrs] = head.split('\r\n');
        const [method, url] = reqLine.split(' ');
        const cseq = /CSeq:\s*(\d+)/i.exec(head)?.[1] || '1';
        const auth = hdrs.find(h => /^authorization:/i.test(h));
        const send = (status, extra = '', body = '') => {
          const sc = { 200: 'OK', 401: 'Unauthorized', 404: 'Not Found' }[status];
          sock.write(`RTSP/1.0 ${status} ${sc}\r\nCSeq: ${cseq}\r\nServer: ${server}\r\n${extra}${body ? `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` : ''}\r\n${body}`);
        };
        if (method === 'OPTIONS') { send(200, 'Public: OPTIONS, DESCRIBE, SETUP, PLAY\r\n'); continue; }
        if (method === 'DESCRIBE') {
          const ch = /channel=(\d+)/.exec(url)?.[1] || /Channels\/(\d)/.exec(url)?.[1] || '1';
          const sub = /subtype=1/.test(url) || /Channels\/\d0?2/.test(url);
          const entry = channels[ch];
          const codec = entry && typeof entry === 'object' ? (sub ? entry.sub : entry.main) : entry;
          if (!noAuth && !auth) { send(401, `WWW-Authenticate: Digest realm="RTSPD", nonce="abc123"\r\n`); continue; }
          if (!noAuth && auth) {
            const want = md5(`${md5(`${user}:RTSPD:${pass}`)}:abc123:${md5(`DESCRIBE:${url}`)}`);
            if (!auth.includes(want)) { send(401, `WWW-Authenticate: Digest realm="RTSPD", nonce="abc123"\r\n`); continue; }
          }
          if (!codec) { send(404); continue; }
          send(200, '', SDP(codec)); continue;
        }
        send(200);
      }
    });
    sock.on('error', () => {});
  });
  return server_;
}
const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

console.log('\nОпрос портов');
{
  const srv = net.createServer(() => {}); const port = await listen(srv);
  ok('открытый порт виден', await tcpOpen('127.0.0.1', port, 500) === true);
  ok('закрытый порт не виден', await tcpOpen('127.0.0.1', 1, 300) === false);
  srv.close();
}

console.log('\nРазбор входа с подписью');
{
  const a = parseAuthHeader('Digest realm="RTSPD", nonce="abc123", qop="auth"');
  ok('digest разобран', a.scheme === 'digest' && a.realm === 'RTSPD' && a.nonce === 'abc123');
  ok('ответ совпадает с эталоном', digestResponse({ user: 'admin', pass: '1234', realm: 'RTSPD', nonce: 'abc123', method: 'DESCRIBE', uri: 'rtsp://x/y' }) === md5(`${md5('admin:RTSPD:1234')}:abc123:${md5('DESCRIBE:rtsp://x/y')}`));
  ok('кодек из SDP', codecFromSdp(SDP('H265')) === 'H265' && codecFromSdp(SDP('H264')) === 'H264');
}

console.log('\nРазговор с камерой по RTSP');
{
  const cam = fakeCamera({ channels: { 1: 'H264' } }); const port = await listen(cam);
  const hi = await rtspHello('127.0.0.1', port);
  ok('камера представилась по OPTIONS', hi.ok && /Dahua/.test(hi.server));
  const good = await rtspDescribe('127.0.0.1', port, '/cam/realmonitor?channel=1&subtype=0', 'admin', '1234');
  ok('верный пароль → поток 200 и кодек H264', good.status === 200 && good.codec === 'H264', JSON.stringify(good));
  const bad = await rtspDescribe('127.0.0.1', port, '/cam/realmonitor?channel=1&subtype=0', 'admin', 'wrong');
  ok('неверный пароль → 401, realm виден', bad.status === 401 && bad.realm === 'RTSPD');
  cam.close();
}

console.log('\nПроизводитель по адресу и ответу');
{
  ok('Hikvision по MAC', vendorByMac('44:19:B6:11:22:33') === 'Hikvision');
  ok('Dahua по MAC другого регистра', vendorByMac('3cef8c112233') === 'Dahua');
  ok('неизвестный MAC → null', vendorByMac('AA:BB:CC:DD:EE:FF') === null);
  ok('Dahua по порту 37777', identifyBrand({ server: 'Rtsp Server', ports: [554, 37777] }) === 'Dahua');
  ok('Hikvision по строке server', identifyBrand({ server: 'Hikvision-Webs', ports: [554] }) === 'Hikvision');
  ok('TP-Link по слову tapo', identifyBrand({ server: 'Tapo Camera', ports: [554] }) === 'TP-Link');
}

console.log('\nПолный поиск: три камеры разных брендов');
{
  const probe = async (srv, mac) => {
    const port = await listen(srv);
    const r = await findRtspCameras(new Map([['127.0.0.1', [port]]]), [{ user: 'admin', pass: '1234' }], { macs: new Map(mac ? [['127.0.0.1', mac]] : []), maxChannels: 8, timeoutMs: 4000, rtspPorts: [port] });
    srv.close();
    return r[0] || { profiles: [], info: {}, cred: null, error: 'нет ответа' };
  };
  const hik = await probe(fakeCamera({ server: 'Hikvision', channels: { 1: 'H264', 2: 'H264' } }), '44:19:b6:00:00:01');
  ok('Hikvision: 2 канала найдены', hik.profiles.length === 2 && hik.info.manufacturer === 'Hikvision', hik.error || JSON.stringify(hik.profiles.map(p => p.parsed.path)));
  ok('у найденных — рабочий RTSP-адрес', hik.profiles[0] && hik.profiles[0].rtsp.startsWith('rtsp://127.0.0.1:'));

  const dahua = await probe(fakeCamera({ server: 'Dahua Rtsp', channels: { 1: { main: 'H265', sub: 'H264' }, 2: 'H264', 3: 'H264' } }), '3c:ef:8c:00:00:02');
  ok('Dahua: 3 канала найдены', dahua.profiles.length === 3 && dahua.info.manufacturer === 'Dahua', dahua.error || String(dahua.profiles.length));
  ok('Dahua основной канал: выбран H264, а не H265', dahua.profiles[0] && dahua.profiles[0].encoding === 'H264');

  const locked = await probe(fakeCamera({ pass: 'secret', server: 'Hikvision' }), null);
  ok('камера с чужим паролем помечена, а не выброшена', locked.cred === null && /логин или пароль/.test(locked.error || ''), locked.error);
}

console.log('\nСписок соседей и автообъявления');
{
  const arp = parseArpTable(`? (192.168.1.10) at 44:19:b6:11:22:33 [ether] on eth0\n? (192.168.1.20) at 3c:ef:8c:aa:bb:cc [ether] on eth0\n? (192.168.1.1) at 00:00:00:00:00:00 on eth0`);
  ok('ARP: две настоящие записи, пустая отброшена', arp.length === 2 && arp[0].ip === '192.168.1.10');
  ok('ARP с адресом даёт производителя', vendorByMac(arp[0].mac) === 'Hikvision' && vendorByMac(arp[1].mac) === 'Dahua');
  const win = parseArpTable(`Интерфейс: 192.168.1.5\n  192.168.1.10    44-19-b6-11-22-33    динамический`);
  ok('ARP Windows тоже разбирается', win.length === 1 && win[0].mac === '44:19:b6:11:22:33');
  const ssdp = parseSsdp('HTTP/1.1 200 OK\r\nSERVER: Hikvision\r\nLOCATION: http://192.168.1.10:80/desc.xml\r\nST: urn:schemas', '192.168.1.10');
  ok('SSDP: адрес устройства разобран', ssdp.server === 'Hikvision' && ssdp.location.includes('192.168.1.10'));
}

console.log('\nОпрос подсети по портам');
{
  const cam = fakeCamera(); const port = await listen(cam);
  const found = await scanSubnet('127.0.0', { ports: [port, 1], from: 1, to: 1, timeoutMs: 400 });
  ok('на 127.0.0.1 найден открытый порт камеры', found.has('127.0.0.1') && found.get('127.0.0.1').includes(port));
  cam.close();
}

console.log('\nПоиск без ONVIF в общем поиске камер');
{
  const { findWithoutOnvif } = await import('./netscan.js');
  const cam = fakeCamera({ server: 'Dahua Rtsp', channels: { 1: 'H264', 2: 'H264' } });
  const port = await listen(cam);
  const logs = [];
  const scan = async (prefix) => prefix === '10.9.9' ? new Map([['127.0.0.1', [port]], ['127.0.0.2', [80]]]) : new Map();
  const arp = async () => [{ ip: '127.0.0.1', mac: '3c:ef:8c:00:00:07' }];
  const got = await findWithoutOnvif({ targets: ['10.9.9'], logins: [{ user: 'admin', pass: '1234' }], skipHosts: new Set(), onLog: m => logs.push(m), scan, arp, rtspPorts: [port] });
  ok('камера без ONVIF найдена по RTSP вместе с каналами', got.length === 1 && got[0].profiles.length === 2 && got[0].info.manufacturer === 'Dahua', JSON.stringify(got.map(g => [g.host, g.profiles.length, g.error])));
  ok('устройство без видео (открыт только веб-порт) в список не попадает', !got.some(g => g.host === '127.0.0.2'));
  const skipped = await findWithoutOnvif({ targets: ['10.9.9'], logins: [{ user: 'admin', pass: '1234' }], skipHosts: new Set(['127.0.0.1']), scan, arp, rtspPorts: [port] });
  ok('камера, уже найденная по ONVIF, не дублируется', skipped.length === 0);
  const wrong = await findWithoutOnvif({ targets: ['10.9.9'], logins: [{ user: 'admin', pass: 'не тот' }], skipHosts: new Set(), scan, arp, rtspPorts: [port] });
  ok('с неверным паролем камера видна, но без потоков и с понятной причиной', wrong.length === 1 && wrong[0].cred === null && wrong[0].profiles.length === 0 && /парол/.test(wrong[0].error || ''), JSON.stringify(wrong[0]));
  const pub = await findWithoutOnvif({ targets: ['8.8.8', '10.9.9'], logins: [{ user: 'admin', pass: '1234' }], skipHosts: new Set(), scan: async (p) => { logs.push('scan:' + p); return new Map(); }, arp });
  ok('чужие сети в интернете не сканируются', !logs.includes('scan:8.8.8') && logs.includes('scan:10.9.9') && pub.length === 0);
  cam.close();
}

console.log(`\n  Пройдено: ${passed}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);

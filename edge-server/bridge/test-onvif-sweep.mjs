import http from 'http';
import crypto from 'crypto';
import { sweepSubnet, inspectDevices } from './onvif.js';
import { pickStreams } from './discovery-plan.js';

const PASS = 'Right123';
const tag = (x, t) => (new RegExp(`<(?:[\\w-]+:)?${t}[^>]*>([^<]*)<`).exec(x) || [])[1];
function authorized(body) {
  const nonce = tag(body, 'Nonce'), created = tag(body, 'Created'), digest = tag(body, 'Password');
  if (!nonce || !created || !digest) return false;
  const want = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(PASS)])).digest('base64');
  return want === digest;
}
const env = b => `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><SOAP-ENV:Body>${b}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
const fault = env('<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>ter:NotAuthorized</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text>Sender not Authorized</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>');
const PROFILES = [1, 2].flatMap(ch => [
  { token: `M${ch}`, w: 2560, h: 1440, enc: 'H265', path: `/cam/realmonitor?channel=${ch}&amp;subtype=0` },
  { token: `S${ch}`, w: 704, h: 576, enc: 'H264', path: `/cam/realmonitor?channel=${ch}&amp;subtype=1` },
]);
let authFails = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/soap+xml');
    if (/GetSystemDateAndTime/.test(body)) return res.end(env('<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime/></tds:GetSystemDateAndTimeResponse>'));
    if (!authorized(body)) { authFails++; return res.end(fault); }
    if (/GetDeviceInformation/.test(body)) return res.end(env('<tds:GetDeviceInformationResponse><tds:Manufacturer>Dahua</tds:Manufacturer><tds:Model>NVR4104</tds:Model><tds:FirmwareVersion>4.0</tds:FirmwareVersion><tds:SerialNumber>X1</tds:SerialNumber></tds:GetDeviceInformationResponse>'));
    if (/GetCapabilities/.test(body)) return res.end(env('<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://127.0.0.1:8000/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>'));
    if (/GetProfiles/.test(body)) return res.end(env(`<trt:GetProfilesResponse>${PROFILES.map(p => `<trt:Profiles token="${p.token}" fixed="true"><tt:Name>${p.token}</tt:Name><tt:VideoEncoderConfiguration token="E${p.token}"><tt:Encoding>${p.enc}</tt:Encoding><tt:Resolution><tt:Width>${p.w}</tt:Width><tt:Height>${p.h}</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>`).join('')}</trt:GetProfilesResponse>`));
    if (/GetStreamUri/.test(body)) {
      const p = PROFILES.find(x => body.includes(`>${x.token}<`));
      return res.end(env(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://127.0.0.1:554${p.path}</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`));
    }
    if (/GetSnapshotUri/.test(body)) return res.end(env('<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://127.0.0.1:8000/snap.jpg</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>'));
    res.end(fault);
  });
});
await new Promise(r => server.listen(8000, '127.0.0.1', r));

const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) process.exitCode = 1; };
console.log('\n=== Поиск по сети: поддельный регистратор Dahua на 2 канала ===\n');
const t0 = Date.now();
const services = await sweepSubnet('127.0.0', { ports: [8000], concurrency: 40 });
ok(services.length === 1 && services[0].startsWith('http://127.0.0.1:8000/'), `перебор 254 адресов нашёл ровно регистратор (${((Date.now() - t0) / 1000).toFixed(1)} с)`);

const cams = await inspectDevices(new Map([['127.0.0.1', services[0]]]), [{ user: 'admin', pass: 'wrong' }, { user: 'admin', pass: PASS }]);
ok(cams[0].cred === 1 && authFails >= 1, `первый пароль отвергнут регистратором, подошёл второй (отказов подписи: ${authFails})`);
ok(cams[0].profiles.length === 4 && cams[0].profiles.every(p => p.encoding), 'получено 4 потока с кодеками');

const streams = pickStreams(cams);
ok(streams.length === 2, `к добавлению: ${streams.length} камеры — по одной на канал`);
ok(streams.every(s => s.encoding === 'H264' && /subtype=1/.test(s.path) && s.cred === 1), 'на каждый канал выбран поток H.264, с верным паролем');
ok(streams.map(s => s.name).join(' | ') === 'Dahua NVR4104 · канал 1 | Dahua NVR4104 · канал 2', `имена: ${streams.map(s => s.name).join(' | ')}`);

const none = await inspectDevices(new Map([['127.0.0.1', services[0]]]), [{ user: 'admin', pass: 'wrong' }]);
ok(none[0].cred === null && /неверный логин или пароль/.test(none[0].error), `только неверный пароль → «${none[0].error}», в добавление не попадёт`);
ok(pickStreams(none.filter(c => c.cred !== null)).length === 0, 'с неверным паролем камер к добавлению — ноль');
server.close();

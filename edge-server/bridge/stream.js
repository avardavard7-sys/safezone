import { spawn } from 'child_process';

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const BACKOFF = [1000, 2000, 5000, 10000, 30000];
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Держит одно RTSP-подключение и отдаёт кадры с заданной частотой.
 * Обработчик получает только свежий кадр: если анализ не успевает, промежуточные
 * кадры выбрасываются, а не копятся в очереди — иначе задержка растёт бесконечно.
 */
export class FrameStream {
  constructor({ url, fps = 5, width = 640, onFrame, log = () => {}, name = 'stream' }) {
    this.url = url;
    this.fps = fps;
    this.width = width;
    this.onFrame = onFrame;
    this.log = log;
    this.name = name;
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.busy = false;
    this.pending = null;
    this.stopped = false;
    this.attempt = 0;
    this.timer = null;
    this.frames = 0;
    this.dropped = 0;
    this.lastFrameAt = 0;
  }

  start() {
    if (this.proc || this.stopped) return;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', this.url,
      '-an',
      '-vf', `fps=${this.fps},scale=${this.width}:-2`,
      '-q:v', '5',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let errTail = '';

    proc.stdout.on('data', chunk => this.#ingest(chunk));
    proc.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-400); });
    proc.on('close', code => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.buf = Buffer.alloc(0);
      if (this.stopped) return;
      const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
      this.attempt++;
      const reason = errTail.trim().split('\n').pop() || `код ${code}`;
      if (this.attempt === 1 || this.attempt % 5 === 0) {
        this.log(`🎞 ${this.name}: поток прервался (${reason}), повтор через ${delay / 1000}с`);
      }
      this.timer = setTimeout(() => { this.timer = null; this.start(); }, delay);
    });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.proc) { this.proc.kill('SIGKILL'); this.proc = null; }
  }

  #ingest(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > MAX_BUFFER) this.buf = Buffer.alloc(0);
    for (;;) {
      const start = this.buf.indexOf(SOI);
      if (start < 0) { this.buf = Buffer.alloc(0); return; }
      const end = this.buf.indexOf(EOI, start + 2);
      if (end < 0) { if (start > 0) this.buf = this.buf.subarray(start); return; }
      const frame = Buffer.from(this.buf.subarray(start, end + 2));
      this.buf = this.buf.subarray(end + 2);
      this.#deliver(frame);
    }
  }

  #deliver(frame) {
    this.frames++;
    this.attempt = 0;
    this.lastFrameAt = Date.now();
    if (this.busy) {
      if (this.pending) this.dropped++;
      this.pending = frame;
      return;
    }
    this.#run(frame);
  }

  async #run(frame) {
    this.busy = true;
    try { await this.onFrame(frame, Date.now()); }
    catch (e) { this.log(`🎞 ${this.name}: ошибка обработки кадра — ${e.message}`); }
    finally {
      this.busy = false;
      const next = this.pending;
      this.pending = null;
      if (next && !this.stopped) this.#run(next);
    }
  }
}

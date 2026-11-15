// cloud.js — облачная проверка кадра через платформу.
// Ключи моделей лежат на сервере платформы: бридж отправляет кадр со своим токеном,
// платформа проверяет доступ и лимит и сама обращается к модели.

export class PlatformVisionError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const KINDS = { 401: 'denied', 403: 'access', 429: 'budget', 400: 'bad_request' };

/** Адрес облачной проверки по адресу платформы. Пустая строка — платформа не настроена. */
export function platformVisionUrl(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(b)) return '';
  return `${b}/api/bridge/vision`;
}

/**
 * Один кадр на проверку. Возвращает { provider, result } или бросает PlatformVisionError:
 *   denied  — токен не принят (бридж удалён)
 *   access  — доступ приостановлен или срок вышел
 *   budget  — исчерпан часовой лимит
 *   network — нет связи, таймаут, сбой платформы
 */
export async function platformVision({ url, token, prompt, base64, timeoutMs = 40000, fetchImpl = fetch }) {
  if (!url || !token) throw new PlatformVisionError('config', 'платформа не настроена');
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token },
      body: JSON.stringify({ prompt, image: base64 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new PlatformVisionError('network', `нет связи с платформой: ${e.name === 'TimeoutError' ? 'таймаут' : e.message}`);
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || !data || data.ok !== true) {
    const kind = KINDS[res.status] || 'network';
    throw new PlatformVisionError(kind, `платформа ответила ${res.status}${data?.reason ? ` (${data.reason})` : ''}`);
  }
  if (!data.result || typeof data.result !== 'object') throw new PlatformVisionError('network', 'платформа вернула пустой результат');
  return { provider: `platform:${data.provider || 'unknown'}`, result: data.result };
}

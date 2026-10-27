// localvlm.js — локальная VLM вместо облака (Фаза 3).
// Говорит по OpenAI-совместимому протоколу → работает с ollama, llama.cpp
// (llama-server), LM Studio, vLLM без изменений кода.
//
// Зачем: режим LOCAL_ONLY — кадры НЕ покидают объект, $0 за анализ.
// Для госзаказчика/военных/школ это ключевое требование.
//
// Запрос держим минимальным (без response_format и прочих расширений) —
// максимум совместимости между серверами.

/** Компактный промпт для малых моделей (2-4B): та же JSON-схема, что у облака,
 *  но без 150 строк методички — маленькая модель в них тонет. */
export function compactPrompt(cam, localHint, afterHours) {
  return `Ты — AI охранник видеонаблюдения. Проанализируй кадр с камеры "${cam.name}"${cam.floor ? ` (этаж ${cam.floor})` : ''}.
${afterHours ? 'СЕЙЧАС НЕРАБОЧЕЕ ВРЕМЯ — любые люди в кадре подозрительны.' : 'Сейчас рабочее время — люди в кадре это норма.'}
${localHint ? `ЛОКАЛЬНЫЙ ДЕТЕКТОР ДВИЖЕНИЙ СООБЩАЕТ: ${localHint}. Проверь это особенно внимательно.` : ''}

ИЩИ УГРОЗЫ:
- weapon: нож, ножницы, пистолет, бита, любой предмет как оружие (металлический блеск, лезвие). Телефон (плоский, экран светится) — НЕ оружие.
- fire: пламя, дым, зажигалка в руке, спички, искры. Экран/лампа — НЕ огонь.
- fight: удар, замах на человека, борьба, захват. Спокойная жестикуляция — НЕ драка.
- smoking: сигарета/вейп у рта, пар изо рта, жест курения.
- theft: человек украдкой прячет чужой товар/деньги в карман/сумку.
- fall: человек УПАЛ и лежит на полу.
- child_lost: маленький ребёнок совсем один, растерян/плачет.
- crowd: скопление 10+ человек.
- abandoned_object: сумка/рюкзак лежит БЕЗ людей рядом.

Если предмет/действие ПОХОЖЕ на угрозу, но не уверен — сообщи с confidence 0.5.
Если всё спокойно — is_safe: true и пустой threats.

Ответь ТОЛЬКО валидным JSON без пояснений:
{"people_count":число,"is_safe":true/false,"has_child":true/false,"has_adult_near_child":true/false,"abandoned_object":null или "описание","queue_size":число,"conflict_detected":true/false,"suspicious_movement":true/false,"bag_context":"owner_nearby|employee_bag|shopper_bag|abandoned_suspicious|no_bag","threats":[{"type":"weapon|fire|fight|smoking|theft|fall|child_lost|crowd|abandoned_object|suspicious","severity":"low|medium|high|critical","confidence":0.0-1.0,"description":"что видишь"}],"scene_description":"краткое описание сцены"}`;
}

/** Вызов локальной VLM. Бросает исключение при любой проблеме —
 *  решение о fallback принимает вызывающий код. */
export async function localVlmAnalyze({ baseUrl, model, prompt, base64, timeoutMs = 45000 }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      temperature: 0.1,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`local VLM HTTP ${res.status}: ${t.slice(0, 120)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  // модель может обернуть JSON в ```json ... ``` или добавить болтовню — вырезаем
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('local VLM: в ответе нет JSON: ' + text.slice(0, 100));
  return JSON.parse(m[0]);
}

/** Быстрая проверка что сервер жив (для стартовой диагностики). */
export async function localVlmPing(baseUrl, timeoutMs = 5000) {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    const models = (data?.data || []).map(m => m.id).slice(0, 5);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

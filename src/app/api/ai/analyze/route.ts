import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { rateLimit } from '@/lib/rate-limit';
import { auditFromRequest } from '@/lib/audit';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: Request) {

  const limited = await rateLimit(req, 'ai-analyze', { limit: 30, window: 60 });
  if (limited) return limited;

  try {
    const { image, camera_name, zone, floor, mall_id } = await req.json();

    if (!image) {
      return NextResponse.json({ detected: false, error: 'image required' }, { status: 400 });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content: `Ты — AI система безопасности SafeZone для торгового центра. МАКСИМАЛЬНО БДИТЕЛЬНО анализируй кадр. Будь параноиком — лучше ложное срабатывание чем пропущенная угроза.

ОБНАРУЖИВАЙ СТРОГО:

🚨 CRITICAL (критично):
- ЛЮБЫЕ предметы в руках похожие на нож, оружие, острые предметы, бутылки, палки
- Драки, удары, толчки, агрессивные жесты, замахи
- Огонь, дым, искры
- Человек лежит неподвижно на полу
- Закрытие камеры рукой или предметом

🔶 HIGH (высокий):
- Сигарета в руке/во рту, вейп, курение
- Кражи (прячут товар в сумку, карман, под одежду)
- Потерянный ребёнок (один, плачет, растерян)
- Бег, прыжки на эскалаторе, опасное поведение
- Падение человека
- Подозрительные оставленные предметы, сумки
- Вандализм, порча имущества
- Агрессивное или пьяное поведение
- Попытки скрыть лицо

⚠️ MEDIUM (средний):
- Скопление > 10 человек в одном месте
- Еда/напитки вне фуд-корта
- Мусор на полу, загрязнение
- Нарушения формы арендаторами
- Перекрытие проходов
- Распитие алкоголя
- Подозрительная активность

ℹ️ LOW (низкий):
- Животные без поводка
- Несанкционированная съёмка
- Мелкие нарушения

ВНИМАНИЕ: Если видишь СИГАРЕТУ, ВЕЙП, НОЖ, любое подозрительное поведение — обязательно detected:true. Не пропускай ничего!

ВСЕГДА указывай people_count — сколько людей видишь в кадре (число, 0 если никого).

Отвечай СТРОГО JSON без markdown: {"detected":true/false,"type":"theft|fight|crowd|fire|smoking|child_lost|escalator|violation|suspicious|fall|vandalism|weapon","severity":"low|medium|high|critical","description":"подробное описание на русском что именно видишь","confidence":0.0-1.0,"people_count":число}.

Если абсолютно всё спокойно: {"detected":false,"people_count":число}`,
          },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}`, detail: 'high' } },
              { type: 'text', text: `Камера: ${camera_name || 'не указана'}. Зона: ${zone || '—'}. Этаж: ${floor || '—'}. Внимательно изучи каждую деталь.` },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      return NextResponse.json({ detected: false, error: `OpenAI ${response.status}` }, { status: 502 });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '{"detected":false}';
    const clean = text.replace(/```json|```/g, '').trim();

    let result: any;
    try { result = JSON.parse(clean); } catch { return NextResponse.json({ detected: false, raw: text }); }

    if (result.detected && mall_id) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_KEY;
      if (supabaseUrl && serviceKey) {
        try {
          const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
          await sb.from('events').insert({
            mall_id,
            camera_name: camera_name || 'Вебкамера (AI Тест)',
            zone: zone || 'AI Демо',
            floor: floor || 1,
            type: result.type || 'suspicious',
            severity: result.severity || 'medium',
            description: result.description || 'AI обнаружил угрозу',
            confidence: result.confidence ?? null,
            screenshot_base64: image,
            people_count: result.people_count ?? null,
            status: 'new',
          });
        } catch (e) {
          console.error('events insert failed:', e);
        }
      }
    }

    auditFromRequest(req, {
      mall_id,
      action: 'ai.analyze',
      metadata: { detected: result.detected, severity: result.severity, type: result.type, camera_name },
    });

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ detected: false, error: String(e) }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { bot_token, chat_id, message, image_url } = await req.json();
    if (!bot_token || !chat_id) return NextResponse.json({ ok: false, error: 'No token or chat_id' });

    let url: string;
    let body: any;
    if (image_url) {
      url = `https://api.telegram.org/bot${bot_token}/sendPhoto`;
      body = { chat_id, photo: image_url, caption: message, parse_mode: 'HTML' };
    } else {
      url = `https://api.telegram.org/bot${bot_token}/sendMessage`;
      body = { chat_id, text: message, parse_mode: 'HTML' };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e) });
  }
}

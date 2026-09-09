import { test, expect } from '@playwright/test';

test.describe('API — Rate limiting', () => {
  test('AI endpoint защищён rate limit', async ({ request }) => {

    const responses = await Promise.all(
      Array.from({ length: 35 }, () =>
        request.post('/api/ai/analyze', {
          data: { image: '' },
        })
      )
    );
    const statuses = responses.map(r => r.status());
    expect(statuses).toContain(429);
  });

  test('health deep check возвращает структуру', async ({ request }) => {
    const res = await request.get('/api/health?deep=1');
    const json = await res.json();
    expect(json).toHaveProperty('status');
    expect(json).toHaveProperty('checks');
    expect(json.checks).toHaveProperty('supabase');
  });
});

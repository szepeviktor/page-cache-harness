import { expect, test } from './fixtures.js';

function generatedAt(html: string): string | null {
  const match = html.match(/<meta name="cache-harness-generated-at" content="(\d+)">/);
  return match?.[1] ?? null;
}

test('caches plain HTML GET responses', async ({ cachePlugin, wp }) => {
  const first = await fetch(`${wp.url}/__cache_harness/plain`);
  const firstBody = await first.text();

  expect(first.status).toBe(200);
  expect(cachePlugin.detectStatus(first)).toBe('miss');
  expect(generatedAt(firstBody)).not.toBeNull();

  const second = await fetch(`${wp.url}/__cache_harness/plain`);
  const secondBody = await second.text();

  expect(second.status).toBe(200);
  expect(cachePlugin.detectStatus(second)).toBe('hit');
  expect(generatedAt(secondBody)).toBe(generatedAt(firstBody));
  expect(secondBody).toBe(firstBody);
});

test('bypasses responses that send Set-Cookie', async ({ cachePlugin, wp }) => {
  const first = await fetch(`${wp.url}/__cache_harness/set-cookie`);
  const second = await fetch(`${wp.url}/__cache_harness/set-cookie`);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(cachePlugin.detectStatus(first)).toBe('bypass');
  expect(cachePlugin.detectStatus(second)).toBe('bypass');
  expect(first.headers.get('set-cookie')).toContain('cache_harness_cookie=');
});

test('bypasses private cache-control responses', async ({ cachePlugin, wp }) => {
  const response = await fetch(`${wp.url}/__cache_harness/cache-control-private`);

  expect(response.status).toBe(200);
  expect(cachePlugin.detectStatus(response)).toBe('bypass');
  expect(response.headers.get('cache-control')).toContain('private');
});

test('caches 404 responses', async ({ cachePlugin, wp }) => {
  const first = await fetch(`${wp.url}/__cache_harness/not-found`);
  const second = await fetch(`${wp.url}/__cache_harness/not-found`);

  expect(first.status).toBe(404);
  expect(second.status).toBe(404);
  expect(cachePlugin.detectStatus(first)).toBe('miss');
  expect(cachePlugin.detectStatus(second)).toBe('hit');
});

test('preserves redirect status and location from cache', async ({ cachePlugin, wp }) => {
  const first = await fetch(`${wp.url}/__cache_harness/redirect`, {
    redirect: 'manual',
  });
  const second = await fetch(`${wp.url}/__cache_harness/redirect`, {
    redirect: 'manual',
  });

  expect(first.status).toBe(302);
  expect(second.status).toBe(302);
  expect(first.headers.get('location')).toBe('/__cache_harness/plain');
  expect(second.headers.get('location')).toBe('/__cache_harness/plain');
  expect(cachePlugin.detectStatus(first)).toBe('miss');
  expect(cachePlugin.detectStatus(second)).toBe('hit');
});

test('removes ignored query vars from the WordPress request state', async ({ wp }) => {
  const response = await fetch(
    `${wp.url}/__cache_harness/debug-request?utm_source=abc&utm_medium=cpc&x=1`,
  );
  const data = await response.json();

  expect(response.status).toBe(200);
  expect(data.get).toEqual({ x: '1' });
  expect(data.request_uri).toBe('/__cache_harness/debug-request?x=1');
});

test('removes underscore-prefixed cookies from the WordPress request state', async ({ wp }) => {
  const response = await fetch(`${wp.url}/__cache_harness/debug-request`, {
    headers: {
      Cookie: '_ga=GA1.2.123; klaro=yes',
    },
  });
  const data = await response.json();

  expect(response.status).toBe(200);
  expect(data.cookie).toEqual({
    klaro: 'yes',
  });
});

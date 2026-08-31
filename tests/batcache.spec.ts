import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './batcache-fixtures.js';

const htmlHeaders = { Accept: 'text/html' };

let postCounter = 0;

async function batFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...htmlHeaders,
      ...(init.headers ?? {}),
    },
  });
}

async function cachedFiles(cacheDir: string): Promise<string[]> {
  if (!existsSync(cacheDir)) {
    return [];
  }

  const entries = await readdir(cacheDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('batcache-') || !entry.name.endsWith('.cache')) {
      continue;
    }

    const file = path.join(entry.parentPath, entry.name);
    const contents = await readFile(file, 'utf8');

    if (contents.includes('s:6:"output";')) {
      files.push(file);
    }
  }

  return files.sort();
}

async function cachedFileCount(cacheDir: string): Promise<number> {
  return (await cachedFiles(cacheDir)).length;
}

function generatedAt(html: string): string | null {
  const match = html.match(/<meta name="cache-harness-generated-at" content="(\d+)">/);
  return match?.[1] ?? null;
}

function isBatcacheHit(html: string): boolean {
  return html.includes('served from batcache');
}

async function createCacheablePost(wp: {
  createPost(input: { title: string; content: string; slug?: string }): Promise<number>;
  postUrl(id: number): string;
}, label: string): Promise<string> {
  const id = await wp.createPost({
    title: `Batcache ${label} ${++postCounter}`,
    content: `Batcache ${label} body.`,
    slug: `batcache-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${postCounter}`,
  });

  return wp.postUrl(id);
}

test('caches ordinary WordPress HTML responses', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'plain-html');
  await cachePlugin.flush(wp);

  const first = await batFetch(url);
  const firstBody = await first.text();
  const second = await batFetch(url);
  const secondBody = await second.text();

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(true);
  expect(generatedAt(secondBody)).toBe(generatedAt(firstBody));
});

test('creates persistent object-cache files', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'disk-files');
  await cachePlugin.flush(wp);

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(0);

  const response = await batFetch(url);
  await response.text();

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBeGreaterThan(0);
});

test('keeps GET and HEAD cache entries separate', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'head');
  await cachePlugin.flush(wp);

  const head = await batFetch(url, { method: 'HEAD' });
  await head.arrayBuffer();
  const get = await batFetch(url);
  const getBody = await get.text();
  const secondGet = await batFetch(url);
  const secondGetBody = await secondGet.text();

  expect(head.status).toBe(200);
  expect(isBatcacheHit(getBody)).toBe(false);
  expect(isBatcacheHit(secondGetBody)).toBe(true);
});

test('does not cache HTTP POST requests', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const response = await batFetch(`${wp.url}/__cache_harness/plain`, { method: 'POST' });
  await response.text();

  expect(response.status).toBe(200);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not cache responses that set cookies', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const response = await batFetch(`${wp.url}/__cache_harness/set-cookie`);
  await response.text();

  expect(response.status).toBe(200);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not cache 5xx responses', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const response = await batFetch(`${wp.url}/__cache_harness/unknown`);
  await response.text();

  expect(response.status).toBe(500);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('skips cache when WordPress cookies are present', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'wp-cookie');
  await cachePlugin.flush(wp);

  const first = await batFetch(url, {
    headers: { Cookie: 'wordpress_logged_in_test=1' },
  });
  const firstBody = await first.text();
  const second = await batFetch(url, {
    headers: { Cookie: 'wordpress_logged_in_test=1' },
  });
  const secondBody = await second.text();

  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(false);
});

test('does not skip cache for wordpress_test_cookie', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'test-cookie');
  await cachePlugin.flush(wp);

  const first = await batFetch(url, {
    headers: { Cookie: 'wordpress_test_cookie=WP Cookie check' },
  });
  const firstBody = await first.text();
  const second = await batFetch(url, {
    headers: { Cookie: 'wordpress_test_cookie=WP Cookie check' },
  });
  const secondBody = await second.text();

  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(true);
});

test('caches non-WordPress cookies into the same URL cache entry', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'normal-cookie');
  await cachePlugin.flush(wp);

  const first = await batFetch(url, {
    headers: { Cookie: 'klaro=yes' },
  });
  const firstBody = await first.text();
  const second = await batFetch(url, {
    headers: { Cookie: 'klaro=no' },
  });
  const secondBody = await second.text();

  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(true);
});

test('caches underscore-prefixed analytics cookies', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'analytics-cookie');
  await cachePlugin.flush(wp);

  const first = await batFetch(url, {
    headers: { Cookie: '_ga=GA1.2.123' },
  });
  const firstBody = await first.text();
  const second = await batFetch(url, {
    headers: { Cookie: '_ga=GA1.2.456' },
  });
  const secondBody = await second.text();

  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(true);
});

test('ignores configured marketing query args in cache keys', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'ignored-query');

  await wp.writeBatcacheConfig("$GLOBALS['batcache']['ignored_query_args'] = [ 'utm_source' ];");
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await batFetch(`${url}?utm_source=one`);
  const firstBody = await first.text();
  const second = await batFetch(`${url}?utm_source=two`);
  const secondBody = await second.text();

  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(true);

  await wp.writeBatcacheConfig('');
  await wp.restart();
});

test('keeps unknown query args in cache keys', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'query-key');
  await cachePlugin.flush(wp);

  const first = await batFetch(`${url}?custom=one`);
  const firstBody = await first.text();
  const second = await batFetch(`${url}?custom=two`);
  const secondBody = await second.text();
  const third = await batFetch(`${url}?custom=two`);
  const thirdBody = await third.text();

  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(false);
  expect(isBatcacheHit(thirdBody)).toBe(true);
});

test('does not mutate ignored marketing query variables in WordPress', async ({ wp }) => {
  const response = await batFetch(`${wp.url}/__cache_harness/debug-request?utm_source=abc&x=1`);
  const data = await response.json();

  expect(data.get).toEqual({ utm_source: 'abc', x: '1' });
  expect(data.request_uri).toBe('/__cache_harness/debug-request?utm_source=abc&x=1');
});

test('bypasses requests with X-WP-Nonce headers', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'nonce');
  await cachePlugin.flush(wp);

  const first = await batFetch(url, {
    headers: { 'X-WP-Nonce': 'abc' },
  });
  const firstBody = await first.text();
  const second = await batFetch(url, {
    headers: { 'X-WP-Nonce': 'abc' },
  });
  const secondBody = await second.text();

  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(false);
});

test('bypasses unapproved Origin requests', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'origin');
  await cachePlugin.flush(wp);

  const first = await batFetch(url, {
    headers: { Origin: 'https://evil.example' },
  });
  const firstBody = await first.text();
  const second = await batFetch(url, {
    headers: { Origin: 'https://evil.example' },
  });
  const secondBody = await second.text();

  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(false);
});

test('varies cache by approved Origin requests', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'approved-origin');

  await wp.writeBatcacheConfig("$GLOBALS['batcache']['cacheable_origin_hostnames'] = [ 'allowed.example' ];");
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await batFetch(url, {
    headers: { Origin: 'https://allowed.example' },
  });
  const firstBody = await first.text();
  const second = await batFetch(url, {
    headers: { Origin: 'https://allowed.example' },
  });
  const secondBody = await second.text();

  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(true);

  await wp.writeBatcacheConfig('');
  await wp.restart();
});

test('supports configured cache-key variants', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'variant');

  await wp.writeBatcacheConfig("$GLOBALS['batcache']['unique'] = [ 'x_variant' => $_SERVER['HTTP_X_VARIANT'] ?? 'default' ];");
  await cachePlugin.flush(wp);
  await wp.restart();

  const firstA = await batFetch(url, { headers: { 'X-Variant': 'a' } });
  const firstABody = await firstA.text();
  const firstB = await batFetch(url, { headers: { 'X-Variant': 'b' } });
  const firstBBody = await firstB.text();
  const secondA = await batFetch(url, { headers: { 'X-Variant': 'a' } });
  const secondABody = await secondA.text();

  expect(isBatcacheHit(firstABody)).toBe(false);
  expect(isBatcacheHit(firstBBody)).toBe(false);
  expect(isBatcacheHit(secondABody)).toBe(true);

  await wp.writeBatcacheConfig('');
  await wp.restart();
});

test('can disable cache by setting max_age below one', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'disabled');

  await wp.writeBatcacheConfig("$GLOBALS['batcache']['max_age'] = 0;");
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await batFetch(url);
  const firstBody = await first.text();
  const second = await batFetch(url);
  const secondBody = await second.text();

  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(false);

  await wp.writeBatcacheConfig('');
  await wp.restart();
});

test('can cancel storage from a WordPress hook', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'cancel');

  await wp.writeHarnessConfig("add_action( 'template_redirect', 'batcache_cancel' );");
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await batFetch(url);
  const firstBody = await first.text();
  const second = await batFetch(url);
  const secondBody = await second.text();

  expect(isBatcacheHit(firstBody)).toBe(false);
  expect(isBatcacheHit(secondBody)).toBe(false);

  await wp.writeHarnessConfig('');
  await wp.restart();
});

test('expires a cached post after post updates when optional plugin is active', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'Batcache invalidation post',
    content: 'Before Batcache update.',
  });

  await cachePlugin.flush(wp);

  const first = await batFetch(wp.postUrl(postId));
  await first.text();
  const second = await batFetch(wp.postUrl(postId));
  const secondBody = await second.text();

  expect(isBatcacheHit(secondBody)).toBe(true);

  const update = await fetch(`${wp.url}/__cache_harness/update-post`, {
    method: 'POST',
    body: new URLSearchParams({
      post_id: String(postId),
      content: 'After Batcache update.',
    }),
  });
  const updateBody = await update.json();

  expect(update.status).toBe(200);
  expect(updateBody).toEqual({ updated: true });

  const afterUpdate = await batFetch(wp.postUrl(postId));
  const afterUpdateBody = await afterUpdate.text();

  expect(isBatcacheHit(afterUpdateBody)).toBe(false);
  expect(afterUpdateBody).toContain('After Batcache update.');
  expect(afterUpdateBody).not.toContain('Before Batcache update.');
});

test('serves 304 for fresh If-Modified-Since cache hits', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'not-modified');
  await cachePlugin.flush(wp);

  const first = await batFetch(url);
  await first.text();
  const second = await batFetch(url);
  await second.text();
  const lastModified = second.headers.get('last-modified');

  expect(lastModified).not.toBeNull();

  const third = await batFetch(url, {
    headers: { 'If-Modified-Since': lastModified ?? '' },
  });
  await third.arrayBuffer();

  expect(third.status).toBe(304);
});

test('installs advanced-cache and object-cache drop-ins', async ({ wp }) => {
  expect(existsSync(wp.path('wp-content', 'advanced-cache.php'))).toBe(true);
  expect(existsSync(wp.path('wp-content', 'object-cache.php'))).toBe(true);
});

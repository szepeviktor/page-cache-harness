import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './wp-spider-cache-fixtures.js';

const htmlHeaders = { Accept: 'text/html' };

let postCounter = 0;

async function spiderFetch(url: string, init: RequestInit = {}): Promise<Response> {
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
    if (!entry.isFile() || !entry.name.startsWith('spider_cache-') || !entry.name.endsWith('.cache')) {
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

function isSpiderCacheHit(html: string): boolean {
  return html.includes('served from Spider-Cache');
}

async function warmSpiderCache(url: string, init: RequestInit = {}): Promise<void> {
  const first = await spiderFetch(url, init);
  await first.text();
  const second = await spiderFetch(url, init);
  await second.text();
}

async function createCacheablePost(wp: {
  createPost(input: { title: string; content: string; slug?: string }): Promise<number>;
  postUrl(id: number): string;
}, label: string): Promise<string> {
  const id = await wp.createPost({
    title: `WP Spider Cache ${label} ${++postCounter}`,
    content: `WP Spider Cache ${label} body.`,
    slug: `wp-spider-cache-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${postCounter}`,
  });

  return wp.postUrl(id);
}

test('caches ordinary WordPress HTML responses', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'plain-html');
  await cachePlugin.flush(wp);

  const first = await spiderFetch(url);
  const firstBody = await first.text();
  const second = await spiderFetch(url);
  const secondBody = await second.text();
  const third = await spiderFetch(url);
  const thirdBody = await third.text();

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(third.status).toBe(200);
  expect(isSpiderCacheHit(firstBody)).toBe(false);
  expect(isSpiderCacheHit(secondBody)).toBe(false);
  expect(isSpiderCacheHit(thirdBody)).toBe(true);
  expect(generatedAt(thirdBody)).toBe(generatedAt(secondBody));
});

test('creates persistent object-cache files', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'disk-files');
  await cachePlugin.flush(wp);

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(0);

  await warmSpiderCache(url);

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBeGreaterThan(0);
});

test('marks cache hits with configured response header', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'served-header');
  await cachePlugin.flush(wp);

  const first = await spiderFetch(url);
  const firstBody = await first.text();
  const second = await spiderFetch(url);
  const secondBody = await second.text();
  const third = await spiderFetch(url);
  const thirdBody = await third.text();

  expect(first.headers.get('x-spider-cache')).toBeNull();
  expect(isSpiderCacheHit(firstBody)).toBe(false);
  expect(isSpiderCacheHit(secondBody)).toBe(false);
  expect(cachePlugin.detectStatus(third)).toBe('hit');
  expect(generatedAt(thirdBody)).toBe(generatedAt(secondBody));
});

test('keeps GET and HEAD cache entries separate', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'head');
  await cachePlugin.flush(wp);

  const head = await spiderFetch(url, { method: 'HEAD' });
  await head.arrayBuffer();
  const get = await spiderFetch(url);
  const getBody = await get.text();
  const secondGet = await spiderFetch(url);
  const secondGetBody = await secondGet.text();
  const thirdGet = await spiderFetch(url);
  const thirdGetBody = await thirdGet.text();

  expect(head.status).toBe(200);
  expect(isSpiderCacheHit(getBody)).toBe(false);
  expect(isSpiderCacheHit(secondGetBody)).toBe(false);
  expect(generatedAt(thirdGetBody)).toBe(generatedAt(secondGetBody));
});

test('does not cache HTTP POST requests', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const response = await spiderFetch(`${wp.url}/__cache_harness/plain`, {
    body: new URLSearchParams({ posted: '1' }),
    method: 'POST',
  });
  await response.text();

  expect(response.status).toBe(200);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not cache responses that set cookies', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const response = await spiderFetch(`${wp.url}/__cache_harness/set-cookie`);
  await response.text();

  expect(response.status).toBe(200);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not cache 5xx responses', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const response = await spiderFetch(`${wp.url}/__cache_harness/unknown`);
  await response.text();

  expect(response.status).toBe(500);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('skips cache when WordPress cookies are present', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'wp-cookie');
  await cachePlugin.flush(wp);

  const first = await spiderFetch(url, {
    headers: { Cookie: 'wordpress_logged_in_test=1' },
  });
  const firstBody = await first.text();
  const second = await spiderFetch(url, {
    headers: { Cookie: 'wordpress_logged_in_test=1' },
  });
  const secondBody = await second.text();

  expect(isSpiderCacheHit(firstBody)).toBe(false);
  expect(isSpiderCacheHit(secondBody)).toBe(false);
});

test('does not skip cache for wordpress_test_cookie', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'test-cookie');
  await cachePlugin.flush(wp);

  const first = await spiderFetch(url, {
    headers: { Cookie: 'wordpress_test_cookie=WP Cookie check' },
  });
  const firstBody = await first.text();
  const second = await spiderFetch(url, {
    headers: { Cookie: 'wordpress_test_cookie=WP Cookie check' },
  });
  const secondBody = await second.text();
  const third = await spiderFetch(url, {
    headers: { Cookie: 'wordpress_test_cookie=WP Cookie check' },
  });
  const thirdBody = await third.text();

  expect(isSpiderCacheHit(firstBody)).toBe(false);
  expect(isSpiderCacheHit(secondBody)).toBe(false);
  expect(generatedAt(thirdBody)).toBe(generatedAt(secondBody));
});

test('caches non-WordPress cookies into the same URL cache entry', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'normal-cookie');
  await cachePlugin.flush(wp);

  const first = await spiderFetch(url, {
    headers: { Cookie: 'klaro=yes' },
  });
  const firstBody = await first.text();
  const second = await spiderFetch(url, {
    headers: { Cookie: 'klaro=no' },
  });
  const secondBody = await second.text();
  const third = await spiderFetch(url, {
    headers: { Cookie: 'klaro=yes' },
  });
  const thirdBody = await third.text();

  expect(isSpiderCacheHit(firstBody)).toBe(false);
  expect(isSpiderCacheHit(secondBody)).toBe(false);
  expect(generatedAt(thirdBody)).toBe(generatedAt(secondBody));
});

test('caches underscore-prefixed analytics cookies into the same URL cache entry', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'analytics-cookie');
  await cachePlugin.flush(wp);

  const first = await spiderFetch(url, {
    headers: { Cookie: '_ga=GA1.2.123' },
  });
  const firstBody = await first.text();
  const second = await spiderFetch(url, {
    headers: { Cookie: '_ga=GA1.2.456' },
  });
  const secondBody = await second.text();
  const third = await spiderFetch(url, {
    headers: { Cookie: '_ga=GA1.2.123' },
  });
  const thirdBody = await third.text();

  expect(isSpiderCacheHit(firstBody)).toBe(false);
  expect(isSpiderCacheHit(secondBody)).toBe(false);
  expect(generatedAt(thirdBody)).toBe(generatedAt(secondBody));
});

test('keeps query args in cache keys', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'query-key');
  await cachePlugin.flush(wp);

  const first = await spiderFetch(`${url}?custom=one`);
  const firstBody = await first.text();
  const second = await spiderFetch(`${url}?custom=two`);
  const secondBody = await second.text();
  const third = await spiderFetch(`${url}?custom=two`);
  const thirdBody = await third.text();
  const fourth = await spiderFetch(`${url}?custom=two`);
  const fourthBody = await fourth.text();

  expect(isSpiderCacheHit(firstBody)).toBe(false);
  expect(isSpiderCacheHit(secondBody)).toBe(false);
  expect(isSpiderCacheHit(thirdBody)).toBe(false);
  expect(generatedAt(fourthBody)).toBe(generatedAt(thirdBody));
});

test('does not mutate query variables in WordPress', async ({ wp }) => {
  const response = await spiderFetch(`${wp.url}/__cache_harness/debug-request?utm_source=abc&x=1`);
  const data = await response.json();

  expect(data.get).toEqual({ utm_source: 'abc', x: '1' });
  expect(data.request_uri).toBe('/__cache_harness/debug-request?utm_source=abc&x=1');
});

test('supports configured cache-key variants', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'variant');

  await cachePlugin.writeConfig(
    wp,
    "$GLOBALS['wp_output_cache']['unique'] = [ 'x_variant' => $_SERVER['HTTP_X_VARIANT'] ?? 'default' ];",
  );
  await cachePlugin.flush(wp);
  await wp.restart();

  const firstA = await spiderFetch(url, { headers: { 'X-Variant': 'a' } });
  const firstABody = await firstA.text();
  const firstB = await spiderFetch(url, { headers: { 'X-Variant': 'b' } });
  const firstBBody = await firstB.text();
  const secondA = await spiderFetch(url, { headers: { 'X-Variant': 'a' } });
  const secondABody = await secondA.text();
  const thirdA = await spiderFetch(url, { headers: { 'X-Variant': 'a' } });
  const thirdABody = await thirdA.text();

  expect(isSpiderCacheHit(firstABody)).toBe(false);
  expect(isSpiderCacheHit(firstBBody)).toBe(false);
  expect(isSpiderCacheHit(secondABody)).toBe(false);
  expect(generatedAt(thirdABody)).toBe(generatedAt(secondABody));

  await cachePlugin.writeConfig(wp, '');
  await wp.restart();
});

test('supports configured vary callbacks', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'vary-config');

  try {
    await cachePlugin.writeConfig(
      wp,
      [
        'function cache_harness_spider_device_variant() {',
        "\treturn $_SERVER['HTTP_X_DEVICE'] ?? 'desktop';",
        '}',
        "$GLOBALS['wp_output_cache']['vary'] = [ 'device' => 'cache_harness_spider_device_variant' ];",
      ].join('\n'),
    );
    await cachePlugin.flush(wp);
    await wp.restart();

    const firstDesktop = await spiderFetch(url, { headers: { 'X-Device': 'desktop' } });
    const firstDesktopBody = await firstDesktop.text();
    const firstMobile = await spiderFetch(url, { headers: { 'X-Device': 'mobile' } });
    const firstMobileBody = await firstMobile.text();
    const secondDesktop = await spiderFetch(url, { headers: { 'X-Device': 'desktop' } });
    const secondDesktopBody = await secondDesktop.text();
    const thirdDesktop = await spiderFetch(url, { headers: { 'X-Device': 'desktop' } });
    const thirdDesktopBody = await thirdDesktop.text();

    expect(isSpiderCacheHit(firstDesktopBody)).toBe(false);
    expect(isSpiderCacheHit(firstMobileBody)).toBe(false);
    expect(isSpiderCacheHit(secondDesktopBody)).toBe(false);
    expect(generatedAt(thirdDesktopBody)).toBe(generatedAt(secondDesktopBody));
  } finally {
    await cachePlugin.writeConfig(wp, '');
    await wp.restart();
  }
});

test('does not expire cached post pages after WP-CLI post updates alone', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'WP Spider Cache CLI update post',
    content: 'Before WP Spider Cache CLI update.',
  });

  await cachePlugin.flush(wp);

  const first = await spiderFetch(wp.postUrl(postId));
  await first.text();
  const second = await spiderFetch(wp.postUrl(postId));
  const secondBody = await second.text();
  const third = await spiderFetch(wp.postUrl(postId));
  const thirdBody = await third.text();

  expect(isSpiderCacheHit(secondBody)).toBe(false);
  expect(generatedAt(thirdBody)).toBe(generatedAt(secondBody));

  await wp.updatePost(postId, {
    content: 'After WP Spider Cache CLI update.',
  });

  const afterUpdate = await spiderFetch(wp.postUrl(postId));
  const afterUpdateBody = await afterUpdate.text();

  expect(afterUpdateBody).toContain('Before WP Spider Cache CLI update.');
  expect(afterUpdateBody).not.toContain('After WP Spider Cache CLI update.');
});

test('can disable cache by setting max_age below one', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'disabled');

  await cachePlugin.writeConfig(wp, "$GLOBALS['wp_output_cache']['max_age'] = 0;");
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await spiderFetch(url);
  const firstBody = await first.text();
  const second = await spiderFetch(url);
  const secondBody = await second.text();

  expect(isSpiderCacheHit(firstBody)).toBe(false);
  expect(isSpiderCacheHit(secondBody)).toBe(false);

  await cachePlugin.writeConfig(wp, '');
  await wp.restart();
});

test('can cancel storage from a WordPress hook', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'cancel');

  await wp.writeHarnessConfig("add_action( 'template_redirect', 'wp_output_cache_cancel' );");
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await spiderFetch(url);
  const firstBody = await first.text();
  const second = await spiderFetch(url);
  const secondBody = await second.text();

  expect(isSpiderCacheHit(firstBody)).toBe(false);
  expect(isSpiderCacheHit(secondBody)).toBe(false);

  await wp.writeHarnessConfig('');
  await wp.restart();
});

test('does not expire cached post pages after the harness update endpoint', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'WP Spider Cache invalidation post',
    content: 'Before WP Spider Cache update.',
  });

  await cachePlugin.flush(wp);

  const first = await spiderFetch(wp.postUrl(postId));
  await first.text();
  const second = await spiderFetch(wp.postUrl(postId));
  const secondBody = await second.text();
  const third = await spiderFetch(wp.postUrl(postId));
  const thirdBody = await third.text();

  expect(isSpiderCacheHit(secondBody)).toBe(false);
  expect(generatedAt(thirdBody)).toBe(generatedAt(secondBody));

  const update = await fetch(`${wp.url}/__cache_harness/update-post`, {
    method: 'POST',
    body: new URLSearchParams({
      post_id: String(postId),
      content: 'After WP Spider Cache update.',
    }),
  });
  const updateBody = await update.json();

  expect(update.status).toBe(200);
  expect(updateBody).toEqual({ updated: true });

  const afterUpdate = await spiderFetch(wp.postUrl(postId));
  const afterUpdateBody = await afterUpdate.text();

  expect(afterUpdateBody).toContain('Before WP Spider Cache update.');
  expect(afterUpdateBody).not.toContain('After WP Spider Cache update.');
});

test('serves 304 for fresh If-Modified-Since cache hits', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'not-modified');
  await cachePlugin.flush(wp);

  const first = await spiderFetch(url);
  await first.text();
  const second = await spiderFetch(url);
  await second.text();
  const third = await spiderFetch(url);
  await third.text();
  const lastModified = third.headers.get('last-modified');

  expect(lastModified).not.toBeNull();

  const fourth = await spiderFetch(url, {
    headers: { 'If-Modified-Since': lastModified ?? '' },
  });
  await fourth.arrayBuffer();

  expect(fourth.status).toBe(304);
});

test('can cache redirects when explicitly enabled', async ({ cachePlugin, wp }) => {
  await cachePlugin.writeConfig(wp, "$GLOBALS['wp_output_cache']['cache_redirects'] = true;");
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await spiderFetch(`${wp.url}/__cache_harness/permanent-redirect`, {
    redirect: 'manual',
  });
  await first.text();
  const second = await spiderFetch(`${wp.url}/__cache_harness/permanent-redirect`, {
    redirect: 'manual',
  });
  await second.text();

  expect(first.status).toBe(301);
  expect(second.status).toBe(301);
  expect(second.headers.get('location')).toBe('/__cache_harness/plain');

  await cachePlugin.writeConfig(wp, '');
  await wp.restart();
});

test('does not serve cached redirects by default', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);

  const first = await spiderFetch(`${wp.url}/__cache_harness/permanent-redirect`, {
    redirect: 'manual',
  });
  await first.text();
  const second = await spiderFetch(`${wp.url}/__cache_harness/permanent-redirect`, {
    redirect: 'manual',
  });
  const secondBody = await second.text();

  expect(first.status).toBe(301);
  expect(second.status).toBe(301);
  expect(isSpiderCacheHit(secondBody)).toBe(false);
});

test('installs advanced-cache and object-cache drop-ins', async ({ wp }) => {
  expect(existsSync(wp.path('wp-content', 'advanced-cache.php'))).toBe(true);
  expect(existsSync(wp.path('wp-content', 'object-cache.php'))).toBe(true);
});

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './wp-super-cache-fixtures.js';

const htmlHeaders = { Accept: 'text/html' };

let postCounter = 0;

async function wpscFetch(url: string, init: RequestInit = {}): Promise<Response> {
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
    if (entry.isFile() && (entry.name.endsWith('.html') || entry.name.endsWith('.html.gz'))) {
      files.push(path.join(entry.parentPath, entry.name));
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

async function createCacheablePost(wp: {
  createPost(input: { title: string; content: string; slug?: string }): Promise<number>;
  postUrl(id: number): string;
}, label: string): Promise<string> {
  const id = await wp.createPost({
    title: `WP Super Cache ${label} ${++postCounter}`,
    content: `WP Super Cache ${label} body.`,
    slug: `wp-super-cache-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${postCounter}`,
  });

  return wp.postUrl(id);
}

test('caches ordinary WordPress HTML responses', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'plain-html');
  await cachePlugin.flush(wp);

  const first = await wpscFetch(url);
  const firstBody = await first.text();
  const second = await wpscFetch(url);
  const secondBody = await second.text();

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(cachePlugin.detectStatus(first)).not.toBe('hit');
  expect(cachePlugin.detectStatus(second)).toBe('hit');
  expect(generatedAt(secondBody)).toBe(generatedAt(firstBody));
});

test('creates supercache files on disk', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'disk-files');
  await cachePlugin.flush(wp);

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(0);

  const response = await wpscFetch(url);
  await response.text();

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBeGreaterThan(0);
});

test('marks PHP-served cache hits with X-WP-Super-Cache', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'served-header');
  await cachePlugin.flush(wp);

  const first = await wpscFetch(url);
  await first.text();
  const second = await wpscFetch(url);
  await second.text();

  expect(second.headers.get('x-wp-super-cache')).toContain('Served');
});

test('clears cached post pages after post updates', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'WP Super Cache invalidation post',
    content: 'Before WP Super Cache update.',
  });

  await cachePlugin.flush(wp);

  const first = await wpscFetch(wp.postUrl(postId));
  await first.text();
  const second = await wpscFetch(wp.postUrl(postId));
  await second.text();

  expect(cachePlugin.detectStatus(second)).toBe('hit');

  await wp.updatePost(postId, {
    content: 'After WP Super Cache update.',
  });

  const afterUpdate = await wpscFetch(wp.postUrl(postId));
  const afterUpdateBody = await afterUpdate.text();

  expect(cachePlugin.detectStatus(afterUpdate)).not.toBe('hit');
  expect(afterUpdateBody).toContain('After WP Super Cache update.');
  expect(afterUpdateBody).not.toContain('Before WP Super Cache update.');
});

test('does not cache HTTP POST requests', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const response = await wpscFetch(`${wp.url}/__cache_harness/plain`, { method: 'POST' });
  await response.text();

  expect(response.status).toBe(200);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not serve cache to HEAD requests before a GET cache exists', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'head');
  await cachePlugin.flush(wp);

  const head = await wpscFetch(url, { method: 'HEAD' });
  await head.arrayBuffer();

  expect(head.status).toBe(200);
  expect(cachePlugin.detectStatus(head)).not.toBe('hit');
});

test('does not cache non-200 responses', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const notFound = await wpscFetch(`${wp.url}/__cache_harness/not-found`);
  await notFound.text();
  const forbidden = await wpscFetch(`${wp.url}/__cache_harness/forbidden`);
  await forbidden.text();
  const error = await wpscFetch(`${wp.url}/__cache_harness/unknown`);
  await error.text();

  expect(notFound.status).toBe(404);
  expect(forbidden.status).toBe(403);
  expect(error.status).toBe(500);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not cache redirects', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const temporary = await wpscFetch(`${wp.url}/__cache_harness/redirect`, { redirect: 'manual' });
  await temporary.text();
  const permanent = await wpscFetch(`${wp.url}/__cache_harness/permanent-redirect`, {
    redirect: 'manual',
  });
  await permanent.text();

  expect(temporary.status).toBe(302);
  expect(permanent.status).toBe(301);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not serve cache hits to non-html Accept headers', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'accept');
  await cachePlugin.flush(wp);

  const first = await wpscFetch(url);
  await first.text();
  const second = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  await second.text();

  expect(second.status).toBe(200);
  expect(cachePlugin.detectStatus(second)).not.toBe('hit');
});

test('ignores configured marketing query strings in cache keys', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'marketing-query');
  await cachePlugin.flush(wp);

  const first = await wpscFetch(`${url}?utm_source=one`);
  await first.text();
  const second = await wpscFetch(`${url}?utm_source=two`);
  await second.text();

  expect(cachePlugin.detectStatus(second)).toBe('hit');
});

test('can bypass cache for GET parameters when configured', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'get-bypass');

  await cachePlugin.writeConfig(wp, '$wp_cache_no_cache_for_get = 1;');
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await wpscFetch(`${url}?custom=1`);
  await first.text();
  const second = await wpscFetch(`${url}?custom=1`);
  await second.text();

  expect(cachePlugin.detectStatus(second)).not.toBe('hit');

  await cachePlugin.writeConfig(wp, '');
  await wp.restart();
});

test('does not mutate ignored marketing query variables in WordPress', async ({ wp }) => {
  const response = await wpscFetch(`${wp.url}/__cache_harness/debug-request?utm_source=abc&x=1`);
  const data = await response.json();

  expect(data.get).toEqual({ x: '1' });
  expect(data.request_uri).toBe('/__cache_harness/debug-request?utm_source=abc&x=1');
});

test('does not cache rejected cookies', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'rejected-cookie');
  await cachePlugin.flush(wp);

  const first = await wpscFetch(url, {
    headers: { Cookie: 'wp-postpass_abc=secret' },
  });
  await first.text();
  const second = await wpscFetch(url, {
    headers: { Cookie: 'wp-postpass_abc=secret' },
  });
  await second.text();

  expect(cachePlugin.detectStatus(second)).not.toBe('hit');
});

test('caches non-rejected cookies into the same URL cache file', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'normal-cookie');
  await cachePlugin.flush(wp);

  const first = await wpscFetch(url, {
    headers: { Cookie: 'klaro=yes' },
  });
  await first.text();
  const second = await wpscFetch(url, {
    headers: { Cookie: 'klaro=no' },
  });
  await second.text();

  expect(cachePlugin.detectStatus(second)).toBe('hit');
});

test('caches underscore-prefixed analytics cookies when they are not rejected', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'analytics-cookie');
  await cachePlugin.flush(wp);

  const first = await wpscFetch(url, {
    headers: { Cookie: '_ga=GA1.2.123' },
  });
  await first.text();
  const second = await wpscFetch(url, {
    headers: { Cookie: '_ga=GA1.2.456' },
  });
  await second.text();

  expect(cachePlugin.detectStatus(second)).toBe('hit');
});

test('caches password-protected post forms without leaking protected body', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'WP Super Cache protected post',
    content: 'WP Super Cache protected body.',
    password: 'secret',
  });

  await cachePlugin.flush(wp);

  const first = await wpscFetch(wp.postUrl(postId));
  const firstBody = await first.text();
  const second = await wpscFetch(wp.postUrl(postId));
  await second.text();

  expect(first.status).toBe(200);
  expect(firstBody).toContain('post_password');
  expect(firstBody).not.toContain('WP Super Cache protected body.');
  expect(cachePlugin.detectStatus(second)).toBe('hit');
});

test('can reject configured URL paths', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'rejected-path');
  const pathname = new URL(url).pathname.replaceAll('/', '\\/');

  await cachePlugin.writeConfig(wp, `$cache_rejected_uri[] = '${pathname}';`);
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await wpscFetch(url);
  await first.text();
  const second = await wpscFetch(url);
  await second.text();

  expect(cachePlugin.detectStatus(second)).not.toBe('hit');

  await cachePlugin.writeConfig(wp, '');
  await wp.restart();
});

test('can reject configured user agents', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'rejected-agent');

  await cachePlugin.writeConfig(wp, "$cache_rejected_user_agent[] = 'CacheHarnessBot';");
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await wpscFetch(url, {
    headers: { 'User-Agent': 'CacheHarnessBot/1.0' },
  });
  await first.text();
  const second = await wpscFetch(url, {
    headers: { 'User-Agent': 'CacheHarnessBot/1.0' },
  });
  await second.text();

  expect(cachePlugin.detectStatus(second)).not.toBe('hit');

  await cachePlugin.writeConfig(wp, '');
  await wp.restart();
});

test('can disable cache writes with cache_enabled false', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'disabled');

  await cachePlugin.writeConfig(wp, '$cache_enabled = false;');
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await wpscFetch(url);
  await first.text();
  const second = await wpscFetch(url);
  await second.text();

  expect(cachePlugin.detectStatus(second)).not.toBe('hit');

  await cachePlugin.writeConfig(wp, '');
  await wp.restart();
});

test('filters cached contents with wpsupercache_buffer', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'buffer-filter');

  await wp.writeHarnessConfig(
    "add_filter( 'wpsupercache_buffer', function ( $html ) { return str_replace( 'WP Super Cache buffer-filter', 'Filtered WP Super Cache buffer-filter', $html ); } );",
  );
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await wpscFetch(url);
  await first.text();
  const second = await wpscFetch(url);
  const secondBody = await second.text();

  expect(cachePlugin.detectStatus(second)).toBe('hit');
  expect(secondBody).toContain('Filtered WP Super Cache buffer-filter');

  await wp.writeHarnessConfig('');
  await wp.restart();
});

test('supports mobile cache variants when enabled', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'mobile');

  await cachePlugin.writeConfig(wp, '$wp_cache_mobile_enabled = 1;');
  await cachePlugin.flush(wp);
  await wp.restart();

  const desktop = await wpscFetch(url, {
    headers: { 'User-Agent': 'Desktop Browser' },
  });
  await desktop.text();
  const mobile = await wpscFetch(url, {
    headers: { 'User-Agent': 'iPhone' },
  });
  await mobile.text();

  const files = await cachedFiles(cachePlugin.cacheDirectory(wp) ?? '');

  expect(files.some((file) => file.endsWith('index.html'))).toBe(true);
  expect(files.some((file) => file.endsWith('index-mobile.html'))).toBe(true);

  await cachePlugin.writeConfig(wp, '');
  await wp.restart();
});

test('supports gzip cache files when compression is enabled', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'gzip');

  await cachePlugin.writeConfig(wp, '$cache_compression = 1;');
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await wpscFetch(url, {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  await first.text();

  const files = await cachedFiles(cachePlugin.cacheDirectory(wp) ?? '');

  expect(files.some((file) => file.endsWith('.html.gz'))).toBe(true);

  await cachePlugin.writeConfig(wp, '');
  await wp.restart();
});

test('serves 304 for fresh If-Modified-Since cache hits when enabled', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'not-modified');

  await cachePlugin.writeConfig(wp, '$wp_supercache_304 = 1;');
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await wpscFetch(url);
  await first.text();
  const files = await cachedFiles(cachePlugin.cacheDirectory(wp) ?? '');
  const htmlFile = files.find((file) => file.endsWith('.html'));

  expect(htmlFile).toBeTruthy();

  const cached = await wpscFetch(url);
  await cached.text();

  expect(cachePlugin.detectStatus(cached)).toBe('hit');

  const lastModified = cached.headers.get('last-modified');
  expect(lastModified).toBeTruthy();

  const second = await wpscFetch(url, {
    headers: { 'If-Modified-Since': lastModified ?? '' },
  });
  await second.arrayBuffer();

  expect(second.status).toBe(304);

  await cachePlugin.writeConfig(wp, '');
  await wp.restart();
});

test('clears the complete cache through plugin functions', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'clear-all');
  await cachePlugin.flush(wp);

  const response = await wpscFetch(url);
  await response.text();

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBeGreaterThan(0);

  await cachePlugin.flush(wp);

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(0);
});

test('installs advanced-cache config and cache directory', async ({ cachePlugin, wp }) => {
  const advancedCache = await readFile(wp.path('wp-content', 'advanced-cache.php'), 'utf8');
  const config = await readFile(wp.path('wp-content', 'wp-cache-config.php'), 'utf8');

  expect(advancedCache).toContain('wp-cache-phase1.php');
  expect(config).toContain('$cache_enabled = true;');
  expect(cachePlugin.cacheDirectory(wp)).toContain('cache/supercache');
});

test('schedules WP Super Cache garbage collection', async ({ wp }) => {
  const output = await wp.cli([
    'eval',
    "schedule_wp_gc(1); var_export((bool) wp_next_scheduled('wp_cache_gc'));",
  ]);

  expect(output.trim()).toBe('true');
});

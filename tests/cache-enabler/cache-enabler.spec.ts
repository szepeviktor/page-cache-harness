import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './cache-enabler-fixtures.js';

const htmlHeaders = { Accept: 'text/html' };

async function ceFetch(url: string, init: RequestInit = {}): Promise<Response> {
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

let postCounter = 0;

async function createCacheablePost(wp: {
  createPost(input: { title: string; content: string; slug?: string }): Promise<number>;
  postUrl(id: number): string;
}, label: string): Promise<string> {
  const id = await wp.createPost({
    title: `Cache Enabler ${label} ${++postCounter}`,
    content: `Cache Enabler ${label} body.`,
    slug: `cache-enabler-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${postCounter}`,
  });

  return wp.postUrl(id);
}

async function setCacheEnablerSettings(
  wp: { cli(args: string[]): Promise<string> },
  settings: Record<string, string | number>,
): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(settings), 'utf8').toString('base64');

  await wp.cli([
    'eval',
    `Cache_Enabler::update_backend(); $settings = Cache_Enabler::get_settings(); $settings = array_merge($settings, json_decode(base64_decode('${encoded}'), true)); update_option('cache_enabler', Cache_Enabler::validate_settings($settings)); Cache_Enabler::update_backend();`,
  ]);
}

test('caches ordinary WordPress HTML responses', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'plain-html');
  await cachePlugin.flush(wp);

  const first = await ceFetch(url);
  const firstBody = await first.text();
  const second = await ceFetch(url);
  const secondBody = await second.text();

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(cachePlugin.detectStatus(first)).not.toBe('hit');
  expect(cachePlugin.detectStatus(second)).toBe('hit');
  expect(secondBody).toContain('Cache Enabler plain-html');
  expect(generatedAt(secondBody)).toBe(generatedAt(firstBody));
});

test('keeps the render timestamp unchanged on cache hits', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'timestamp');
  await cachePlugin.flush(wp);

  const first = await ceFetch(url);
  const firstBody = await first.text();
  const second = await ceFetch(url);
  const secondBody = await second.text();

  expect(cachePlugin.detectStatus(second)).toBe('hit');
  expect(generatedAt(firstBody)).not.toBeNull();
  expect(generatedAt(secondBody)).toBe(generatedAt(firstBody));
});

test('creates cache files on disk', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'disk-files');
  await cachePlugin.flush(wp);
  const cacheDir = cachePlugin.cacheDirectory(wp);

  expect(await cachedFileCount(cacheDir ?? '')).toBe(0);

  const response = await ceFetch(url);
  await response.text();

  expect(await cachedFileCount(cacheDir ?? '')).toBeGreaterThan(0);
});

test('marks cache hits with X-Cache-Handler', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'cache-handler');
  await cachePlugin.flush(wp);

  const first = await ceFetch(url);
  await first.text();
  const second = await ceFetch(url);
  await second.text();

  expect(cachePlugin.detectStatus(first)).not.toBe('hit');
  expect(second.headers.get('x-cache-handler')).toBe('cache-enabler-engine');
});

test('caches real WordPress single post pages', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'Cache Enabler cached post',
    content: 'Cache Enabler single post body.',
  });

  await cachePlugin.flush(wp);

  const first = await ceFetch(wp.postUrl(postId));
  const firstBody = await first.text();
  const second = await ceFetch(wp.postUrl(postId));
  const secondBody = await second.text();

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(cachePlugin.detectStatus(second)).toBe('hit');
  expect(firstBody).toContain('Cache Enabler cached post');
  expect(generatedAt(secondBody)).toBe(generatedAt(firstBody));
});

test('clears cached post pages after post updates', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'Cache Enabler invalidation post',
    content: 'Before Cache Enabler update.',
  });

  await cachePlugin.flush(wp);

  const first = await ceFetch(wp.postUrl(postId));
  await first.text();
  const second = await ceFetch(wp.postUrl(postId));
  await second.text();

  expect(cachePlugin.detectStatus(second)).toBe('hit');

  await wp.updatePost(postId, {
    content: 'After Cache Enabler update.',
  });

  const afterUpdate = await ceFetch(wp.postUrl(postId));
  const afterUpdateBody = await afterUpdate.text();

  expect(cachePlugin.detectStatus(afterUpdate)).not.toBe('hit');
  expect(afterUpdateBody).toContain('After Cache Enabler update.');
  expect(afterUpdateBody).not.toContain('Before Cache Enabler update.');
});

test('does not cache HTTP POST requests', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const response = await ceFetch(`${wp.url}/__cache_harness/plain`, { method: 'POST' });
  await response.text();

  expect(response.status).toBe(200);
  expect(cachePlugin.detectStatus(response)).not.toBe('hit');
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not cache HEAD requests', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const response = await ceFetch(`${wp.url}/__cache_harness/plain`, { method: 'HEAD' });
  await response.arrayBuffer();

  expect(response.status).toBe(200);
  expect(cachePlugin.detectStatus(response)).not.toBe('hit');
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not cache non-200 responses', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const notFound = await ceFetch(`${wp.url}/__cache_harness/not-found`);
  await notFound.text();
  const forbidden = await ceFetch(`${wp.url}/__cache_harness/forbidden`);
  await forbidden.text();
  const error = await ceFetch(`${wp.url}/__cache_harness/unknown`);
  await error.text();

  expect(notFound.status).toBe(404);
  expect(forbidden.status).toBe(403);
  expect(error.status).toBe(500);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not cache redirects', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const temporary = await ceFetch(`${wp.url}/__cache_harness/redirect`, { redirect: 'manual' });
  await temporary.text();
  const permanent = await ceFetch(`${wp.url}/__cache_harness/permanent-redirect`, {
    redirect: 'manual',
  });
  await permanent.text();

  expect(temporary.status).toBe(302);
  expect(permanent.status).toBe(301);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not cache requests with non-html Accept headers', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const response = await fetch(`${wp.url}/__cache_harness/plain`, {
    headers: { Accept: 'application/json' },
  });
  await response.text();

  expect(response.status).toBe(200);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('caches known marketing query strings by default', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'marketing-query');
  await cachePlugin.flush(wp);

  const first = await ceFetch(`${url}?utm_source=test`);
  await first.text();
  const second = await ceFetch(`${url}?utm_source=test`);
  await second.text();

  expect(cachePlugin.detectStatus(second)).toBe('hit');
});

test('does not cache unknown query strings by default', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'unknown-query');
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const first = await ceFetch(`${url}?custom=1`);
  await first.text();
  const second = await ceFetch(`${url}?custom=1`);
  await second.text();

  expect(cachePlugin.detectStatus(first)).not.toBe('hit');
  expect(cachePlugin.detectStatus(second)).not.toBe('hit');
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('does not mutate ignored marketing query variables', async ({ wp }) => {
  const response = await ceFetch(`${wp.url}/__cache_harness/debug-request?utm_source=abc&x=1`);
  const data = await response.json();

  expect(data.get).toEqual({ utm_source: 'abc', x: '1' });
  expect(data.request_uri).toBe('/__cache_harness/debug-request?utm_source=abc&x=1');
});

test('does not cache default excluded cookies', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);
  const before = await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '');

  const response = await ceFetch(`${wp.url}/__cache_harness/plain`, {
    headers: { Cookie: 'wp-postpass_abc=secret' },
  });
  await response.text();

  expect(response.status).toBe(200);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(before);
});

test('caches non-excluded cookies into the same URL cache file', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'normal-cookie');
  await cachePlugin.flush(wp);

  const first = await ceFetch(url, {
    headers: { Cookie: 'klaro=yes' },
  });
  await first.text();
  const second = await ceFetch(url, {
    headers: { Cookie: 'klaro=no' },
  });
  await second.text();

  expect(cachePlugin.detectStatus(second)).toBe('hit');
});

test('caches underscore-prefixed cookies when they are not excluded', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'underscore-cookie');
  await cachePlugin.flush(wp);

  const first = await ceFetch(url, {
    headers: { Cookie: '_ga=GA1.2.123' },
  });
  await first.text();
  const second = await ceFetch(url, {
    headers: { Cookie: '_ga=GA1.2.456' },
  });
  await second.text();

  expect(cachePlugin.detectStatus(second)).toBe('hit');
});

test('does not cache password-protected post forms', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'Cache Enabler protected post',
    content: 'Cache Enabler protected body.',
    password: 'secret',
  });

  await cachePlugin.flush(wp);

  const first = await ceFetch(wp.postUrl(postId));
  const firstBody = await first.text();
  const second = await ceFetch(wp.postUrl(postId));
  await second.text();

  expect(first.status).toBe(200);
  expect(firstBody).toContain('post_password');
  expect(firstBody).not.toContain('Cache Enabler protected body.');
  expect(cachePlugin.detectStatus(second)).not.toBe('hit');
});

test('excludes configured post IDs', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'Cache Enabler excluded ID',
    content: 'Excluded by post ID.',
  });

  await setCacheEnablerSettings(wp, { excluded_post_ids: String(postId) });
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await ceFetch(wp.postUrl(postId));
  await first.text();
  const second = await ceFetch(wp.postUrl(postId));
  await second.text();

  expect(cachePlugin.detectStatus(second)).not.toBe('hit');
});

test('excludes configured page paths', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'excluded-path');
  const pathname = new URL(url).pathname.replaceAll('/', '\\/');

  await setCacheEnablerSettings(wp, { excluded_page_paths: `/${pathname}/` });
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await ceFetch(url);
  await first.text();
  const second = await ceFetch(url);
  await second.text();

  expect(cachePlugin.detectStatus(second)).not.toBe('hit');
});

test('excludes configured query strings', async ({ cachePlugin, wp }) => {
  await setCacheEnablerSettings(wp, { excluded_query_strings: '/utm_source=blocked/' });
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await ceFetch(`${wp.url}/__cache_harness/plain?utm_source=blocked`);
  await first.text();
  const second = await ceFetch(`${wp.url}/__cache_harness/plain?utm_source=blocked`);
  await second.text();

  expect(cachePlugin.detectStatus(second)).not.toBe('hit');
});

test('excludes configured cookies', async ({ cachePlugin, wp }) => {
  await setCacheEnablerSettings(wp, { excluded_cookies: '/klaro/' });
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await ceFetch(`${wp.url}/__cache_harness/plain`, {
    headers: { Cookie: 'klaro=yes' },
  });
  await first.text();
  const second = await ceFetch(`${wp.url}/__cache_harness/plain`, {
    headers: { Cookie: 'klaro=yes' },
  });
  await second.text();

  expect(cachePlugin.detectStatus(second)).not.toBe('hit');
});

test('can force bypass with the cache_enabler_bypass_cache filter', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'bypass-filter');

  await wp.writeHarnessConfig("add_filter( 'cache_enabler_bypass_cache', '__return_true' );");
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await ceFetch(url);
  await first.text();
  const second = await ceFetch(url);
  await second.text();

  expect(cachePlugin.detectStatus(second)).not.toBe('hit');

  await wp.writeHarnessConfig('');
  await wp.restart();
});

test('fires page cache created hooks', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'created-hook');
  const logPath = wp.path('wp-content', 'cache-enabler-events.log');
  const phpLogPath = logPath.replaceAll("'", "\\'");

  await wp.writeHarnessConfig(`add_action( 'cache_enabler_page_cache_created', function ( $url, $id ): void {
	file_put_contents( '${phpLogPath}', 'created:' . $url . ':' . $id . PHP_EOL, FILE_APPEND );
}, 10, 2 );`);
  await cachePlugin.flush(wp);
  await wp.restart();

  const response = await ceFetch(url);
  await response.text();

  const log = await readFile(logPath, 'utf8');

  expect(log).toContain('created:');
  expect(log).toContain(new URL(url).pathname);

  await wp.writeHarnessConfig('');
  await wp.restart();
});

test('filters page contents before storing', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'store-filter');

  await wp.writeHarnessConfig(
    "add_filter( 'cache_enabler_page_contents_before_store', function ( $html ) { return str_replace( 'Cache Enabler store-filter', 'Filtered Cache Enabler store-filter', $html ); } );",
  );
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await ceFetch(url);
  await first.text();
  const second = await ceFetch(url);
  const secondBody = await second.text();

  expect(cachePlugin.detectStatus(second)).toBe('hit');
  expect(secondBody).toContain('Filtered Cache Enabler store-filter');

  await wp.writeHarnessConfig('');
  await wp.restart();
});

test('supports mobile cache variants when enabled', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'mobile-variant');

  await setCacheEnablerSettings(wp, { mobile_cache: 1 });
  await cachePlugin.flush(wp);
  await wp.restart();

  const desktop = await ceFetch(url, {
    headers: { 'User-Agent': 'Desktop Browser' },
  });
  await desktop.text();
  const mobile = await ceFetch(url, {
    headers: { 'User-Agent': 'Mobile Safari' },
  });
  await mobile.text();

  const files = await cachedFiles(cachePlugin.cacheDirectory(wp) ?? '');

  expect(files.some((file) => file.endsWith('http-index.html'))).toBe(true);
  expect(files.some((file) => file.endsWith('http-index-mobile.html'))).toBe(true);
});

test('supports gzip cache files when compression is enabled', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'gzip');

  await setCacheEnablerSettings(wp, { compress_cache: 1 });
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await ceFetch(url, {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  await first.text();

  const files = await cachedFiles(cachePlugin.cacheDirectory(wp) ?? '');

  expect(files.some((file) => file.endsWith('.html.gz'))).toBe(true);
});

test('serves 304 for fresh If-Modified-Since cache hits', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'not-modified');
  await cachePlugin.flush(wp);

  const first = await ceFetch(url);
  await first.text();
  const files = await cachedFiles(cachePlugin.cacheDirectory(wp) ?? '');

  expect(files.length).toBeGreaterThan(0);

  const cacheStat = await stat(files[0]);
  const since = cacheStat.mtime.toUTCString();

  const second = await ceFetch(url, {
    headers: { 'If-Modified-Since': since },
  });
  await second.arrayBuffer();

  expect(second.status).toBe(304);
  expect(second.headers.get('x-cache-handler')).toBe('cache-enabler-engine');
});

test('clears the complete cache through WP-CLI', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'cli-clear-all');
  await cachePlugin.flush(wp);

  const response = await ceFetch(url);
  await response.text();

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBeGreaterThan(0);

  const output = await wp.cli(['cache-enabler', 'clear']);

  expect(output).toContain('Site cache cleared.');
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(0);
});

test('clears a specific post cache through WP-CLI', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'Cache Enabler CLI post',
    content: 'CLI clear body.',
  });

  await cachePlugin.flush(wp);

  const first = await ceFetch(wp.postUrl(postId));
  await first.text();

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBeGreaterThan(0);

  const output = await wp.cli(['cache-enabler', 'clear', `--ids=${postId}`]);

  expect(output).toContain('Page cache cleared.');
});

test('installs its advanced-cache drop-in', async ({ wp }) => {
  const dropIn = await readFile(wp.path('wp-content', 'advanced-cache.php'), 'utf8');

  expect(dropIn).toContain('Cache Enabler');
  expect(dropIn).toContain('CACHE_ENABLER');
});

test('creates a settings file on disk', async ({ wp }) => {
  const settingsDir = wp.path('wp-content', 'settings', 'cache-enabler');
  const files = existsSync(settingsDir) ? await readdir(settingsDir, { recursive: true }) : [];

  expect(files.length).toBeGreaterThan(0);
});

test('registers the cache-enabler WP-CLI command', async ({ wp }) => {
  const output = await wp.cli(['help', 'cache-enabler']);

  expect(output).toContain('clear');
  expect(output).toContain('Clear the page cache.');
});

test('schedules expired cache cleanup cron', async ({ wp }) => {
  await setCacheEnablerSettings(wp, { cache_expires: 1, cache_expiry_time: 1 });

  const output = await wp.cli([
    'eval',
    "Cache_Enabler_Engine::start(true); Cache_Enabler::schedule_events(); var_export((bool) wp_next_scheduled('cache_enabler_clear_expired_cache'));",
  ]);

  expect(output.trim()).toBe('true');
});

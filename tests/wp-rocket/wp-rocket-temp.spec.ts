import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './wp-rocket-fixtures.js';

const htmlHeaders = { Accept: 'text/html' };

let postCounter = 0;

async function rocketFetch(url: string, init: RequestInit = {}): Promise<Response> {
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
    if (entry.isFile() && (entry.name.endsWith('.html') || entry.name.endsWith('.html_gzip'))) {
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

function rocketCachedAt(html: string): string | null {
  const match = html.match(/Performance optimized by WP Rocket\. .* - Debug: cached@(\d+)/);
  return match?.[1] ?? null;
}

async function createCacheablePost(wp: {
  createPost(input: { title: string; content: string; slug?: string }): Promise<number>;
  postUrl(id: number): string;
}, label: string): Promise<string> {
  const id = await wp.createPost({
    title: `WP Rocket ${label} ${++postCounter}`,
    content: `WP Rocket ${label} body.`,
    slug: `wp-rocket-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${postCounter}`,
  });

  return wp.postUrl(id);
}

test('temporarily verifies wp-rocket caches ordinary WordPress HTML responses', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'plain-html');
  await cachePlugin.flush(wp);

  const first = await rocketFetch(url);
  const firstBody = await first.text();
  const second = await rocketFetch(url);
  const secondBody = await second.text();

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(secondBody).toContain('WP Rocket plain-html');
  expect(generatedAt(firstBody)).not.toBeNull();
  expect(generatedAt(secondBody)).toBe(generatedAt(firstBody));
  expect(rocketCachedAt(firstBody)).toBeNull();
  expect(rocketCachedAt(secondBody)).not.toBeNull();
});

test('temporarily verifies wp-rocket creates cache files on disk', async ({ cachePlugin, wp }) => {
  const url = await createCacheablePost(wp, 'disk-files');
  await cachePlugin.flush(wp);

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(0);

  const response = await rocketFetch(url);
  await response.text();

  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBeGreaterThan(0);
});

test('temporarily verifies wp-rocket does not cache HTTP POST requests', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);

  const response = await rocketFetch(`${wp.url}/__cache_harness/plain`, { method: 'POST' });
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain('plain html');
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(0);
});

test('temporarily verifies wp-rocket does not cache responses that send Set-Cookie', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);

  const first = await rocketFetch(`${wp.url}/__cache_harness/set-cookie`);
  await first.text();
  const second = await rocketFetch(`${wp.url}/__cache_harness/set-cookie`);
  await second.text();

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.headers.get('set-cookie')).toContain('cache_harness_cookie=');
  expect(second.headers.get('set-cookie')).toContain('cache_harness_cookie=');
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(0);
});

for (const route of ['cache-control-private', 'cache-control-no-cache', 'cache-control-no-store', 'cache-control-max-age-zero']) {
  test(`temporarily verifies wp-rocket does not cache ${route} responses`, async ({ cachePlugin, wp }) => {
    await cachePlugin.flush(wp);

    const first = await rocketFetch(`${wp.url}/__cache_harness/${route}`);
    await first.text();
    const second = await rocketFetch(`${wp.url}/__cache_harness/${route}`);
    await second.text();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get('cache-control')).not.toBeNull();
    expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(0);
  });
}

test('temporarily verifies wp-rocket does not cache response codes outside the cacheable status list', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);

  const forbidden = await rocketFetch(`${wp.url}/__cache_harness/forbidden`);
  await forbidden.text();
  const error = await rocketFetch(`${wp.url}/__cache_harness/unknown`);
  await error.text();

  expect(forbidden.status).toBe(403);
  expect(error.status).toBe(500);
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(0);
});

test('temporarily verifies wp-rocket does not cache redirects', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);

  const temporary = await rocketFetch(`${wp.url}/__cache_harness/redirect`, { redirect: 'manual' });
  await temporary.text();
  const permanent = await rocketFetch(`${wp.url}/__cache_harness/permanent-redirect`, {
    redirect: 'manual',
  });
  await permanent.text();

  expect(temporary.status).toBe(302);
  expect(permanent.status).toBe(301);
  expect(temporary.headers.get('location')).toBe('/__cache_harness/plain');
  expect(permanent.headers.get('location')).toBe('/__cache_harness/plain');
  expect(await cachedFileCount(cachePlugin.cacheDirectory(wp) ?? '')).toBe(0);
});

test('temporarily verifies wp-rocket clears cached post pages after post updates', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'WP Rocket invalidation post',
    content: 'Before WP Rocket update.',
  });

  await cachePlugin.flush(wp);

  const first = await rocketFetch(wp.postUrl(postId));
  const firstBody = await first.text();
  const second = await rocketFetch(wp.postUrl(postId));
  const secondBody = await second.text();

  expect(generatedAt(secondBody)).toBe(generatedAt(firstBody));
  expect(rocketCachedAt(secondBody)).not.toBeNull();

  await wp.updatePost(postId, {
    content: 'After WP Rocket update.',
  });

  const afterUpdate = await rocketFetch(wp.postUrl(postId));
  const afterUpdateBody = await afterUpdate.text();

  expect(rocketCachedAt(afterUpdateBody)).toBeNull();
  expect(afterUpdateBody).toContain('After WP Rocket update.');
  expect(afterUpdateBody).not.toContain('Before WP Rocket update.');
});

test('temporarily verifies wp-rocket installs advanced-cache config and cache directory', async ({ cachePlugin, wp }) => {
  const advancedCache = await readFile(wp.path('wp-content', 'advanced-cache.php'), 'utf8');

  expect(advancedCache).toContain('WP_ROCKET_ADVANCED_CACHE');
  expect(existsSync(cachePlugin.cacheDirectory(wp) ?? '')).toBe(true);
  expect(existsSync(wp.path('wp-content', 'wp-rocket-config'))).toBe(true);
});

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { expect, test } from './fixtures.js';

async function cachedFileCount(cacheDir: string): Promise<number> {
  if (!existsSync(cacheDir)) {
    return 0;
  }

  let count = 0;
  const entries = await readdir(cacheDir, { recursive: true, withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.php') && entry.name !== 'flags.json.php') {
      count += 1;
    }
  }

  return count;
}

test('disables cache writes when ttl is lower than one', async ({ cachePlugin, wp }) => {
  await wp.writeSurgeConfig("return [ 'ttl' => 0 ];");
  await wp.cli(['surge', 'flush', '--delete']);
  await wp.restart();

  const first = await fetch(`${wp.url}/__cache_harness/plain`);
  const second = await fetch(`${wp.url}/__cache_harness/plain`);
  await first.text();
  await second.text();

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(cachePlugin.detectStatus(first)).toBe('bypass');
  expect(cachePlugin.detectStatus(second)).toBe('bypass');

  await wp.writeSurgeConfig('return [];');
  await wp.restart();
});

test('serves cache hits with fpassthru_alt enabled', async ({ cachePlugin, wp }) => {
  await wp.writeSurgeConfig("return [ 'fpassthru_alt' => true ];");
  await wp.cli(['surge', 'flush', '--delete']);
  await wp.restart();

  const first = await fetch(`${wp.url}/__cache_harness/plain`);
  const firstBody = await first.text();
  const second = await fetch(`${wp.url}/__cache_harness/plain`);
  const secondBody = await second.text();

  expect(cachePlugin.detectStatus(first)).toBe('miss');
  expect(cachePlugin.detectStatus(second)).toBe('hit');
  expect(secondBody).toBe(firstBody);

  await wp.writeSurgeConfig('return [];');
  await wp.restart();
});

test('ignores wordpress_test_cookie in the cache key', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);

  const first = await fetch(`${wp.url}/__cache_harness/plain`);
  await first.text();
  const second = await fetch(`${wp.url}/__cache_harness/plain`, {
    headers: {
      Cookie: 'wordpress_test_cookie=WP%20Cookie%20check',
    },
  });
  await second.text();

  expect(cachePlugin.detectStatus(first)).toBe('miss');
  expect(cachePlugin.detectStatus(second)).toBe('hit');
});

test('uses non-ignored cookies as cache-key variants', async ({ cachePlugin, wp }) => {
  await wp.cli(['surge', 'flush']);

  const first = await fetch(`${wp.url}/__cache_harness/plain`, {
    headers: { Cookie: 'klaro=yes' },
  });
  await first.text();
  const second = await fetch(`${wp.url}/__cache_harness/plain`, {
    headers: { Cookie: 'klaro=no' },
  });
  await second.text();
  const third = await fetch(`${wp.url}/__cache_harness/plain`, {
    headers: { Cookie: 'klaro=yes' },
  });
  await third.text();

  expect(cachePlugin.detectStatus(first)).toBe('miss');
  expect(cachePlugin.detectStatus(second)).toBe('miss');
  expect(cachePlugin.detectStatus(third)).toBe('hit');
});

test('uses configured variants in the cache key', async ({ cachePlugin, wp }) => {
  await wp.writeSurgeConfig(
    "return [ 'variants' => [ 'cache_harness_variant' => $_SERVER['HTTP_X_CACHE_HARNESS_VARIANT'] ?? 'none' ] ];",
  );
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await fetch(`${wp.url}/__cache_harness/plain`, {
    headers: { 'X-Cache-Harness-Variant': 'a' },
  });
  await first.text();
  const second = await fetch(`${wp.url}/__cache_harness/plain`, {
    headers: { 'X-Cache-Harness-Variant': 'a' },
  });
  await second.text();
  const third = await fetch(`${wp.url}/__cache_harness/plain`, {
    headers: { 'X-Cache-Harness-Variant': 'b' },
  });
  await third.text();

  expect(cachePlugin.detectStatus(first)).toBe('miss');
  expect(cachePlugin.detectStatus(second)).toBe('hit');
  expect(cachePlugin.detectStatus(third)).toBe('miss');

  await wp.writeSurgeConfig('return [];');
  await wp.restart();
});

test('bypasses requests with Authorization headers', async ({ cachePlugin, wp }) => {
  const response = await fetch(`${wp.url}/__cache_harness/plain`, {
    headers: {
      Authorization: 'Bearer test-token',
    },
  });
  await response.text();

  expect(response.status).toBe(200);
  expect(cachePlugin.detectStatus(response)).toBe('bypass');
});

for (const route of [
  'cache-control-private',
  'cache-control-no-cache',
  'cache-control-no-store',
  'cache-control-max-age-zero',
]) {
  test(`bypasses ${route} responses`, async ({ cachePlugin, wp }) => {
    const response = await fetch(`${wp.url}/__cache_harness/${route}`);
    await response.text();

    expect(response.status).toBe(200);
    expect(cachePlugin.detectStatus(response)).toBe('bypass');
  });
}

test('bypasses response codes outside the cacheable status list', async ({ cachePlugin, wp }) => {
  const forbidden = await fetch(`${wp.url}/__cache_harness/forbidden`);
  await forbidden.text();
  const error = await fetch(`${wp.url}/__cache_harness/unknown`);
  await error.text();

  expect(forbidden.status).toBe(403);
  expect(error.status).toBe(500);
  expect(cachePlugin.detectStatus(forbidden)).toBe('bypass');
  expect(cachePlugin.detectStatus(error)).toBe('bypass');
});

test('caches permanent redirects', async ({ cachePlugin, wp }) => {
  const first = await fetch(`${wp.url}/__cache_harness/permanent-redirect`, {
    redirect: 'manual',
  });
  await first.text();
  const second = await fetch(`${wp.url}/__cache_harness/permanent-redirect`, {
    redirect: 'manual',
  });
  await second.text();

  expect(first.status).toBe(301);
  expect(second.status).toBe(301);
  expect(first.headers.get('location')).toBe('/__cache_harness/plain');
  expect(second.headers.get('location')).toBe('/__cache_harness/plain');
  expect(cachePlugin.detectStatus(first)).toBe('miss');
  expect(cachePlugin.detectStatus(second)).toBe('hit');
});

test('caches HEAD requests separately from GET requests', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);

  const get = await fetch(`${wp.url}/__cache_harness/plain`);
  await get.text();
  const firstHead = await fetch(`${wp.url}/__cache_harness/plain`, { method: 'HEAD' });
  await firstHead.arrayBuffer();
  const secondHead = await fetch(`${wp.url}/__cache_harness/plain`, { method: 'HEAD' });
  await secondHead.arrayBuffer();

  expect(cachePlugin.detectStatus(get)).toBe('miss');
  expect(cachePlugin.detectStatus(firstHead)).toBe('miss');
  expect(cachePlugin.detectStatus(secondHead)).toBe('hit');
});

test('records request and expire events from configured callbacks', async ({ cachePlugin, wp }) => {
  const logPath = wp.path('wp-content', 'surge-events.log');
  const phpLogPath = logPath.replaceAll("'", "\\'");

  await wp.writeSurgeConfig(`return [
	'events' => [
		'request' => [
			function ( array $args ): void {
				file_put_contents( '${phpLogPath}', 'request:' . $args['status'] . PHP_EOL, FILE_APPEND );
			},
		],
		'expire' => [
			function ( array $args ): void {
				file_put_contents( '${phpLogPath}', 'expire:' . implode( ',', $args['flags'] ) . PHP_EOL, FILE_APPEND );
			},
		],
	],
];`);
  await cachePlugin.flush(wp);
  await wp.restart();

  const first = await fetch(`${wp.url}/__cache_harness/plain`);
  await first.text();
  const second = await fetch(`${wp.url}/__cache_harness/plain`);
  await second.text();
  await wp.cli(['surge', 'flush']);

  const log = await readFile(logPath, 'utf8');

  expect(log).toContain('request:miss');
  expect(log).toContain('request:hit');
  expect(log).toContain('expire:/');

  await wp.writeSurgeConfig('return [];');
  await wp.restart();
});

test('reports cache status and deletes cache files through WP-CLI', async ({ cachePlugin, wp }) => {
  await cachePlugin.flush(wp);

  const response = await fetch(`${wp.url}/__cache_harness/plain`);
  await response.text();
  const cacheDir = cachePlugin.cacheDirectory(wp);

  expect(cacheDir).not.toBeNull();
  expect(await cachedFileCount(cacheDir ?? '')).toBeGreaterThan(0);

  const status = await wp.cli(['surge', 'status']);

  expect(status).toContain('Cache size:');
  expect(status).toContain('Cached items:');

  await wp.cli(['surge', 'flush', '--delete']);

  expect(await cachedFileCount(cacheDir ?? '')).toBe(0);
});

test('installs the advanced-cache drop-in and records successful install state', async ({ wp }) => {
  const installed = await wp.cli(['option', 'get', 'surge_installed']);
  const dropIn = await readFile(wp.path('wp-content', 'advanced-cache.php'), 'utf8');

  expect(installed.trim()).toBe('1');
  expect(dropIn).toContain('namespace Surge;');
});

test('registers x-cache as a Site Health page-cache header', async ({ wp }) => {
  const output = await wp.cli([
    'eval',
    "var_export(array_key_exists('x-cache', apply_filters('site_status_page_cache_supported_cache_headers', [])));",
  ]);

  expect(output.trim()).toBe('true');
});

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type TestInfo } from '@playwright/test';
import type { CachePluginAdapter } from '../../harness/src/cache-plugin.js';
import type { WordPressInstance } from '../../harness/src/wordpress-instance.js';
import { getFreePort } from '../../harness/src/ports.js';
import { getResults, runTests } from '../../cache-tests/test-engine/client/runner.mjs';
import { testResults } from '../../cache-tests/test-engine/client/test.mjs';
import { test } from '../surge/fixtures.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type CacheTest = {
  id: string;
  name: string;
  browser_only?: boolean;
  browser_skip?: boolean;
  cdn_only?: boolean;
};

export type CacheTestSuite = {
  name: string;
  id: string;
  description?: string;
  tests: CacheTest[];
};

export function defineSurgeCacheSuite(suite: CacheTestSuite): void {
  test.describe(suite.name, () => {
    for (const cacheTest of suite.tests) {
      const surgeTest = cacheTest.browser_only === true ? test.skip : test;

      surgeTest(`${cacheTest.id}: ${cacheTest.name}`, async ({ cachePlugin, wp }, testInfo) => {
        await runSurgeCacheTest({ suite, cacheTest, cachePlugin, wp, testInfo });
      });
    }
  });
}

class CacheTestsOrigin {
  private constructor(
    readonly url: string,
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly dir: string,
  ) {}

  static async start(): Promise<CacheTestsOrigin> {
    const port = await getFreePort();
    const dir = await mkdtemp(path.join(tmpdir(), 'cache-tests-surge-'));
    const proc = spawn('node', ['cache-tests/test-engine/server/server.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        npm_config_protocol: 'http',
        npm_config_port: String(port),
        npm_config_pidfile: path.join(dir, 'server.pid'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const origin = new CacheTestsOrigin(`http://127.0.0.1:${port}`, proc, dir);
    await origin.waitUntilReady();
    return origin;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null) {
        resolve();
        return;
      }

      const timeout = setTimeout(resolve, 3000);
      this.proc.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.proc.kill('SIGTERM');
    });

    await rm(this.dir, { force: true, recursive: true });
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(this.url);
        await response.text();
        return;
      } catch (error) {
        lastError = error;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`cache-tests origin did not become ready: ${String(lastError)}`);
  }
}

export async function runSurgeCacheTest(input: {
  suite: CacheTestSuite;
  cacheTest: CacheTest;
  cachePlugin: CachePluginAdapter;
  wp: WordPressInstance;
  testInfo: TestInfo;
}): Promise<void> {
  const { suite, cacheTest, cachePlugin, wp, testInfo } = input;

  testInfo.skip(
    cacheTest.browser_only === true,
    'This cache-tests case only applies to browser caches; Surge is tested as a reverse proxy cache.',
  );

  const origin = await CacheTestsOrigin.start();

  try {
    await wp.writeHarnessConfig(proxyConfig(origin.url));
    await cachePlugin.flush(wp);
    await wp.restart();

    delete testResults[cacheTest.id];
    await runTests([{ ...suite, tests: [cacheTest] }], false, wp.url, 1);

    const results = getResults();
    const result = results[cacheTest.id];

    await testInfo.attach(`${cacheTest.id}.json`, {
      body: JSON.stringify({ [cacheTest.id]: result }, null, 2),
      contentType: 'application/json',
    });

    expect(Object.prototype.hasOwnProperty.call(results, cacheTest.id)).toBe(true);
    expect(result, formatCacheTestFailure(cacheTest.id, result)).toBe(true);
  } finally {
    await origin.stop();
  }
}

function formatCacheTestFailure(cacheTestId: string, result: unknown): string {
  return `cache-tests case ${cacheTestId} failed: ${JSON.stringify(result)}`;
}

function proxyConfig(originUrl: string): string {
  const escapedOrigin = originUrl.replaceAll("'", "\\'");

  return `
add_action( 'init', function (): void {
	$path = parse_url( $_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH );

	if ( ! preg_match( '#^/(config|test|state)(/|$)#', $path ) ) {
		return;
	}

	$target = '${escapedOrigin}' . $_SERVER['REQUEST_URI'];
	$headers = function_exists( 'getallheaders' ) ? getallheaders() : [];
	unset( $headers['Host'], $headers['host'], $headers['Content-Length'], $headers['content-length'] );

	$response = wp_remote_request(
		$target,
		[
			'method'      => $_SERVER['REQUEST_METHOD'] ?? 'GET',
			'headers'     => $headers,
			'body'        => file_get_contents( 'php://input' ),
			'redirection' => 0,
			'timeout'     => 20,
		]
	);

	if ( is_wp_error( $response ) ) {
		status_header( 502 );
		header( 'Content-Type: text/plain; charset=UTF-8' );
		echo $response->get_error_message();
		exit;
	}

	status_header( wp_remote_retrieve_response_code( $response ) );

	foreach ( wp_remote_retrieve_headers( $response )->getAll() as $name => $value ) {
		if ( is_array( $value ) ) {
			foreach ( $value as $single_value ) {
				header( $name . ': ' . $single_value, false );
			}
		} else {
			header( $name . ': ' . $value, false );
		}
	}

	echo wp_remote_retrieve_body( $response );
	exit;
}, 0 );
`;
}

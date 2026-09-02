import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir, resetDir, writeTextFile } from './fs.js';
import { getFreePort } from './ports.js';
import { downloadToFile, run } from './process.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export class WordPressInstance {
  readonly dir: string;
  readonly port: number;
  readonly url: string;

  private server?: ChildProcessWithoutNullStreams;
  private serverLog?: WriteStream;
  private postSlugs = new Map<number, string>();

  private constructor(dir: string, port: number) {
    this.dir = dir;
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
  }

  static async create(name: string): Promise<WordPressInstance> {
    const port = await getFreePort();
    const dir = path.join(repoRoot, '.wp-harness', name.replace(/[^a-zA-Z0-9_.-]/g, '-'));
    return new WordPressInstance(dir, port);
  }

  path(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  async install(): Promise<void> {
    await resetDir(this.dir);
    await this.cli(['core', 'download', '--version=latest', '--force'], 180_000);

    await this.cli([
      'config',
      'create',
      '--dbname=wordpress',
      '--dbuser=root',
      '--dbpass=',
      '--dbhost=localhost',
      '--skip-check',
      '--force',
      `--extra-php=${this.extraConfig()}`,
    ]);

    await this.installSqliteDropIn();

    await this.cli([
      'core',
      'install',
      `--url=${this.url}`,
      '--title=Cache Harness',
      '--admin_user=admin',
      '--admin_password=admin',
      '--admin_email=admin@example.test',
      '--skip-email',
    ]);

    await this.cli(['rewrite', 'structure', '/%postname%/']);
    await this.cli(['rewrite', 'flush']);
    await this.writeSurgeConfig('return [];');
    await this.writeHarnessConfig('');

    await this.installHarnessMuPlugin();
  }

  async installHarnessMuPlugin(): Promise<void> {
    await mkdir(this.path('wp-content', 'mu-plugins'), { recursive: true });
    await copyDir(
      path.join(repoRoot, 'harness', 'mu-plugins', 'cache-harness.php'),
      this.path('wp-content', 'mu-plugins', 'cache-harness.php'),
    );
  }

  async start(): Promise<void> {
    this.serverLog = createWriteStream(this.path('server.log'), { flags: 'a' });
    this.server = spawn('wp', ['server', '--host=127.0.0.1', `--port=${this.port}`, `--docroot=${this.dir}`], {
      cwd: this.dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.server.stdout.on('data', (chunk) => this.serverLog?.write(chunk));
    this.server.stderr.on('data', (chunk) => this.serverLog?.write(chunk));

    try {
      await this.waitUntilReady();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    const serverLog = this.serverLog;
    this.server = undefined;
    this.serverLog = undefined;

    await new Promise<void>((resolve) => {
      let resolved = false;
      let killed = false;

      const done = () => {
        if (resolved) {
          return;
        }

        resolved = true;
        serverLog?.end();
        resolve();
      };

      server.once('close', done);
      this.killServerProcessGroup(server, 'SIGTERM');
      setTimeout(() => {
        if (!resolved && server.exitCode === null && !killed) {
          killed = true;
          this.killServerProcessGroup(server, 'SIGKILL');
        }
      }, 2_000);
      setTimeout(done, 3_000);
    });
  }

  async dispose(): Promise<void> {
    await this.stop();

    if (process.env.KEEP_WP_HARNESS === '1') {
      return;
    }

    await rm(this.dir, { force: true, recursive: true });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async cli(args: string[], timeoutMs = 120_000): Promise<string> {
    const result = await run('wp', args, {
      cwd: this.dir,
      timeoutMs,
    });

    return result.stdout;
  }

  async createPost(input: {
    title: string;
    content: string;
    password?: string;
    slug?: string;
    status?: string;
  }): Promise<number> {
    const slug = input.slug ?? this.slugFromTitle(input.title);
    const args = [
      'post',
      'create',
      '--post_type=post',
      `--post_status=${input.status ?? 'publish'}`,
      `--post_title=${input.title}`,
      `--post_content=${input.content}`,
      `--post_name=${slug}`,
      '--porcelain',
    ];

    if (input.password !== undefined) {
      args.push(`--post_password=${input.password}`);
    }

    const output = await this.cli(args);

    const id = Number.parseInt(output.trim(), 10);
    this.postSlugs.set(id, slug);

    return id;
  }

  async updatePost(id: number, input: { title?: string; content?: string }): Promise<void> {
    const args = ['post', 'update', String(id)];

    if (input.title !== undefined) {
      args.push(`--post_title=${input.title}`);
    }

    if (input.content !== undefined) {
      args.push(`--post_content=${input.content}`);
    }

    await this.cli(args);
  }

  postUrl(id: number): string {
    const slug = this.postSlugs.get(id);

    if (!slug) {
      throw new Error(`No known post slug for post ${id}.`);
    }

    return `${this.url}/${slug}/`;
  }

  async writeSurgeConfig(phpReturnExpression: string): Promise<void> {
    await writeTextFile(
      this.path('wp-content', 'surge-config.php'),
      `<?php\n\n${phpReturnExpression}\n`,
    );
  }

  async writeHarnessConfig(phpCode: string): Promise<void> {
    await writeTextFile(
      this.path('wp-content', 'cache-harness-config.php'),
      `<?php\n\n${phpCode}\n`,
    );
  }

  async writeBatcacheConfig(phpCode: string): Promise<void> {
    await writeTextFile(
      this.path('wp-content', 'batcache-config.php'),
      `<?php\n\n${phpCode}\n`,
    );
  }

  private slugFromTitle(title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    return slug || 'cache-harness-post';
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(this.url);
        await response.arrayBuffer();
        if (response.status < 500) {
          return;
        }
      } catch (error) {
        lastError = error;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`WordPress server did not become ready: ${String(lastError)}`);
  }

  private async installSqliteDropIn(): Promise<void> {
    const zipFile = this.path('sqlite-database-integration.zip');
    const pluginsDir = this.path('wp-content', 'plugins');

    await mkdir(pluginsDir, { recursive: true });
    await downloadToFile(
      'https://downloads.wordpress.org/plugin/sqlite-database-integration.latest-stable.zip',
      zipFile,
    );
    await run('unzip', ['-q', zipFile, '-d', pluginsDir], {
      cwd: this.dir,
      timeoutMs: 60_000,
    });

    const dbPhp = this.path('wp-content', 'plugins', 'sqlite-database-integration', 'db.copy');
    if (existsSync(dbPhp)) {
      await copyDir(dbPhp, this.path('wp-content', 'db.php'));
    }
  }

  private killServerProcessGroup(server: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (server.pid === undefined) {
      server.kill(signal);
      return;
    }

    try {
      process.kill(-server.pid, signal);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;

      if (code !== 'ESRCH') {
        server.kill(signal);
      }
    }
  }

  private extraConfig(): string {
    return [
      "define( 'WP_CACHE', true );",
      "define( 'WP_CACHE_CONFIG', __DIR__ . '/wp-content/surge-config.php' );",
      "define( 'WPCACHEHOME', __DIR__ . '/wp-content/plugins/wp-super-cache/' );",
      "define( 'FS_METHOD', 'direct' );",
      "define( 'WP_ENVIRONMENT_TYPE', 'local' );",
      "define( 'WP_DEBUG', true );",
      "define( 'WP_DEBUG_LOG', true );",
      "define( 'WP_DEBUG_DISPLAY', false );",
    ].join('\n');
  }
}

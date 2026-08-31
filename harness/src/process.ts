import { spawn } from 'node:child_process';

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) {
              return;
            }

            settled = true;
            child.kill('SIGTERM');
            reject(new Error(`Command timed out: ${command} ${args.join(' ')}`));
          }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          [
            `Command failed with exit code ${code}: ${command} ${args.join(' ')}`,
            stdout.trim(),
            stderr.trim(),
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    });
  });
}

export async function downloadToFile(url: string, file: string, timeoutMs = 180_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('curl_chrome145', ['-L', '-s', '-o', file, url], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Download timed out: ${url}`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Download failed with exit code ${code}: ${url}\n${stderr.trim()}`));
    });
  });
}

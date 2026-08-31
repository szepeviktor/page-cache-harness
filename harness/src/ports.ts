import { createServer } from 'node:net';

export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local port.'));
        return;
      }

      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

import { expect, test } from './fixtures.js';

function generatedAt(html: string): string | null {
  const match = html.match(/<meta name="cache-harness-generated-at" content="(\d+)">/);
  return match?.[1] ?? null;
}

test('caches real WordPress single post pages', async ({ cachePlugin, wp }) => {
  const postId = await wp.createPost({
    title: 'Harness cached post',
    content: 'Original post body for cache lifecycle.',
  });

  const first = await fetch(wp.postUrl(postId));
  const firstBody = await first.text();

  expect(first.status).toBe(200);
  expect(cachePlugin.detectStatus(first)).toBe('miss');
  expect(firstBody).toContain('Harness cached post');
  expect(firstBody).toContain('Original post body for cache lifecycle.');
  expect(generatedAt(firstBody)).not.toBeNull();

  const second = await fetch(wp.postUrl(postId));
  const secondBody = await second.text();

  expect(second.status).toBe(200);
  expect(cachePlugin.detectStatus(second)).toBe('hit');
  expect(secondBody).toBe(firstBody);
  expect(generatedAt(secondBody)).toBe(generatedAt(firstBody));
});

test('expires cached WordPress single post pages after post updates', async ({
  cachePlugin,
  wp,
}) => {
  const postId = await wp.createPost({
    title: 'Harness invalidation post',
    content: 'Body before update.',
  });

  const first = await fetch(wp.postUrl(postId));
  const firstBody = await first.text();
  const second = await fetch(wp.postUrl(postId));
  await second.text();

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(cachePlugin.detectStatus(first)).toBe('miss');
  expect(cachePlugin.detectStatus(second)).toBe('hit');
  expect(firstBody).toContain('Body before update.');

  await wp.cli(['eval', 'sleep(2);']);
  await wp.updatePost(postId, {
    content: 'Body after update.',
  });

  const afterUpdate = await fetch(wp.postUrl(postId));
  const afterUpdateBody = await afterUpdate.text();

  expect(afterUpdate.status).toBe(200);
  expect(cachePlugin.detectStatus(afterUpdate)).toBe('expired');
  expect(afterUpdateBody).toContain('Body after update.');
  expect(afterUpdateBody).not.toContain('Body before update.');

  const next = await fetch(wp.postUrl(postId));
  const nextBody = await next.text();

  expect(next.status).toBe(200);
  expect(cachePlugin.detectStatus(next)).toBe('hit');
  expect(nextBody).toContain('Body after update.');
});

test('bypasses the WordPress password form for password-protected posts before login', async ({
  cachePlugin,
  wp,
}) => {
  const postId = await wp.createPost({
    title: 'Harness protected post',
    content: 'Protected body should not appear before password entry.',
    password: 'secret',
  });

  const first = await fetch(wp.postUrl(postId));
  const firstBody = await first.text();
  const second = await fetch(wp.postUrl(postId));
  const secondBody = await second.text();

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(cachePlugin.detectStatus(first)).toBe('bypass');
  expect(cachePlugin.detectStatus(second)).toBe('bypass');
  expect(firstBody).toContain('This content is password-protected');
  expect(firstBody).toContain('post_password');
  expect(firstBody).not.toContain('Protected body should not appear before password entry.');
  expect(secondBody).toContain('This content is password-protected');
  expect(secondBody).not.toContain('Protected body should not appear before password entry.');
});

test('bypasses HTTP POST requests', async ({ cachePlugin, wp }) => {
  const response = await fetch(`${wp.url}/__cache_harness/plain`, {
    method: 'POST',
  });

  expect(response.status).toBe(200);
  expect(cachePlugin.detectStatus(response)).toBe('bypass');
});

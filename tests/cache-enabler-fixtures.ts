import { test as base } from '@playwright/test';
import {
  CacheEnablerAdapter,
  type CachePluginAdapter,
} from '../harness/src/cache-plugin.js';
import { WordPressInstance } from '../harness/src/wordpress-instance.js';

type Fixtures = {
  wp: WordPressInstance;
  cachePlugin: CachePluginAdapter;
};

export const test = base.extend<Fixtures>({
  wp: [
    async ({}, use, testInfo) => {
      const wp = await WordPressInstance.create(`cache-enabler-worker-${testInfo.workerIndex}`);
      await wp.install();
      await use(wp);
      await wp.dispose();
    },
    { scope: 'worker' },
  ],

  cachePlugin: [
    async ({ wp }, use) => {
      const plugin = new CacheEnablerAdapter();
      await plugin.install(wp);
      await plugin.activate(wp);
      await plugin.flush(wp);
      await wp.start();

      await use(plugin);
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';

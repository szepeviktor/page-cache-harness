import { test as base } from '@playwright/test';
import {
  WPSuperCacheAdapter,
} from '../../harness/src/cache-plugin.js';
import { WordPressInstance } from '../../harness/src/wordpress-instance.js';

type Fixtures = {
  wp: WordPressInstance;
  cachePlugin: WPSuperCacheAdapter;
};

export const test = base.extend<Fixtures>({
  wp: [
    async ({}, use, testInfo) => {
      const wp = await WordPressInstance.create(`wp-super-cache-worker-${testInfo.workerIndex}`);
      await wp.install();
      await use(wp);
      await wp.dispose();
    },
    { scope: 'worker' },
  ],

  cachePlugin: [
    async ({ wp }, use) => {
      const plugin = new WPSuperCacheAdapter();
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

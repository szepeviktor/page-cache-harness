# Page Cache Harness

Playwright-based integration tests for WordPress page-cache plugins. The harness creates temporary local WordPress installs under `.wp-harness`, installs one cache plugin per worker fixture, starts `wp server`, and verifies observable HTTP cache behavior.

## Requirements

- Node.js with npm
- WP-CLI available as `wp`
- PHP available as `php8.5`
- Network access for WordPress core and plugin downloads

## Commands

```bash
npm install
npm test
npm test -- tests/wp-spider-cache/wp-spider-cache.spec.ts
npm run clean:wp
```

Use `npm test` for the full suite, or pass specific spec files for focused plugin runs.

## WordPress Cleanup

Completed test workers remove their `.wp-harness/<worker>` installation during teardown. To keep a failed or focused run available for inspection:

```bash
KEEP_WP_HARNESS=1 npm test -- tests/batcache/batcache.spec.ts
```

If a run is interrupted before teardown, remove leftover installs with:

```bash
npm run clean:wp
```

## External Sites

`EXTERNAL_CACHE_TESTING_PLAN.md` sketches a future black-box mode for testing public WordPress sites without filesystem, WP-CLI, admin, plugin, or database access.

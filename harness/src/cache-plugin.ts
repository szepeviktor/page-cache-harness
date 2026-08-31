import type { WordPressInstance } from './wordpress-instance.js';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextFile } from './fs.js';

export type CacheStatus = 'hit' | 'miss' | 'bypass' | 'expired' | 'unknown';

export interface CachePluginAdapter {
  readonly name: string;
  install(wp: WordPressInstance): Promise<void>;
  activate(wp: WordPressInstance): Promise<void>;
  flush(wp: WordPressInstance): Promise<void>;
  cacheDirectory(wp: WordPressInstance): string | null;
  detectStatus(response: Response): CacheStatus;
}

export class SurgeAdapter implements CachePluginAdapter {
  readonly name = 'surge';

  async install(wp: WordPressInstance): Promise<void> {
    await wp.copyPlugin('surge');
  }

  async activate(wp: WordPressInstance): Promise<void> {
    await wp.cli(['plugin', 'activate', 'surge']);
  }

  async flush(wp: WordPressInstance): Promise<void> {
    await wp.cli(['surge', 'flush', '--delete']);
  }

  cacheDirectory(wp: WordPressInstance): string {
    return wp.path('wp-content', 'cache', 'surge');
  }

  detectStatus(response: Response): CacheStatus {
    const value = response.headers.get('x-cache')?.toLowerCase();

    if (value === 'hit' || value === 'miss' || value === 'bypass' || value === 'expired') {
      return value;
    }

    return 'unknown';
  }
}

export class CacheEnablerAdapter implements CachePluginAdapter {
  readonly name = 'cache-enabler';

  async install(wp: WordPressInstance): Promise<void> {
    await wp.cli(['plugin', 'install', 'cache-enabler']);
  }

  async activate(wp: WordPressInstance): Promise<void> {
    await wp.cli(['plugin', 'activate', 'cache-enabler']);
  }

  async flush(wp: WordPressInstance): Promise<void> {
    await wp.cli(['cache-enabler', 'clear']);
  }

  cacheDirectory(wp: WordPressInstance): string {
    return wp.path('wp-content', 'cache', 'cache-enabler');
  }

  detectStatus(response: Response): CacheStatus {
    const value = response.headers.get('x-cache-handler')?.toLowerCase() ?? '';

    if (value.includes('cache-enabler')) {
      return 'hit';
    }

    return 'unknown';
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export class BatcacheAdapter implements CachePluginAdapter {
  readonly name = 'batcache';

  async install(wp: WordPressInstance): Promise<void> {
    await wp.copyPluginFrom('Compare/batcache', 'batcache');
    await mkdir(wp.path('wp-content'), { recursive: true });
    await copyFile(
      path.join(repoRoot, 'harness', 'dropins', 'object-cache.php'),
      wp.path('wp-content', 'object-cache.php'),
    );
    await writeTextFile(
      wp.path('wp-content', 'advanced-cache.php'),
      [
        '<?php',
        '$GLOBALS[\'batcache\'] = [',
        "\t'max_age' => 300,",
        "\t'times' => 0,",
        "\t'seconds' => 0,",
        "\t'debug' => true,",
        '];',
        '$cache_harness_batcache_config = __DIR__ . \'/batcache-config.php\';',
        'if ( file_exists( $cache_harness_batcache_config ) ) {',
        "\trequire $cache_harness_batcache_config;",
        '}',
        "require __DIR__ . '/plugins/batcache/advanced-cache.php';",
        '',
      ].join('\n'),
    );
    await writeTextFile(wp.path('wp-content', 'batcache-config.php'), "<?php\n\n");
  }

  async activate(wp: WordPressInstance): Promise<void> {
    await wp.cli(['plugin', 'activate', 'batcache']);
  }

  async flush(wp: WordPressInstance): Promise<void> {
    await wp.cli(['eval', 'wp_cache_flush();']);
    await rm(wp.path('wp-content', 'cache', 'object-cache'), { force: true, recursive: true });
  }

  cacheDirectory(wp: WordPressInstance): string {
    return wp.path('wp-content', 'cache', 'object-cache');
  }

  detectStatus(response: Response): CacheStatus {
    return response.headers.get('x-batcache') === 'hit' ? 'hit' : 'unknown';
  }
}

export class WPSuperCacheAdapter implements CachePluginAdapter {
  readonly name = 'wp-super-cache';

  async install(wp: WordPressInstance): Promise<void> {
    await wp.cli(['plugin', 'install', 'wp-super-cache']);
    await this.writeConfig(wp, '');
    await copyFile(
      wp.path('wp-content', 'plugins', 'wp-super-cache', 'advanced-cache.php'),
      wp.path('wp-content', 'advanced-cache.php'),
    );
  }

  async activate(wp: WordPressInstance): Promise<void> {
    await wp.cli(['plugin', 'activate', 'wp-super-cache']);
  }

  async flush(wp: WordPressInstance): Promise<void> {
    await wp.cli(['eval', "if ( function_exists( 'wp_cache_clear_cache' ) ) { wp_cache_clear_cache(); }"]);
    await rm(wp.path('wp-content', 'cache', 'supercache'), { force: true, recursive: true });
  }

  cacheDirectory(wp: WordPressInstance): string {
    return wp.path('wp-content', 'cache', 'supercache');
  }

  detectStatus(response: Response): CacheStatus {
    return response.headers.get('x-wp-super-cache') ? 'hit' : 'unknown';
  }

  async writeConfig(wp: WordPressInstance, phpOverrides: string): Promise<void> {
    await writeTextFile(
      wp.path('wp-content', 'wp-cache-config.php'),
      [
        '<?php',
        "if ( ! defined( 'WPCACHEHOME' ) ) {",
        "\tdefine( 'WPCACHEHOME', WP_PLUGIN_DIR . '/wp-super-cache/' );",
        '}',
        '$cache_compression = 0;',
        '$cache_enabled = true;',
        '$super_cache_enabled = true;',
        '$cache_max_time = 3600;',
        "$cache_path = WP_CONTENT_DIR . '/cache/';",
        "$file_prefix = 'wp-cache-';",
        '$ossdlcdn = 0;',
        "$cache_acceptable_files = [ 'wp-comments-popup.php', 'wp-links-opml.php', 'wp-locations.php' ];",
        "$cache_rejected_uri = [ 'wp-.*\\\\.php', 'index\\\\.php' ];",
        '$cache_rejected_user_agent = [];',
        '$cache_rebuild_files = 1;',
        '$wp_cache_mutex_disabled = 1;',
        '$sem_id = 5419;',
        "$wp_cache_plugins_dir = WPCACHEHOME . 'plugins';",
        '$wp_cache_shutdown_gc = 0;',
        '$wp_super_cache_late_init = 0;',
        '$wp_super_cache_advanced_debug = 0;',
        '$wp_super_cache_front_page_text = \'\';',
        '$wp_super_cache_front_page_clear = 0;',
        '$wp_super_cache_front_page_check = 0;',
        '$wp_super_cache_front_page_notification = 0;',
        '$wp_cache_anon_only = 0;',
        '$wp_supercache_cache_list = 1;',
        '$wp_cache_debug_to_file = 0;',
        '$wp_super_cache_debug = 1;',
        '$wp_cache_debug_level = 5;',
        '$wp_cache_debug_ip = \'\';',
        '$wp_cache_debug_log = \'\';',
        '$wp_cache_pages = [ \'search\' => 0, \'feed\' => 0, \'category\' => 0, \'home\' => 0, \'frontpage\' => 0, \'tag\' => 0, \'archives\' => 0, \'pages\' => 0, \'single\' => 0, \'author\' => 0 ];',
        '$wp_cache_hide_donation = 1;',
        '$wp_cache_not_logged_in = 2;',
        '$wp_cache_clear_on_post_edit = 1;',
        '$wp_cache_hello_world = 0;',
        '$wp_cache_mobile_enabled = 0;',
        "$wp_cache_mobile_browsers = 'Android, BlackBerry, Cellphone, iPhone, iPod, IEMobile, Mobile, Opera Mini';",
        '$wp_cache_cron_check = 0;',
        '$wp_cache_mfunc_enabled = 0;',
        '$wp_cache_make_known_anon = 0;',
        '$wp_cache_refresh_single_only = 0;',
        '$wp_cache_mod_rewrite = 0;',
        '$wp_supercache_304 = 0;',
        '$wp_cache_front_page_checks = 0;',
        '$wp_cache_disable_utf8 = 0;',
        '$wp_cache_no_cache_for_get = 0;',
        '$wp_cache_slash_check = 1;',
        "$wp_cache_home_path = '/';",
        '$cache_scheduled_time = \'00:00\';',
        '$cache_time_interval = 600;',
        '$wp_cache_preload_interval = 600;',
        '$cache_schedule_type = \'interval\';',
        '$wp_cache_preload_posts = 0;',
        '$wp_cache_preload_on = 0;',
        '$wp_cache_preload_taxonomies = 0;',
        '$wp_cache_preload_email_me = 0;',
        '$wp_cache_preload_email_volume = \'none\';',
        '$wp_cache_mobile_prefixes = \'\';',
        '$cached_direct_pages = [];',
        '$wpsc_served_header = true;',
        '$cache_gc_email_me = 0;',
        '$wpsc_save_headers = 0;',
        '$cache_schedule_interval = \'daily\';',
        '$wp_super_cache_comments = 1;',
        '$wpsc_ignore_tracking_parameters = true;',
        "$wpsc_tracking_parameters = [ 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', '_ga' ];",
        "$wpsc_rejected_cookies = [ 'comment_author_', 'wordpress_logged_in', 'wp-postpass_' ];",
        '$wpsc_version = 169;',
        phpOverrides,
        '',
      ].join('\n'),
    );
  }
}

export class WPSpiderCacheAdapter implements CachePluginAdapter {
  readonly name = 'wp-spider-cache';

  async install(wp: WordPressInstance): Promise<void> {
    await wp.copyPluginFrom('Compare/wp-spider-cache', 'wp-spider-cache');
    await mkdir(wp.path('wp-content'), { recursive: true });
    await copyFile(
      path.join(repoRoot, 'harness', 'dropins', 'object-cache.php'),
      wp.path('wp-content', 'object-cache.php'),
    );
    await writeTextFile(
      wp.path('wp-content', 'advanced-cache.php'),
      [
        '<?php',
        "defined( 'ABSPATH' ) || exit;",
        "if ( ! defined( 'WP_PLUGIN_DIR' ) ) {",
        "\tdefine( 'WP_PLUGIN_DIR', WP_CONTENT_DIR . '/plugins' );",
        '}',
        "require_once WP_CONTENT_DIR . '/object-cache.php';",
        "require_once WP_PLUGIN_DIR . '/wp-spider-cache/wp-spider-cache/includes/class-output-cache.php';",
        'function wp_skip_output_cache() {',
        "\tif ( ! defined( 'WP_CACHE' ) || true !== WP_CACHE ) {",
        "\t\treturn true;",
        "\t}",
        "\tif ( in_array( basename( $_SERVER['SCRIPT_FILENAME'] ), [ 'wp-app.php', 'wp-cron.php', 'ms-files.php', 'xmlrpc.php' ], true ) ) {",
        "\t\treturn true;",
        "\t}",
        "\tif ( strstr( $_SERVER['SCRIPT_FILENAME'], 'wp-includes/js' ) ) {",
        "\t\treturn true;",
        "\t}",
        "\treturn ! empty( $GLOBALS['HTTP_RAW_POST_DATA'] ) || ! empty( $_POST );",
        '}',
        'function wp_output_cache_init() {',
        "\t$GLOBALS['wp_output_cache'] = new WP_Spider_Cache_Output();",
        '}',
        'function wp_output_cache() {',
        "\tif ( ! isset( $GLOBALS['wp_output_cache'] ) ) {",
        "\t\twp_output_cache_init();",
        "\t}",
        "\treturn $GLOBALS['wp_output_cache'];",
        '}',
        'function wp_output_cache_cancel() {',
        "\twp_output_cache()->cancel = true;",
        '}',
        'function wp_output_cache_vary( $function = \'\' ) {',
        "\tif ( empty( $function ) ) {",
        "\t\tdie( 'Variant determiner cannot be empty.' );",
        "\t}",
        "\twp_output_cache()->add_variant( $function );",
        '}',
        '$GLOBALS[\'wp_output_cache\'] = [',
        "\t'max_age' => 300,",
        "\t'times' => 1,",
        "\t'seconds' => 0,",
        "\t'debug' => true,",
        "\t'headers' => [ 'X-Spider-Cache' => '1' ],",
        '];',
        '$cache_harness_spider_cache_config = WP_CONTENT_DIR . \'/spider-cache-config.php\';',
        'if ( file_exists( $cache_harness_spider_cache_config ) ) {',
        "\trequire $cache_harness_spider_cache_config;",
        '}',
        'if ( ! wp_skip_output_cache() ) {',
        "\twp_output_cache_init();",
        '}',
        '',
      ].join('\n'),
    );
    await this.writeConfig(wp, '');
  }

  async activate(wp: WordPressInstance): Promise<void> {
    await wp.cli(['plugin', 'activate', 'wp-spider-cache']);
  }

  async flush(wp: WordPressInstance): Promise<void> {
    await wp.cli(['eval', 'wp_cache_flush();']);
    await rm(wp.path('wp-content', 'cache', 'object-cache'), { force: true, recursive: true });
  }

  cacheDirectory(wp: WordPressInstance): string {
    return wp.path('wp-content', 'cache', 'object-cache');
  }

  detectStatus(response: Response): CacheStatus {
    return response.headers.get('x-spider-cache') === '1' ? 'hit' : 'unknown';
  }

  async writeConfig(wp: WordPressInstance, phpCode: string): Promise<void> {
    await writeTextFile(wp.path('wp-content', 'spider-cache-config.php'), `<?php\n\n${phpCode}\n`);
  }
}

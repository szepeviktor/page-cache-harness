<?php
/**
 * Plugin Name: Cache Harness
 * Description: Deterministic endpoints for black-box page-cache testing.
 */

$cache_harness_config = WP_CONTENT_DIR . '/cache-harness-config.php';

if ( file_exists( $cache_harness_config ) ) {
	require $cache_harness_config;
}

function cache_harness_timestamp_meta(): void {
	printf(
		"\n<meta name=\"cache-harness-generated-at\" content=\"%d\">\n",
		time()
	);
}

add_action( 'wp_head', function (): void {
	if ( is_admin() || wp_doing_ajax() ) {
		return;
	}

	cache_harness_timestamp_meta();
}, 0 );

add_action( 'init', function (): void {
	$path = parse_url( $_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH );

	if ( 0 !== strpos( $path, '/__cache_harness/' ) ) {
		return;
	}

	if ( '/__cache_harness/update-post' === $path ) {
		status_header( 200 );
		header( 'Content-Type: application/json; charset=UTF-8' );

		$post_id = absint( $_POST['post_id'] ?? 0 );
		$content = (string) ( $_POST['content'] ?? '' );

		if ( ! $post_id || '' === $content ) {
			status_header( 400 );
			echo wp_json_encode( [ 'updated' => false ] );
			exit;
		}

		$result = wp_update_post(
			[
				'ID' => $post_id,
				'post_content' => $content,
			],
			true
		);

		if ( is_wp_error( $result ) ) {
			status_header( 500 );
			echo wp_json_encode( [ 'updated' => false ] );
			exit;
		}

		if ( class_exists( 'WP_Spider_Cache_UI' ) && method_exists( 'WP_Spider_Cache_UI', 'clean_url' ) ) {
			WP_Spider_Cache_UI::clean_url( get_permalink( $post_id ) );
		}

		echo wp_json_encode( [ 'updated' => true ] );
		exit;
	}

	if ( '/__cache_harness/plain' === $path ) {
		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		echo '</head><body><main>plain html</main></body></html>';
		exit;
	}

	if ( '/__cache_harness/empty-html' === $path ) {
		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		exit;
	}

	if ( '/__cache_harness/debug-request' === $path ) {
		status_header( 200 );
		header( 'Content-Type: application/json; charset=UTF-8' );
		echo wp_json_encode(
			[
				'method' => $_SERVER['REQUEST_METHOD'] ?? '',
				'request_uri' => $_SERVER['REQUEST_URI'] ?? '',
				'get' => $_GET,
				'cookie' => $_COOKIE,
			],
			JSON_PRETTY_PRINT
		);
		exit;
	}

	if ( '/__cache_harness/json-timestamp' === $path ) {
		status_header( 200 );
		header( 'Content-Type: application/json; charset=UTF-8' );
		echo wp_json_encode(
			[
				'generated_at' => sprintf( '%.6F', microtime( true ) ),
			]
		);
		exit;
	}

	if ( '/__cache_harness/set-cookie' === $path ) {
		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		setcookie( 'cache_harness_cookie', (string) time(), 0, '/' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		echo '</head><body><main>sets cookie</main></body></html>';
		exit;
	}

	if ( '/__cache_harness/raw-cookie-variant' === $path ) {
		$variant = 'none';
		$raw_cookie = (string) ( $_SERVER['HTTP_COOKIE'] ?? '' );

		if ( preg_match( '/(?:^|; )_cache_harness_variant=([^;]+)/', $raw_cookie, $matches ) ) {
			$variant = sanitize_key( $matches[1] );
		} elseif ( preg_match( '/(?:^|; )wordpress_test_cookie=([^;]+)/', $raw_cookie, $matches ) ) {
			$variant = sanitize_key( $matches[1] );
		}

		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		printf( '</head><body><main>raw cookie variant: %s</main></body></html>', esc_html( $variant ) );
		exit;
	}

	if ( '/__cache_harness/raw-query-variant' === $path ) {
		$variant = 'none';
		$raw_query = (string) ( $_SERVER['QUERY_STRING'] ?? '' );

		if ( preg_match( '/(?:^|&)utm_source=([^&]+)/', $raw_query, $matches ) ) {
			$variant = sanitize_key( $matches[1] );
		}

		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		printf( '</head><body><main>raw query variant: %s</main></body></html>', esc_html( $variant ) );
		exit;
	}

	if ( '/__cache_harness/cache-control-private' === $path ) {
		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		header( 'Cache-Control: private' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		echo '</head><body><main>private</main></body></html>';
		exit;
	}

	if ( '/__cache_harness/cache-control-no-cache' === $path ) {
		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		header( 'Cache-Control: no-cache' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		echo '</head><body><main>no cache</main></body></html>';
		exit;
	}

	if ( '/__cache_harness/cache-control-no-store' === $path ) {
		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		header( 'Cache-Control: no-store' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		echo '</head><body><main>no store</main></body></html>';
		exit;
	}

	if ( '/__cache_harness/cache-control-max-age-zero' === $path ) {
		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		header( 'Cache-Control: max-age=0' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		echo '</head><body><main>max age zero</main></body></html>';
		exit;
	}

	if ( '/__cache_harness/cache-control-s-maxage-zero' === $path ) {
		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		header( 'Cache-Control: s-maxage=0' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		echo '</head><body><main>shared max age zero</main></body></html>';
		exit;
	}

	if ( '/__cache_harness/vary-header' === $path ) {
		$variant = sanitize_key( $_SERVER['HTTP_X_CACHE_HARNESS_VARY'] ?? 'default' );
		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		header( 'Vary: X-Cache-Harness-Vary' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		printf( '</head><body><main>vary variant: %s</main></body></html>', esc_html( $variant ) );
		exit;
	}

	if ( '/__cache_harness/fatal-after-output' === $path ) {
		status_header( 200 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		register_shutdown_function(
			static function (): void {
				cache_harness_trigger_undefined_shutdown_fatal();
			}
		);
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		echo '</head><body><main>partial fatal output</main>';
		exit;
	}

	if ( '/__cache_harness/not-found' === $path ) {
		status_header( 404 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		echo '</head><body><main>not found</main></body></html>';
		exit;
	}

	if ( '/__cache_harness/redirect' === $path ) {
		wp_redirect( '/__cache_harness/plain', 302 );
		exit;
	}

	if ( '/__cache_harness/permanent-redirect' === $path ) {
		wp_redirect( '/__cache_harness/plain', 301 );
		exit;
	}

	if ( '/__cache_harness/forbidden' === $path ) {
		status_header( 403 );
		header( 'Content-Type: text/html; charset=UTF-8' );
		echo '<!doctype html><html><head>';
		cache_harness_timestamp_meta();
		echo '</head><body><main>forbidden</main></body></html>';
		exit;
	}

	status_header( 500 );
	header( 'Content-Type: text/plain; charset=UTF-8' );
	echo 'Unknown cache harness route.';
	exit;
} );

<?php

class Cache_Harness_Object_Cache {
	public array $no_remote_groups = [];

	private string $dir;

	public function __construct() {
		$this->dir = WP_CONTENT_DIR . '/cache/object-cache';

		if ( ! is_dir( $this->dir ) ) {
			mkdir( $this->dir, 0777, true );
		}
	}

	public function add( $key, $data, $group = 'default', $expire = 0 ) {
		if ( false !== $this->get( $key, $group ) ) {
			return false;
		}

		return $this->set( $key, $data, $group, $expire );
	}

	public function delete( $key, $group = 'default' ) {
		$file = $this->file( $key, $group );

		return ! file_exists( $file ) || unlink( $file );
	}

	public function flush() {
		foreach ( glob( $this->dir . '/*.cache' ) ?: [] as $file ) {
			unlink( $file );
		}

		return true;
	}

	public function get( $key, $group = 'default', $force = false, &$found = null ) {
		$file = $this->file( $key, $group );

		if ( ! file_exists( $file ) ) {
			$found = false;
			return false;
		}

		$payload = unserialize( (string) file_get_contents( $file ) );

		if ( ! is_array( $payload ) || ! array_key_exists( 'value', $payload ) ) {
			$found = false;
			return false;
		}

		if ( ! empty( $payload['expires'] ) && time() > $payload['expires'] ) {
			unlink( $file );
			$found = false;
			return false;
		}

		$found = true;
		return $payload['value'];
	}

	public function incr( $key, $offset = 1, $group = 'default' ) {
		$value = $this->get( $key, $group );

		if ( false === $value ) {
			return false;
		}

		$value = (int) $value + (int) $offset;
		$this->set( $key, $value, $group );

		return $value;
	}

	public function set( $key, $data, $group = 'default', $expire = 0 ) {
		$payload = [
			'expires' => $expire ? time() + (int) $expire : 0,
			'value'   => $data,
		];

		return false !== file_put_contents( $this->file( $key, $group ), serialize( $payload ), LOCK_EX );
	}

	public function add_global_groups( $groups ) {
	}

	public function add_non_persistent_groups( $groups ) {
	}

	public function add_no_remote_groups( $groups ) {
		$this->no_remote_groups = array_unique( array_merge( $this->no_remote_groups, (array) $groups ) );
	}

	private function file( $key, $group ) {
		$prefix = preg_replace( '/[^a-z0-9_-]+/i', '-', (string) $group );

		return $this->dir . '/' . $prefix . '-' . md5( $group . ':' . $key ) . '.cache';
	}
}

function wp_cache_init() {
	$GLOBALS['wp_object_cache'] = new Cache_Harness_Object_Cache();
}

function wp_object_cache_init() {
	wp_cache_init();
}

function wp_object_cache() {
	if ( ! isset( $GLOBALS['wp_object_cache'] ) ) {
		wp_cache_init();
	}

	return $GLOBALS['wp_object_cache'];
}

function wp_cache_add( $key, $data, $group = '', $expire = 0 ) {
	return $GLOBALS['wp_object_cache']->add( $key, $data, $group ?: 'default', $expire );
}

function wp_cache_delete( $key, $group = '' ) {
	return $GLOBALS['wp_object_cache']->delete( $key, $group ?: 'default' );
}

function wp_cache_flush() {
	return $GLOBALS['wp_object_cache']->flush();
}

function wp_cache_get( $key, $group = '', $force = false, &$found = null ) {
	return $GLOBALS['wp_object_cache']->get( $key, $group ?: 'default', $force, $found );
}

function wp_cache_incr( $key, $offset = 1, $group = '' ) {
	return $GLOBALS['wp_object_cache']->incr( $key, $offset, $group ?: 'default' );
}

function wp_cache_set( $key, $data, $group = '', $expire = 0 ) {
	return $GLOBALS['wp_object_cache']->set( $key, $data, $group ?: 'default', $expire );
}

function wp_cache_add_global_groups( $groups ) {
	$GLOBALS['wp_object_cache']->add_global_groups( $groups );
}

function wp_cache_add_non_persistent_groups( $groups ) {
	$GLOBALS['wp_object_cache']->add_non_persistent_groups( $groups );
}

function wp_cache_add_no_remote_groups( $groups ) {
	$GLOBALS['wp_object_cache']->add_no_remote_groups( $groups );
}

function wp_cache_close() {
	return true;
}

function wp_cache_decr( $key, $offset = 1, $group = '' ) {
	return wp_cache_incr( $key, -$offset, $group );
}

function wp_cache_replace( $key, $data, $group = '', $expire = 0 ) {
	if ( false === wp_cache_get( $key, $group ) ) {
		return false;
	}

	return wp_cache_set( $key, $data, $group, $expire );
}

function wp_cache_get_multiple( $keys, $group = '', $force = false ) {
	$values = [];

	foreach ( $keys as $key ) {
		$values[ $key ] = wp_cache_get( $key, $group, $force );
	}

	return $values;
}

function wp_cache_set_multiple( $data, $group = '', $expire = 0 ) {
	foreach ( $data as $key => $value ) {
		wp_cache_set( $key, $value, $group, $expire );
	}

	return true;
}

function wp_cache_delete_multiple( $keys, $group = '' ) {
	foreach ( $keys as $key ) {
		wp_cache_delete( $key, $group );
	}

	return true;
}

function wp_cache_flush_group( $group ) {
	return wp_cache_flush();
}

function wp_cache_flush_runtime() {
	return true;
}

function wp_cache_switch_to_blog( $blog_id ) {
}

function wp_cache_supports( $feature ) {
	return in_array( $feature, [ 'add_multiple', 'set_multiple', 'get_multiple', 'delete_multiple', 'flush_runtime', 'flush_group' ], true );
}

wp_cache_init();

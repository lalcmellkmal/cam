module.exports = {
	DEBUG: false,
	REDIS_PORT: 6379,
	LISTEN_PORT: 8000,
	TRUST_X_FORWARDED_FOR: false,
	SOCKJS_PREFIX: '/sockjs',
	SOCKJS_URL: 'http://localhost:8000/sockjs',
	SOCKJS_SCRIPT_URL: 'http://localhost:8000/sockjs-1.1.1.min.js',
	GAME_ID: 1,
	NAME_EXPIRY: 60 * 60 * 24 * 14,
};

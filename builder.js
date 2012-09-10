var _ = require('underscore'),
    fs = require('fs'),
    child_process = require('child_process');

var SERVER_DEPS = ['server.js', 'game.js', 'assets.js', 'model.js', 'state-machine.js', 'config.js', 'common.js', 'client.js'];

var server;
var start_server = _.debounce(function () {
	if (server)
		server.kill('SIGTERM');
	server = child_process.spawn('node', ['server.js']);
	server.stdout.pipe(process.stdout);
	server.stderr.pipe(process.stderr);
}, 500);

SERVER_DEPS.forEach(monitor.bind(null, start_server));

function monitor(func, dep) {
	var mtime = new Date;
	fs.watchFile(dep, {interval: 500, persistent: true}, function (event) {
		if (event.mtime > mtime) {
			func();
			mtime = event.mtime;
		}
	});
}

start_server();

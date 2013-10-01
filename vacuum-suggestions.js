var config = require('./config');

var r = require('redis').createClient(config.REDIS_PORT);

r.llen('cam:suggestionList', function (err, count) {
	if (err) throw err;
	if (count == 0) {
		console.log('No suggestions to clear!');
		return r.quit();
	}
	var q = 'Delete all ' + count + ' suggestions (y/n)? ';
	var REDLINE = require('readline').createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	REDLINE.question(q, function (a) {
		REDLINE.close();
		if (a.toLowerCase() != 'y')
			return r.quit();
		r.multi()
			.del('cam:suggestions')
			.del('cam:suggestionList')
			.exec(function (err) {
				if (err) throw err;
				console.log('Deleted.');
				r.quit();
			});
	});
});

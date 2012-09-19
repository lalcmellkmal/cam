var config = require('./config'),
    fs = require('fs');

var r = require('redis').createClient(config.REDIS_PORT);

var origRef = process.argv[2] || 'HEAD';
var dest = 'cam:game:' + (process.argv[3] || '1');

require('child_process').exec('git show '+origRef, function (err, stdout, stderr) {

    console.log(stdout);
    var lines = stdout.split(/\n/);
    var adds = {black: [], white: []};
    var subs = {black: [], white: []};
    var moves = [];
    var mode = null;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var m = line.match(/^\+\+\+\s+\w+\/(.*?)\s*$/);
        if (m) {
            m = m[1].match(/^sets\/([^.]+)\.txt$/);
            if (!m) {
                mode = null;
                continue;
            }
            var txt = m[1];
            mode = txt.match(/black/) ? 'black' : 'white';
            continue;
        }

        if (!mode)
            continue;
        m = line.match(/^\+([^+#\s].+?)\s*$/);
        if (m) {
            var card = m[1];
            var moved = subs[mode].indexOf(card);
            if (moved >= 0) {
                subs[mode].splice(moved, 1);
                moves.push(card);
            }
            else
                adds[mode].push(card);
            continue;
        }
        m = line.match(/^\-([^\-#\s].+?)\s*$/);
        if (m) {
            var card = m[1];
            var moved = adds[mode].indexOf(card);
            if (moved >= 0) {
                adds[mode].splice(moved, 1);
                moves.push(card);
            }
            else
                subs[mode].push(card);
            continue;
        }
    }

    var wa = adds.white.length, ba = adds.black.length;
    var ws = subs.white.length, bs = subs.black.length;
    if (ws) {
        console.log('\n\nWHITES REMOVED:\n');
        console.log(subs.white);
    }
    if (wa) {
        console.log('\n\nWHITES ADDED:\n');
        console.log(adds.white);
    }
    if (bs) {
        console.log('\n\nBLACKS REMOVED:\n');
        console.log(subs.black);
    }
    if (ba) {
        console.log('\n\nBLACKS ADDED:\n');
        console.log(adds.black);
    }
    if (moves.length) {
        console.log('\n\nCARDS MOVED:\n');
        console.log(moves);
    }
    console.log('\n');
    if (!wa && !ba && !ws && !bs) {
        console.log('No changes.');
        return r.quit();
    }

    var reader = require('readline').createInterface(process.stdin, process.stdout, null);
    var q = "Update " + dest + ":whites/blacks? ";
    reader.question(q, function (answer) {
        if (answer != 'y')
            return done();
        var m = r.multi();
        if (ws) {
            m.srem(dest+':whites', subs.white);
            m.srem(dest+':whiteDiscards', subs.white);
        }
        if (wa)
            m.sadd(dest+':whites', adds.white);
        if (bs) {
            m.srem(dest+':blacks', subs.black);
            m.srem(dest+':blackDiscards', subs.black);
        }
        if (ba)
            m.sadd(dest+':blacks', adds.black);
        m.exec(function (err, rs) {
            if (err) throw err;
            if (ws)
                console.log("Removed " + (rs.shift()+rs.shift()) + "/" + ws + " whites.");
            if (wa)
                console.log("Inserted " + rs.shift() + "/" + wa + " new whites.");
            if (bs)
                console.log("Removed " + (rs.shift()+rs.shift()) + "/" + bs + " blacks.");
            if (ba)
                console.log("Inserted " + rs.shift() + "/" + ba + " new blacks.");
            done();
        });
    });

    function done() {
        reader.close();
        r.quit();
    }
});

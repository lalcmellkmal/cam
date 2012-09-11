var assets = require('./assets'),
    common = require('./common'),
    config = require('./config'),
    connect = require('connect'),
    game = require('./game'),
    events = require('events'),
    urlParse = require('url').parse,
    util = require('util');

function redisClient() {
    return require('redis').createClient(config.REDIS_PORT);
}

var SHARED_REDIS = redisClient();
game.setRedis(SHARED_REDIS);

function startServer() {                                                       
    var app = connect.createServer();
    app.use(serveScripts);
    app.use(connect.static(__dirname + '/www', {maxAge: 2592000000}));
    app.on('upgrade', function (req, resp) {
        resp.end();
    });

    // Dumb workaround for sockjs-connect incompatibility
    var http = require('http').createServer(app);
    var sockJs = require('sockjs').createServer();
    sockJs.on('connection', onConnection);
    sockJs.installHandlers(http, {
        sockjs_url: 'sockjs-0.3.min.js',
        prefix: config.SOCKJS_PREFIX,
        jsessionid: false,
        log: sockJsLog,
    });
    http.listen(config.LISTEN_PORT);
}

function onConnection(conn) {
    var client = new Client(conn);
    conn.on('data', client.onMessage.bind(client));
    conn.once('close', client.onDisconnected.bind(client));
}

function sockJsLog(sev, msg) {
    if (sev != 'debug' && sev != 'info')
        console.error(msg);
    else if (config.DEBUG)
        console.log(msg);
}

function Client(sock) {
    events.EventEmitter.call(this);
    this.sock = sock;
    this.r = SHARED_REDIS;
    this.state = 'new';
    this.buffer = [];
}
util.inherits(Client, events.EventEmitter);

var C = Client.prototype;

C.toJSON = function () {
    return {name: this.name || 'Anonymous', kind: 'spec'};
};

C.onMessage = function (data) {
    var msg;
    try {
        msg = JSON.parse(data);
    }
    catch (e) {
        this.drop('Bad JSON.');
        return;
    }
    if (config.DEBUG)
        console.log('< ' + data);
    if (!msg || typeof msg != 'object' || !msg.a)
        return this.drop('No type.');
    var handler, context;
    if (this.player) {
        context = this.player;
        handler = this.player['handle_' + msg.a];
    }
    if (!handler) {
        context = this;
        handler = this['handle_' + msg.a];
    }
    if (!handler)
        return this.drop('No handler.');
    try {
        handler.call(context, msg);
    }
    catch (e) {
        console.error(e);
        console.error('due to');
        console.error(data);
        return this.drop('Unexpected error.');
    }
};

C.send = function (type, msg) {
    msg.a = type;
    this.sendRaw(JSON.stringify(msg));
};

C.sendRaw = function (flat) {
    this.buffer.push(flat);
    if (config.DEBUG)
        console.log('> ' + flat);
    if (!this.flushTimer)
        this.flushTimer = setTimeout(this.flush.bind(this), 0);
};

C.flush = function () {
    this.sock.write('[' + this.buffer.join(',') + ']');
    this.buffer = [];
    this.flushTimer = 0;
};

C.handle_login = function (msg) {
    if (this.state != 'new' || !(typeof msg.id == 'string'))
        return this.warn("Can't login.");
    var fakeId = msg.id;
    if (!fakeId.match(/^\d{1,20}$/))
        return this.warn("Bad id.");
    var self = this;
    // Get them a user ID first
    this.r.hget('cam:userIds', fakeId, function (err, realId) {
        if (err)
            return self.drop(err);
        if (realId) {
            self.loadUser(realId);
            return;
        }
        self.r.incr('cam:userCtr', function (err, realId) {
            if (err)
                return self.drop(err);
            self.r.hsetnx('cam:userIds', fakeId, realId, function (err, wasSet) {
                if (err)
                    return self.drop(err);
                else if (!wasSet)
                    return self.drop("Couldn't save your account.");
                self.loadUser(realId);
            });
        });
    });
};

C.loadUser = function (id) {
    if (this.state != 'new')
        return this.warn("User already loaded!");

    this.id = id;
    this.key = 'cam:user:' + id;
    var self = this;
    this.r.hget(this.key, 'name', function (err, name) {
        if (err)
            return self.drop(err);
        self.name = name || null;
        self.send('set', {t: 'account', name: name});
        game.Player.load(self.r, self.id, function (err, player) {
            if (err)
                self.drop(err);

            var alreadyPlaying = false;
            if (player.adopt(self))
                alreadyPlaying = player.isPlaying();

            if (!alreadyPlaying) {
                self.watchGame(1, function (err) {
                    if (err)
                        return self.drop(err);
                });
            }
            else {
                self.state = 'playing';
                self.game = player.game;
            }
        });
    });
};

C.watchGame = function (gameId, cb) {
    if (this.state == 'spec')
        return;
    this.state = 'spec';
    var self = this;
    game.Game.load(gameId, function (err, gameObj) {
        if (err) {
            self.state = 'new';
            return cb(err);
        }
        gameObj.addSpec(self);
        self.game = gameObj;
        cb(null);
    });
};

C.isPlaying = function () {
    return false;
};

var BAD_NAMES = ['anon', 'anonymous', 'dealer', 'admin', 'administrator', 'mod', 'moderator'];

C.handle_setName = function (msg) {
    if (this.state == 'new')
        return this.warn('Not logged in!');
    if (typeof msg.name != 'string')
        return this.drop('No name!');
    var name = msg.name.replace(/[^\w .?\/<>'|\\\-+=!#$&*`~]+/g, '');
    name = name.replace(/\s+/g, ' ').trim().slice(0, common.USERNAME_LENGTH);
    if (!name)
        return this.warn('Bad name.');
    if (BAD_NAMES.indexOf(name.toLowerCase()) >= 0)
        return this.warn("Name is already taken.");
    var oldName = this.name;
    if (name == oldName)
        return;
    var self = this;
    this.r.hsetnx('cam:userNames', name.toLowerCase(), this.id, function (err, success) {
        if (err)
            return self.drop(err);
        if (!success)
            return self.warn("Name is already taken.");
        var m = self.r.multi();
        if (oldName)
            m.hdel('cam:userNames', oldName.toLowerCase());
        m.hset(self.key, 'name', name).exec(function (err) {
            if (err) {
                self.warn("Lost username " + name + "!");
                return self.drop(err);
            }
            self.name = name;
            self.emit('change:name', name);
            if (self.player)
                self.player.set({name: name});
            // XXX: should really observe this change
            if (self.game)
                self.game.logMeta(oldName + ' changed their name to ' + name + '.');
            self.send('set', {t: 'account', name: name});
        });
    });
};

C.handle_chat = function (msg) {
    if (!this.game)
        return this.warn("Not viewing any games!");
    this.game.chat(this, msg);
};

C.warn = function (msg) {
    console.warn(this.name + ': ' + msg);
    if (typeof msg == 'string')
        this.send('set', {status: msg});
};

C.drop = function (reason) {
    console.error(this.name + ' error: ' + util.inspect(reason));
    if (typeof reason == 'string')
        this.send('set', {status: reason, error: true});
    this.sock.close();
    this.state = 'dropped';
};

C.onDisconnected = function () {
    this.emit('disconnected');
    this.game = null;
    this.sock.removeAllListeners();
    this.removeAllListeners();
};

var SCRIPTS;

function serveScripts(req, resp, next) {
    var url = urlParse(req.url, true);
    if (url.pathname == '/') {
        resp.writeHead(200, {'Content-Type': 'text/html; charset=UTF-8',
                Expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
                'Cache-Control': 'no-cache'});
        resp.end(SCRIPTS.indexHtml);
        return;
    }
    else if (url.pathname == SCRIPTS.clientJsPath) {
        resp.writeHead(200, {'Content-Type': 'application/javascript',
                'Cache-Control': 'max-age=600000'});
        resp.end(SCRIPTS.clientJs);
        return;
    }
    next();
}

if (require.main === module) {
    assets.buildScripts(function (err, scripts) {
        if (err) throw err;
        SCRIPTS = scripts;
        game.setupRound(function (err) {
            if (err) throw err;
            startServer();
        });
    });
}

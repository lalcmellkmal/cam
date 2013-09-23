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
    app.use(serveSuggestions);
    app.use(connect.static(__dirname + '/www', {maxAge: 2592000000}));
    app.on('upgrade', function (req, resp) {
        resp.end();
    });

    // Dumb workaround for sockjs-connect incompatibility
    var http = require('http').createServer(app);
    var sockJs = require('sockjs').createServer();
    sockJs.on('connection', onConnection);
    sockJs.installHandlers(http, {
        sockjs_url: config.SOCKJS_SCRIPT_URL,
        prefix: config.SOCKJS_PREFIX,
        jsessionid: false,
        log: sockJsLog,
    });
    http.listen(config.LISTEN_PORT);
    console.log('Listening on port ' + config.LISTEN_PORT + '.');
}

function onConnection(conn) {
    var ip = conn.remoteAddress;
    if (config.TRUST_X_FORWARDED_FOR) {
        var ff = parseForwardedFor(conn.headers['x-forwarded-for']);
        if (ff)
            ip = ff;
    }
    var client = new Client(conn, ip);
    conn.on('data', client.onMessage.bind(client));
    conn.once('close', client.onDisconnected.bind(client));
}

function parseForwardedFor(ff) {
    if (!ff)
        return null;
    if (ff.indexOf(',') >= 0)
        ff = ff.split(',', 1)[0];
    return ff.trim();
}

function sockJsLog(sev, msg) {
    if (sev != 'debug' && sev != 'info')
        console.error(msg);
    else if (config.DEBUG)
        console.log(msg);
}

var CLIENT_CTR = 0;

function Client(sock, ip) {
    events.EventEmitter.call(this);
    this.setMaxListeners(0);
    this.sock = sock;
    this.ip = ip;
    this.clientId = 'C' + (++CLIENT_CTR);
    this.r = SHARED_REDIS;
    this.state = 'new';
    this.buffer = [];
}
util.inherits(Client, events.EventEmitter);

var C = Client.prototype;

C.toJSON = function () {
    return {name: this.name || 'Anonymous', kind: 'spec', id: this.clientId};
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
    if (!/^\d{1,20}$/.test(fakeId))
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
        game.Player.load(self.id, function (err, player) {
            if (err)
                self.drop(err);

            var alreadyPlaying = false;
            if (player.adopt(self))
                alreadyPlaying = player.isPlaying();
            else
                self.send('set', {t: 'account', action: 'alreadyConnected'});

            if (!alreadyPlaying) {
                self.watchGame(config.GAME_ID, function (err) {
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
            self.emit('change:name', name, self);
            if (self.player)
                self.player.set({name: name});
            self.send('set', {t: 'account', name: name});
        });
    });
};

C.handle_chat = function (msg) {
    if (!this.game)
        return this.warn("Not viewing any games!");
    this.game.chat(this, msg);
};

C.handle_suggest = function (msg) {
    var card = msg.card;
    if (typeof card != 'string')
        return;
    card = card.trim().replace(/\s+/g, ' ').slice(0, 100);
    var norm = card.toLowerCase().replace(/[^a-z]+/g, '');
    if (!norm)
        return;
    var self = this;
    this.r.sadd('cam:suggestions', norm, function (err, added) {
        if (err)
            return self.drop(err);
        if (!added)
            return;
        self.r.lpush('cam:suggestionList', card);
    });
};

function serveSuggestions(req, resp, next) {
    var url = urlParse(req.url, true);
    if (/^\/suggestions\/?$/.test(url.pathname)) {
        resp.writeHead(200, noCacheHeaders);
        resp.write('<!doctype html><meta charset=utf8><title>Suggestions</title>\n');
        SHARED_REDIS.lrange('cam:suggestionList', 0, -1, function (err, suggestions) {
            if (err)
                return console.error(err);
            for (var i = 0; i < suggestions.length; i ++) {
                var card = connect.utils.escape(suggestions[i]);
                resp.write(card + '<br>\n');
            }
            resp.end();
        });
        return;
    }
    next();
}

C.warn = function (msg) {
    console.warn(this.name + ': ' + msg);
    if (typeof msg == 'string')
        this.send('set', {status: msg});
};

C.drop = function (reason) {
    console.error(this.name + ' error: ' + util.inspect(reason));
    if (typeof reason == 'string')
        this.send('set', {status: reason, error: true});
    this.sock.destroySoon();
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
        resp.writeHead(200, noCacheHeaders);
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

var noCacheHeaders = {'Content-Type': 'text/html; charset=UTF-8',
                      Expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
                      'Cache-Control': 'no-cache'};

if (require.main === module) {
    assets.buildScripts(function (err, scripts) {
        if (err) throw err;
        SCRIPTS = scripts;
        game.setupRound(config.GAME_ID, function (err) {
            if (err) throw err;
            startServer();
        });
    });
}

var _ = require('underscore'),
    async = require('async'),
    common = require('./common'),
    config = require('./config'),
    connect = require('connect'),
    events = require('events'),
    fs = require('fs'),
    util = require('util');

function redisClient() {
    return require('redis').createClient(config.REDIS_PORT);
}

var SHARED_REDIS = redisClient();
var HAND_SIZE = 7;
var GAMES = {};

function loadDeck(filename, dest, cb) {
    fs.readFile(filename, 'UTF-8', function (err, file) {
        if (err)
            return cb(err);
        file.split('\n').forEach(function (line) {
            line = line.trim();
            if (line && !line.match(/^#/))
                dest.push(line);
        });
        cb(null);
    });
}

function setupRound(cb) {

    // TEMP: Wouldn't be reading this every time.
    var sets = fs.readdirSync('sets');
    var whiteSets = [], blackSets = [];
    sets.forEach(function (set) {
        if (set.match(/black/i))
            blackSets.push(set);
        else
            whiteSets.push(set);
    });

    var whites = [], blacks = [];

    function loader(deck) {
        return function (name, cb) {
            loadDeck('sets/'+name, deck, cb);
        };
    }
    async.forEach(whiteSets, loader(whites), function (err) {
        if (err)
            return cb(err);
        if (!whites.length)
            return cb("Empty white deck!");
        async.forEach(blackSets, loader(blacks), function (err) {
            if (err)
                return cb(err);
            if (!blacks.length)
                return cb("Empty black deck!");
            var m = SHARED_REDIS.multi();

            // TEMP XXX COMPLETE DATA LOSS PLS GO
            m.flushdb();

            function makeDeck(key, deck) {
                m.del(key);
                m.sadd(key, _.uniq(deck));
            }
            makeDeck('cam:whites', whites);
            makeDeck('cam:blacks', blacks);

            m.exec(cb);
        });
    });
}

function shuffle(myArray) {
    var i = myArray.length;
    if (i == 0)
        return false;
    while (--i) {
        var j = Math.floor(Math.random() * (i+1));
        var tempi = myArray[i];
        var tempj = myArray[j];
        myArray[i] = tempj;
        myArray[j] = tempi;
    }
}

function startServer() {                                                       
    var app = connect.createServer();
    app.use(connect.static(__dirname + '/www'));
    app.on('upgrade', function (req, resp) {
        resp.end();
    });

    // Dumb workaround for sockjs-connect incompatibility
    var http = require('http').createServer(app);
    var sockJs = require('sockjs').createServer();
    sockJs.on('connection', on_connection);
    sockJs.installHandlers(http, {
        sockjs_url: 'sockjs-0.3.min.js',
        prefix: config.SOCKJS_PREFIX,
        jsessionid: false,
        log: sockJsLog,
    });
    http.listen(config.LISTEN_PORT);
}

function Game() {
    this.r = SHARED_REDIS;
    this.id = 1;
    this.key = 'cam:game:1';
    this.players = [];
    this.state = 'waiting';
}

Game.load = function (id, cb) {
    if (!(id in GAMES))
        GAMES[id] = new Game;
    cb(null, GAMES[id]);
};

var G = Game.prototype;

G.addPlayer = function (player) {
    if (this.players.indexOf(player) >= 0)
        return this.warn('Already playing.');
    var self = this;
    player.tryJoining(this.id, function (err, joined) {
        if (err)
            return player.drop(err);
        else if (!joined)
            return player.warn("Couldn't join game.");

        self.players.push(player);
        player.on('select', self.onSelection.bind(self));
        player.on('dropped', self.dropPlayer.bind(self, player));
        player.on('change:name', self.broadcastRoster.bind(self));

        self.broadcastRoster();
        self.sendState(player);
        self.startRound();
    });
};

G.makeRoster = function () {
    return this.players.map(function (p) { return p.toJSON(); });
};

G.sendRoster = function (dest) {
    dest.send('set', {roster: this.makeRoster()});
};

G.broadcastRoster = function () {
    this.sendAll('set', {roster: this.makeRoster()});
};

G.dropPlayer = function (player) {
    console.log(player.name + ' dropped.');
};

G.startRound = function () {
    if (this.state != 'waiting' || this.players.length < 1) // XXX 2
        return;
    var self = this;
    this.state = 'starting';
    this.r.spop('cam:blacks', function (err, black) {
        if (err) {
            self.state = 'waiting';
            return self.fail(err);
        }
        if (!black) {
            self.state = 'waiting';
            return self.fail("Out of cards!"); // XXX reshuffle
        }
        self.r.hmset(self.key, {state: 'picking', black: black}, function (err) {
            if (err) {
                self.state = 'waiting';
                return self.fail(err);
            }
            self.state = 'picking';
            self.black = black;
            self.blackInfo = common.parseBlack(black);
            self.sendAll('set', {unlocked: true});
            self.sendAll('black', {black: black});
        });
    });
};

G.fail = function (err) {
    this.players.forEach(function (player) {
        player.drop(err);
    });
};

G.warn = function (err) {
    console.warn('Game ' + this.id + ': ' + err);
};

G.sendAll = function (type, msg) {
    msg.a = type;
    msg = JSON.stringify(msg);
    this.players.forEach(function (player) {
        player.sendRaw(msg);
    });
};

G.sendState = function (dest) {
    var self = this;
    var info = {unlocked: false};

    switch (this.state) {
        case 'waiting':
            info.status = 'Waiting for players...';
            break;
        case 'picking':
            info.unlocked = true;
            break;
        case 'ranking':
            info.status = 'Choose your favorite.';
            info.submissions = this.anonymizedSubmissions();
            break;
        default:
            console.warn("Unknown state to send: " + this.state);
            info.status = "Unknown state.";
    }

    if (!this.black)
        info.black = null;

    dest.send('set', info);
    if (this.black)
        dest.send('black', {black: this.black});
};

G.onSelection = function () {
    if (this.state != 'picking')
        return;
    if (!this.players.every(function (p) { return p.selection; }))
        return;

    this.state = 'ranking';

    var submissions = [], submissionIds = {};
    var blankCount = this.blackInfo.blankCount;
    var self = this;
    function checkSubmission(player, cb) {
        player.checkSubmission(blankCount, function (err, submission) {
            if (err)
                return cb(err);
            if (submission) {
                submission.player = player;
                submissions.push(submission);
                submissionIds[submission.id] = submission;
            }
            cb(null);
        });
    }

    function revert(err) {
        self.state = 'picking';
        self.fail(err);
    }

    async.forEach(this.players, checkSubmission, function (err) {
        if (err)
            return revert(err);
        else if (!submissions.length)
            return revert('No submissions!'); // need to fail gracefully
        shuffle(submissions);

        var m = self.r.multi();
        submissions.forEach(function (sub) {
            sub.player.handOverSubmission(m, sub);
            delete sub.player;
        });
        m.hmset(self.key, {state: 'ranking', submissions: JSON.stringify(submissions)});
        m.exec(function (err) {
            if (err)
                return revert(err);

            self.players.forEach(function (player) {
                player.confirmSubmission(submissionIds);
            });
            self.submissions = submissions;
            self.sendAll('set', {submissions: self.anonymizedSubmissions()});
        });
    });
};

G.anonymizedSubmissions = function () {
    return this.submissions.map(function (sub) {
        return {cards: sub.cards};
    });
};

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
    return {name: this.name || '<anon>'};
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
    if (!msg || typeof msg != 'object' || !msg.a)
        return this.drop('No type.');
    var handler = this['handle_' + msg.a];
    if (!handler)
        return this.drop('No handler.');
    try {
        handler.call(this, msg);
    }
    catch (e) {
        console.error(e);
        console.error('due to');
        console.error(data);
        return this.drop('Caught.');
    }
};

C.send = function (type, msg) {
    msg.a = type;
    this.sendRaw(JSON.stringify(msg));
};

C.sendRaw = function (flat) {
    this.buffer.push(flat);
    console.log('> ' + flat);
    if (!this.flushTimer)
        this.flushTimer = _.defer(this.flush.bind(this));
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
            self.id = realId;
            self.loadUser();
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
                self.id = realId;
                self.loadUser();
            });
        });
    });
};

C.loadUser = function () {
    if (this.state != 'new')
        return this.warn("User already loaded!");

    this.state = 'spec';
    this.key = 'cam:user:' + this.id;
    var self = this;
    this.r.hget(this.key, 'name', function (err, name) {
        if (err)
            return self.drop(err);
        self.name = name || null;
        self.send('set', {t: 'account', name: name});
        self.loadGame();
    });
};

C.handle_setName = function (msg) {
    if (this.state == 'new')
        return this.warn('Not logged in!');
    if (typeof msg.name != 'string')
        return this.drop('No name!');
    var name = msg.name.replace(/[^\w .?\/<>'\[\]{}|\\\-+=!@#$%^&*()]+/g, '');
    name = name.replace(/\s+/g, ' ').trim();
    if (!name)
        return this.drop('Bad name.');
    var oldName = this.name;
    if (name == oldName)
        return;
    var self = this;
    this.r.hsetnx('cam:userNames', name, this.id, function (err, success) {
        if (err)
            return self.drop(err);
        if (!success)
            return self.warn("Name is already taken.");
        var m = self.r.multi();
        if (oldName)
            m.hdel('cam:userNames', oldName);
        m.hset(self.key, 'name', name).exec(function (err) {
            if (err) {
                self.warn("Lost username " + name + "!");
                return self.drop(err);
            }
            self.name = name;
            self.emit('change:name', name);
            self.send('set', {t: 'account', name: name});
            self.send('set', {status: 'Your name is now "' + name + '".'});
        });
    });
};

C.loadGame = function (msg) {
    var self = this;
    this.r.hget(this.key, 'game', function (err, gameId) {
        if (err)
            return self.drop(err);
        var playing = true;
        if (!gameId) {
            gameId = 1;
            playing = false;
        }
        Game.load(gameId, function (err, game) {
            if (err)
                return self.drop(err);
            if (playing) {
                self.state = 'playing';
                self.sendHand();
            }
            else
                self.send('set', {canJoin: true});
            game.sendRoster(self);
            game.sendState(self);
        });
    });
};

C.handle_join = function (msg) {
    var gameId = 1;
    var self = this;
    this.r.hget(this.key, 'game', function (err, existing) {
        if (existing)
            return self.warn('Already in a game!');
        Game.load(gameId, function (err, game) {
            if (err)
                return self.drop(err);
            game.addPlayer(self);
        });
    });
};

C.sendHand = function () {
    if (this.state != 'playing')
        return this.warn("Can't send hand when not playing.");
    var self = this;
    this.r.smembers(this.key + ':hand', function (err, hand) {
        if (err)
            return self.drop(err);
        self.send('hand', {hand: cardsFromNames(hand)});
    });
};

C.tryJoining = function (gameId, cb) {
    var self = this;
    this.r.hsetnx(this.key, 'game', gameId, function (err, joined) {
        if (err)
            return cb(err);
        if (!joined)
            return cb(null, false);
        self.state = 'playing';
        self.game = gameId;
        self.dealInitialHand();
        cb(null, true);
    });
};

C.dealInitialHand = function () {
    var m = this.r.multi();
    for (var i = 0; i < HAND_SIZE; i++)
        m.spop('cam:whites');
    var self = this;
    m.exec(function (err, rs) {
        if (err)
            return self.drop(err);
        var hand = rs.filter(function (card) { return card; });
        var key = self.key + ':hand';
        var m = self.r.multi();
        m.del(key);
        if (hand.length)
            m.sadd(key, hand);
        m.exec(function (err) {
            if (err) {
                // redis probably failed, not much point trying to recover
                self.warn("Lost " + hand.length + " card(s).");
                return self.drop(err);
            }
            self.send('hand', {hand: cardsFromNames(hand)});
        });
    });
};

C.handle_select = function (msg) {
    if (!this.state == 'playing')
        return this.warn("Not playing!");
    var cards = msg.cards;
    if (!_.isArray(cards) || !cards.length)
        return this.warn("No cards selected!");
    if (!cards.every(function (card) { return typeof card == 'string'; }))
        return this.warn("Invalid choices!");
    if (_.uniq(cards).length != cards.length)
        return this.warn("Duplicate choices!");

    // TEMP
    var self = this;
    setTimeout(function () {

    self.selection = msg.cards;
    self.send('select', {cards: msg.cards});
    self.emit('select');

    // TEMP
    }, 500);
};

C.checkSubmission = function (count, cb) {
    if (this.selection.length != count) {
        this.warn("Wrong number of selections!");
        return cb(null, false);
    }
    var self = this;
    var m = this.r.multi();
    var key = this.key + ':hand';
    this.selection.forEach(function (card) {
        m.sismember(key, card);
    });
    m.exec(function (err, rs) {
        if (err)
            return cb(err);
        if (!rs.every(function (n) { return n; }))
            return cb(null, false);
        cb(null, {id: self.id, cards: self.selection});
    });
};

C.handOverSubmission = function (m, submission) {
    m.srem(this.key + ':hand', submission.cards);
};

C.confirmSubmission = function (mapping) {
    var sub = mapping[this.id];
    if (sub)
        this.send('select', {cards: sub.cards, final: true});
    else
        this.send('set', {status: 'Invalid submission!'});
    this.send('set', {unlocked: false});
};

function cardsFromNames(hand) {
    hand = hand.slice().sort();
    return hand.map(function (name) { return {id: name}; });
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
    this.sock.close();
    this.state = 'dropped';
};

C.onDisconnected = function () {
    this.emit('dropped');
    this.sock.removeAllListeners();
    this.removeAllListeners();
};

function on_connection(conn) {
    var client = new Client(conn);
    conn.on('data', client.onMessage.bind(client));
    conn.once('close', client.onDisconnected.bind(client));
}

function sockJsLog(sev, msg) {
    console.log(msg);
}

if (require.main === module) {
    setupRound(function (err) {
        if (err) throw err;
        startServer();
    });
}

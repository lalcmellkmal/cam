var _ = require('underscore'),
    async = require('async'),
    common = require('./common'),
    fs = require('fs'),
    Model = require('./model').Model,
    StateMachine = require('./state-machine').StateMachine,
    util = require('util');

var HAND_SIZE = 7;
var MIN_PLAYERS = 2;

var GAMES = {};
var PLAYERS = {};

var SHARED_REDIS;
exports.setRedis = function (r) { SHARED_REDIS = r; };

function Game() {
    Model.call(this);

    this.r = SHARED_REDIS;
    this.id = 1;
    this.key = 'cam:game:1';
    this.dealer = null;
    this.players = [];
    this.specs = [];

    this.broadcastRosterCb = this.deferral('broadcastRoster');
    this.on('change:players', this.broadcastRosterCb);
    this.on('change:specs', this.broadcastRosterCb);

    var changed = this.deferral('broadcastState');
    this.on('change:black', changed);
    this.on('change:dealer', changed);
    this.on('change:submissions', changed);
}
util.inherits(Game, Model);
exports.Game = Game;

Game.load = function (id, cb) {
    if (!(id in GAMES))
        GAMES[id] = new Game;
    cb(null, GAMES[id]);
};

var G = Game.prototype;

StateMachine.create({
    target: G,
    initial: 'inactive',
    events: [
        {name: 'newPlayer', from: 'inactive', to: 'nominating'},
        {name: 'nominate', from: 'nominating', to: 'electing'},
        {name: 'elect', from: 'electing', to: 'nominating'},
        {name: 'dropPlayer', from: 'nominating', to: 'electing'},
        {name: 'notEnoughPlayers', from: ['nominating', 'electing'], to: 'inactive'},
    ],
});

G.addSpec = function (client) {
    if (this.specs.indexOf(client) >= 0)
        return this.warn('Already watching.');
    this.specs.push(client);
    this.setChanged('specs');
    client.on('change:name', this.broadcastRosterCb);
    client.once('disconnected', this.removeSpec.bind(this, client));
    this.sendState(client);
};

G.removeSpec = function (client) {
    var i = this.specs.indexOf(client);
    if (i < 0)
        return;
    this.specs.splice(i, 1);
    this.setChanged('specs');
    client.removeListener('change:name', this.broadcastRosterCb);
};

G.addPlayer = function (player) {
    if (this.players.indexOf(player) >= 0)
        return this.warn('Already playing.');

    player.game = this;
    player.dealHand(true);
    this.players.push(player);
    this.setChanged('players');

    if (!this.dealer)
        this.nextDealer();

    player.on('change:name', this.broadcastRosterCb);
    player.on('change:score', this.broadcastRosterCb);
    player.once('dropped', this.dropPlayer.bind(this, player));

    if (player.client)
        this.removeSpec(player.client);

    this.sendState(player);
    this.newPlayer();
};

G.dropPlayer = function (player) {
    var i = this.players.indexOf(player);
    if (i < 0)
        return this.warn("Player not in player list!");
    this.players.splice(i, 1);
    this.setChanged('players');

    if (this.dealer == player.id) {
        var newDealer;
        if (this.players[i])
            newDealer = this.players[i].id;
        else if (this.players[0])
            newDealer = this.players[0].id;
        else
            newDealer = null; // state should change for us
        self.set({dealer: newDealer});
    }

    player.set({game: null});
    player.removeListener('change:name', this.broadcastRosterCb);
    player.removeListener('change:score', this.broadcastRosterCb);
    player.removeAllListeners('dropped');

    if (this.players.length < MIN_PLAYERS)
        this.notEnoughPlayers();
    else
        this.dropPlayer();
};

G.makeRoster = function () {
    var self = this;
    var roster = this.players.map(function (player) {
        var json = player.toJSON();
        if (self.dealer == player.id)
            json.kind = 'dealer';
        return json;
    });
    roster = roster.concat(this.specs.map(function (c) { return c.toJSON(); }));
    return roster;
};

G.sendRoster = function (dest) {
    dest.send('set', {roster: this.makeRoster()});
};

G.broadcastRoster = function () {
    this.sendAll('set', {roster: this.makeRoster()});
};

G.onbeforeelect = function () {
    return this.players.length >= MIN_PLAYERS;
};

G.onbeforedropPlayer = G.onbeforeelect;

G.onnominating = function () {
    var self = this;

    if (!this.dealer)
        this.dealer = this.players[0].id;

    this.r.spop('cam:blacks', function (err, black) {
        if (err)
            return self.fail(err);
        if (!black)
            return self.fail("Out of cards!"); // XXX reshuffle
        if (self.current != 'nominating')
            return;
        self.r.hmset(self.key, {state: 'nominating', black: black}, function (err) {
            if (err)
                return self.fail(err);
            if (self.current != 'nominating')
                return self.saveState();
            if (!self.getDealerPlayer())
                return self.fail("No dealer!");
            self.set({black: common.parseBlack(black)});
        });
    });
};

G.getDealerPlayer = function () {
    var dealerId = this.dealer;
    return _.find(this.players, function (p) { return p.id == dealerId; });
};

G.oninactive = function (event, from, to) {
    this.r.hmset(this.key, {state: 'inactive', black: null});
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
    this.specs.forEach(function (spec) {
        spec.sendRaw(msg);
    });
};

G.broadcastState = function () {
    var send = this.sendState.bind(this);
    this.players.forEach(send);
    this.specs.forEach(send);
};

G.sendState = function (dest) {
    var self = this;
    var player = dest.isPlaying();
    var dealer = player && dest.id == this.dealer;
    var info = {action: null, submissions: null};
    info.black = this.black ? this.black.card : null;

    switch (this.current) {
        case 'inactive':
            info.status = 'Need more players.';
            break;
        case 'nominating':
            if (!player)
                info.status = 'Waiting for submissions...';
            else if (dealer)
                info.status = 'You are the dealer. Waiting for submissions...';
            else {
                info.action = 'nominate';
                var n = this.black.blankCount;
                var word = {1: 'one', 2: 'two', 3: 'three'}[n];
                info.status = 'Pick ' + (word || n) + '.';
                dest.remindSubmission();
            }
            break;
        case 'electing':
            if (dealer) {
                info.status = 'Pick your favorite.';
                info.action = 'elect';
            }
            else
                info.status = 'Dealer is picking their favorite...';
            info.submissions = this.anonymizedSubmissions();
            break;
        default:
            console.warn("Unknown state to send: " + this.current);
            info.status = "Unknown state.";
    }

    dest.send('set', info);
};

G.saveState = function () {
    // todo
};

G.onbeforenominate = function () {
    var dealer = this.getDealerPlayer();
    return this.players.every(function (p) { return p == dealer || p.selection; });
};

G.onelecting = function () {
    var submissions = [], submissionIds = {};
    var blankCount = this.black.blankCount;
    var self = this;
    function checkSubmission(player, cb) {
        if (player.id == self.dealer)
            return cb(null);
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

    async.forEach(this.players, checkSubmission, function (err) {
        if (err)
            return self.fail(err);
        else if (!submissions.length)
            return self.fail('No submissions!'); // need to fail gracefully
        shuffle(submissions);

        var m = self.r.multi();
        submissions.forEach(function (sub) {
            sub.player.handOverSubmission(m, sub);
            delete sub.player;
        });
        m.hmset(self.key, {state: 'electing', submissions: JSON.stringify(submissions)});
        m.exec(function (err) {
            if (err)
                return self.fail(err);

            self.players.forEach(function (player) {
                player.confirmSubmission(submissionIds);
                // delay for the animation
                setTimeout(player.dealHand.bind(player, false), 2000);
            });
            self.set({submissions: submissions});
        });
    });
};

G.anonymizedSubmissions = function () {
    return this.submissions.map(function (sub) {
        return {cards: sub.cards};
    });
};

G.gotElection = function (player, choice) {
    if (this.current != 'electing')
        return player.warn("Not picking right now.");
    if (player.id != this.dealer)
        return player.warn("You are not the dealer.");

    var winner;
    for (var i = 0; i < this.submissions.length; i++) {
        var sub = this.submissions[i];
        if (_.isEqual(sub.cards, choice)) {
            winner = sub.id;
            break;
        }
    }
    if (!winner)
        return player.warn("Invalid choice.");

    var m = this.r.multi();
    m.hincrby(this.key, 'scores', 1);
    m.hincrby('cam:user:' + winner, 'score', 1);
    var self = this;
    m.exec(function (err, rs) {
        if (err)
            return self.fail(err);
        var gameScore = rs[0], totalScore = rs[1];
        var m = self.r.multi();
        m.zadd('cam:leaderboard', totalScore, winner);
        m.exec(function (err) {
            if (err)
                return self.fail(err);
            var player = PLAYERS[winner];
            if (player)
                player.set({score: gameScore});

            var name = (player && (player.name || 'Anonymous')) || '<gone>';
            self.sendAll('set', {status: name + ' won!', action: null});
            self.sendAll('elect', {cards: choice});
            setTimeout(function () {
                self.nextDealer();
                self.elect();
            }, 3000);
        });
    });
};

G.nextDealer = function () {
    if (!this.players.length) {
        this.set({dealer: null});
        return;
    }
    if (!this.dealer) {
        this.set({dealer: this.players[0].id});
        return;
    }
    for (var i = 0; i < this.players.length; i++) {
        if (this.players[i].id == this.dealer) {
            var next = this.players[i+1] || this.players[0];
            this.set({dealer: next.id});
            return;
        }
    }
    this.set({dealer: this.players[0].id});
};

///////////////////////////////////////////////////////////////////////////////

function Player(id) {
    Model.call(this);
    this.id = id;
    this.score = 0;
}
util.inherits(Player, Model);
exports.Player = Player;

var P = Player.prototype;

Player.load = function (r, id, cb) {
    if (id in PLAYERS)
        return cb(null, PLAYERS[id]);

    var self = this;
    r.hget('cam:user:' + id, 'game', function (err, gameId) {
        if (err)
            return cb(err);
        if (id in PLAYERS)
            return cb(null, PLAYERS[id]);
        var player = new Player(id);
        PLAYERS[id] = player;
        if (!gameId)
            return cb(null, player);
        Game.load(gameId, function (err, game) {
            if (err)
                return player.drop(err);
            player.game = gameId;
            cb(null, player);
        });
    });
};

['send', 'sendRaw', 'drop', 'warn'].forEach(function (call) {
    P[call] = function () {
        if (!this.client)
            return;
        this.client[call].apply(this.client, arguments);
    };
});

var TIMEOUT = 30 * 1000;

P.adopt = function (client) {
    if (this.client)
        return false;

    if (this.timeout) {
        clearTimeout(this.timeout);
        this.timeout = 0;
    }
    client.player = this;
    this.client = client;
    this.key = client.key;
    this.r = client.r;
    this.set({name: client.name});
    client.once('disconnected', this.abandon.bind(this));

    if (this.isPlaying()) {
        var self = this;
        this.sendHand(function (err) {
            if (err)
                self.drop(err);
            self.game.sendState(self);
        });
    }
    else
        this.send('set', {canJoin: true});
    return true;
};

P.abandon = function () {
    var name = this.client.name;
    this.client.player = null;
    this.client = null;
    this.set({name: name ? name + ' (dropped)' : '(dropped)'});
    this.timeout = setTimeout(this.die.bind(this), TIMEOUT);
};

P.die = function () {
    this.emit('leave');
    // TODO remove listeners etc.
    delete PLAYERS[this.id];
};

P.toJSON = function () {
    var json = this.client ? this.client.toJSON() : {name: this.name};
    json.kind = 'player';
    json.score = this.score;
    return json;
};

P.isPlaying = function () {
    return !!this.game;
};

P.dealHand = function (fresh) {
    var key = this.key + ':hand';
    var self = this;
    this.r.smembers(key, function (err, oldCards) {
        if (err)
            return self.drop(err);
        if (fresh)
            oldCards = [];
        if (oldCards.length >= HAND_SIZE)
            return;

        var m = self.r.multi();
        for (var i = oldCards.length; i < HAND_SIZE; i++)
            m.spop('cam:whites');
        m.exec(function (err, rs) {
            if (err)
                return self.drop(err);
            var newCards = _.compact(rs);
            if (!fresh && !newCards.length)
                return;

            var m = self.r.multi();
            if (fresh)
                m.del(key);
            if (newCards.length)
                m.sadd(key, newCards);
            m.exec(function (err) {
                if (err) {
                    // redis probably failed, not much point trying to recover
                    self.warn("Lost " + newCards.length + " card(s).");
                    return self.drop(err);
                }
                var hand = oldCards.concat(newCards);
                self.send('hand', {hand: cardsFromNames(hand)});
            });
        });
    });
};

P.sendHand = function (cb) {
    var self = this;
    this.r.smembers(this.key + ':hand', function (err, hand) {
        if (err)
            return cb(err);
        self.send('hand', {hand: cardsFromNames(hand)});
        cb(null);
    });
};

P.handle_join = function (msg) {
    var gameId = 1;
    var self = this;
    this.r.hget(this.key, 'game', function (err, existing) {
        if (err)
            return self.drop(err);
        if (existing)
            return self.warn('Already in a game!');
        Game.load(gameId, function (err, game) {
            if (err)
                return self.drop(err);
            self.send('set', {canJoin: false});
            game.addPlayer(self);
        });
    });
};

function cardsFromNames(hand) {
    hand = hand.slice().sort();
    return hand.map(function (name) { return {id: name}; });
}

P.handle_submit = function (msg) {
    var cards = msg.cards;

    if (!this.game)
        return;

    if (!cards || !_.isArray(cards) || !cards.length) {
        // Clear selection
        this.selection = null;
        this.send('select', {cards: []});
        return;
    }

    if (!cards.every(function (card) { return typeof card == 'string'; }))
        return this.warn("Invalid choices!");
    if (_.uniq(cards).length != cards.length)
        return this.warn("Duplicate choices!");

    // TEMP
    var self = this;
    setTimeout(function () {
    if (!self.game)
        return;

    self.selection = msg.cards;
    self.remindSubmission();
    self.game.nominate();

    // TEMP
    }, 500);
};

P.remindSubmission = function () {
    if (this.selection)
        this.send('select', {cards: this.selection});
};

P.checkSubmission = function (count, cb) {
    if (!this.selection)
        return cb(null, false);
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

P.handOverSubmission = function (m, submission) {
    m.srem(this.key + ':hand', submission.cards);
};

P.confirmSubmission = function (mapping) {
    var sub = mapping[this.id];
    if (sub)
        this.send('select', {cards: sub.cards, final: true});
    else
        this.send('set', {status: 'Invalid submission!'});
    this.send('set', {unlocked: false});
    this.selection = null;
};

P.handle_elect = function (msg) {
    if (!msg || typeof msg != 'object')
        return this.drop('Bad selection!');
    var cards = msg.cards;
    if (!_.isArray(cards) || !cards.length)
        return this.drop('Bad selection!');
    if (this.game)
        this.game.gotElection(this, cards);
};

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
exports.setupRound = setupRound;

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

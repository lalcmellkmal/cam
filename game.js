var _ = require('underscore'),
    async = require('async'),
    common = require('./common'),
    fs = require('fs'),
    Model = require('./model').Model,
    StateMachine = require('./state-machine').StateMachine,
    util = require('util');

var HAND_SIZE = 8;
var MIN_PLAYERS = 3;
var MAX_PLAYERS = 20;
var MESSAGE_RATE = 7;

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
    this.on('change:dealer', this.broadcastRosterCb);

    var changed = this.deferral('broadcastState');
    this.on('change:black', changed);
    this.on('change:dealer', changed);
    this.on('change:submissions', changed);

    this.playerNameChangedCb = this.playerNameChanged.bind(this);

    this.on('change:submissions', this.setupElectionTimer.bind(this));
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
        {name: 'nominationTimedOut', from: 'nominating', to: 'electing'},
        {name: 'victoryAwarded', from: 'electing', to: 'nominating'},
        {name: 'lostPlayer', from: 'nominating', to: 'electing'},
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
    this.sendMessageHistory(client);
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
    if (this.players.length >= MAX_PLAYERS)
        return player.send('set', {t: 'account', action: 'gameFull'});

    player.game = this;
    var self = this;
    var m = this.r.multi();
    m.hdel(this.key + ':scores', player.id);
    m.sadd(this.key + ':players', player.id);
    m.exec(function (err) {
        if (err)
            return self.fail(err);
        player.set({score: 0});

        player.dealHand(true);
        self.players.push(player);
        self.setChanged('players');

        if (!self.dealer)
            self.nextDealer();

        player.on('change', self.broadcastRosterCb);
        if (!self.nominateCb)
            self.nominateCb = self.nominate.bind(self);
        player.on('change:selection', self.nominateCb);
        player.on('change:name', self.playerNameChangedCb);
        player.once('dropped', self.dropPlayer.bind(self, player));

        if (player.client)
            self.removeSpec(player.client);

        self.sendState(player);
        self.newPlayer();
    });
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
        this.set({dealer: newDealer});
        this.electRandom();
    }

    var self = this;
    player.discardHand(this.key + ':whiteDiscards', function (err) {
        if (err)
            console.error(err);
        self.r.srem(self.key + ':players', player.id, function (err) {
            if (err)
                console.error(err);

            player.set({game: null});
            player.removeListener('change', self.broadcastRosterCb);
            player.removeListener('change:selection', self.nominateCb);
            player.removeListener('change:name', self.playerNameChangedCb);
            player.removeAllListeners('dropped');
            player.emit('dropComplete');

            if (self.players.length < MIN_PLAYERS)
                self.notEnoughPlayers();
            else
                self.lostPlayer();
        });
    });
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

G.playerNameChanged = function (name, player, info) {
    var prev = info.previous;
    if (!prev || prev == 'Anonymous')
        return;
    var self = this;
    this.rateLimit(player, function (err, okay) {
        if (err)
            return player.drop(err);
        if (okay)
            self.logMeta(prev + ' changed their name to ' + name + '.');
    });
};

G.onbeforenewPlayer = function () {
    return this.players.length >= MIN_PLAYERS;
};

G.onnominating = function () {
    var self = this;

    if (!this.dealer)
        this.dealer = this.players[0].id;

    this.r.spop(this.key + ':blacks', function (err, black) {
        if (err)
            return self.fail(err);
        if (black)
            return self.disclaimBlack(black);
        // Reshuffle blacks
        var m = self.r.multi();
        m.rename(self.key + ':blackDiscards', self.key + ':blacks');
        m.spop(self.key + ':blacks');
        m.exec(function (err, rs) {
            if (err)
                return self.fail(err);
            self.disclaimBlack(rs[1]);
        });
    });
}

G.disclaimBlack = function (black) {
    if (this.current != 'nominating')
        return;
    var m = this.r.multi();
    m.hmset(this.key, {state: 'nominating', black: black});
    m.sadd(this.key + ':blackDiscards', black);
    var self = this;
    m.exec(function (err) {
        if (err)
            return self.fail(err);
        if (self.current != 'nominating')
            return self.saveState();
        if (!self.getDealerPlayer())
            return self.fail("No dealer!");
        self.set({black: common.parseBlack(black)});
    });
};

G.popWhites = function (m, n) {
    for (var i = 0; i < n; i++)
        m.spop(this.key + ':whites');
};

G.reshuffleWhites = function (cb) {
    this.r.renamenx(this.key + ':whiteDiscards', this.key + ':whites', function (err) {
        // ignore errors (race conditions)
        cb(null);
    });
};

G.getDealerPlayer = function () {
    var dealerId = this.dealer;
    return _.find(this.players, function (p) { return p.id == dealerId; });
};

G.oninactive = function (event, from, to) {
    var self = this;
    this.r.hmset(this.key, {state: 'inactive', black: null}, function (err) {
        if (err)
            return self.fail(err);
        self.broadcastState();
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
    var allReady = true, anyReady = false;
    this.players.forEach(function (p) {
        if (p.selection)
            anyReady = true;
        else if (p != dealer)
            allReady = false;
    });

    if (anyReady && !this.nominationTimer) {
        this.nominationTimer = setTimeout(this.nominationTimedOut.bind(this), common.NOMINATION_TIMEOUT*1000);
        this.sendAll('countdown', {remaining: common.NOMINATION_TIMEOUT - 1});
    }
    else if (!anyReady && this.nominationTimer) {
        clearTimeout(this.nominationTimer);
        this.nominationTimer = 0;
        this.sendAll('countdown', {});
    }

    return allReady;
};

G.onbeforelostPlayer = G.onbeforenominate;

G.onbeforenominationTimedOut = function () {
    this.nominationTimer = 0;
};

G.onleavenominating = function () {
    if (this.nominationTimer) {
        clearTimeout(this.nominationTimer);
        this.nominationTimer = 0;
        this.sendAll('countdown', {});
    }
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
        else if (!submissions.length) {
            self.logMeta("For some reason, no one wins.");
            self.nextDealer();
            self.victoryAwarded();
            return;
        }
        shuffle(submissions);

        var m = self.r.multi();
        submissions.forEach(function (sub) {
            sub.player.handOverSubmission(m, sub, self.key + ':whiteDiscards');
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

G.setupElectionTimer = function () {
    var subs = this.submissions;
    if (this.current != 'electing' || !subs)
        return;
    var delay = 1000;
    if (subs.length > 1) {
        delay = common.ELECTION_TIMEOUT*1000;
        this.sendAll('countdown', {remaining: common.ELECTION_TIMEOUT - 1});
    }
    var self = this;
    this.electionTimer = setTimeout(function () {
        self.electionTimer = 0;
        self.electRandom();
    }, delay);
};

G.anonymizedSubmissions = function () {
    return this.submissions.map(function (sub) {
        return {cards: sub.cards};
    });
};

G.gotElection = function (dealer, choice) {
    if (this.current != 'electing')
        return dealer.warn("Not picking right now.");
    if (dealer.id != this.dealer)
        return dealer.warn("You are not the dealer.");

    for (var i = 0; i < this.submissions.length; i++) {
        var sub = this.submissions[i];
        if (_.isEqual(sub.cards, choice)) {
            if (this.acquireElectionLock())
                this.electVictor(sub, dealer);
            return;
        }
    }
    dealer.warn("Invalid choice.");
};

G.electVictor = function (winningSub, dealer) {
    // must have election lock

    if (this.electionTimer) {
        clearTimeout(this.electionTimer);
        this.electionTimer = 0;
        this.sendAll('countdown', {});
    }

    var m = this.r.multi();
    m.hincrby(this.key + ':scores', winningSub.id, 1);
    var winningPlayer = PLAYERS[winningSub.id];
    if (winningPlayer)
        winningPlayer.incrementTotalScore(m);
    var self = this;
    m.exec(function (err, rs) {
        if (err)
            return self.releaseElectionLock(err);
        var gameScore = rs[0], totalScore = rs[1];
        var m = self.r.multi();
        m.zadd('cam:leaderboard', totalScore, winningSub.id);
        m.exec(function (err) {
            if (err)
                return self.releaseElectionLock(err);

            var name;
            if (winningPlayer) {
                winningPlayer.set({score: gameScore});
                name = winningPlayer.name;
            }
            name = name || '<gone>';

            var phrase = common.applySubmission(self.black, winningSub, false);
            phrase.unshift(name + ' won with: ');
            if (dealer) {
                dealer.send('set', {action: null});
                if (dealer.name)
                    phrase.push(' (picked by ' + dealer.name + ')');
            }
            self.logMeta(phrase);

            self.sendAll('set', {status: name + ' won!', action: null});
            self.sendAll('elect', {cards: winningSub.cards});

            // Pause for announcement (would be nice to defer this in the client instead)
            setTimeout(function () {
                self.releaseElectionLock(null);
                self.nextDealer();
                self.victoryAwarded();
            }, 3000);
        });
    });
};

G.electRandom = function () {
    if (this.current != 'electing')
        return;
    if (this.acquireElectionLock()) {
        var i = Math.floor(Math.random() * this.submissions.length);
        this.electVictor(this.submissions[i], null);
    }
};

G.acquireElectionLock = function (err) {
    // Dumb workaround
    // Ought to use states to do this?
    if (this.current != 'electing' || this.electionLock)
        return false;
    var self = this;
    this.electionLock = setTimeout(function () {
        self.electionLock = 0;
    }, 5000);
    return true;
};

G.releaseElectionLock = function (err) {
    if (this.electionLock) {
        clearTimeout(this.electionLock);
        this.electionLock = 0;
    }
    if (err)
        console.error(err);
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

function spamKey(id) {
    var minute = Math.floor(new Date().getTime() / (1000*60));
    return 'cam:spam:' + id + ':' + minute;
}

G.rateLimit = function (client, cb) {
    var key = spamKey(client.id);
    this.r.multi().incr(key).expire(key, 60).exec(function (err, rs) {
        if (err)
            return cb(err);
        if (rs[0] > MESSAGE_RATE) {
            client.warn("It's time to stop posting.");
            cb(null, false);
        }
        else
            cb(null, true);
    });
};

G.chat = function (client, msg) {
    if (!msg.text || typeof msg.text != 'string')
        return this.warn("Bad message.");
    var text = msg.text.trim().slice(0, common.MESSAGE_LENGTH);
    if (!text)
        return this.warn("Bad message.");
    var self = this;
    this.rateLimit(client, function (err, okay) {
        if (err)
            return client.drop(err);
        if (okay)
            self.pushMessage({text: text, name: client.name || 'Anonymous'});
    });
};

G.logMeta = function (text) {
    this.pushMessage({text: text, kind: 'system'});
};

G.pushMessage = function (msg) {
    var self = this;
    var key = this.key + ':chat';
    var m = this.r.multi();
    m.lpush(key, JSON.stringify(msg));
    m.ltrim(key, 0, common.CHAT_HISTORY-1);
    m.exec(function (err) {
        if (err)
            return client.drop(err);
        self.sendAll('add', {t: 'chat', obj: msg});
    });
};

G.sendMessageHistory = function (dest) {
    this.r.lrange(this.key + ':chat', 0, -1, function (err, objs) {
        var log = objs.reverse().join(',');
        dest.sendRaw('{"a":"reset","t":"chat","objs":[' + log + ']}');
    });
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

P.adopt = function (client) {
    if (this.client)
        return false;

    if (this.idleTimeout) {
        clearTimeout(this.idleTimeout);
        this.idleTimeout = 0;
    }
    client.player = this;
    this.key = client.key;
    this.r = client.r;
    this.ip = client.ip;
    this.set({client: client, name: client.name || 'Anonymous'});
    client.once('disconnected', this.abandon.bind(this));

    if (this.isPlaying()) {
        var self = this;
        this.sendHand(function (err) {
            if (err)
                self.drop(err);
            self.game.sendState(self);
            self.game.sendMessageHistory(self);
            self.send('set', {t: 'account', action: 'leave'});
        });
    }
    else
        this.send('set', {t: 'account', action: 'join'});
    return true;
};

P.abandon = function () {
    var name = this.client.name;
    this.client.player = null;
    this.set({client: null});
    this.idleTimeout = setTimeout(this.sudoku.bind(this), common.IDLE_TIMEOUT*1000);
};

P.sudoku = function () {
    if (this.game) {
        // ugh
        this.once('dropComplete', this.cleanUp.bind(this));
        this.emit('dropped');
    }
    else
        this.cleanUp();
};

P.cleanUp = function () {
    this.key = null;
    this.r = null;
    this.removeAllListeners();
    delete PLAYERS[this.id];
};

P.toJSON = function () {
    var json = this.client ? this.client.toJSON() : {name: this.name};
    json.kind = 'player';
    json.score = this.score;
    if (this.selection)
        json.ready = true;
    if (!this.client)
        json.idle = true;
    return json;
};

P.isPlaying = function () {
    return !!this.game;
};

P.dealHand = function (fresh) {
    var self = this;
    this.r.scard(this.key + ':hand', function (err, oldCardCount) {
        if (err)
            return self.drop(err);
        if (fresh)
            oldCardCount = 0;
        var cardsNeeded = HAND_SIZE - oldCardCount;
        if (!self.game || cardsNeeded < 1)
            return;

        var sameGame = self.game;
        var m = self.r.multi();
        sameGame.popWhites(m, cardsNeeded);
        m.exec(function (err, rs) {
            if (err)
                return self.drop(err);
            var newCards = _.compact(rs);
            cardsNeeded -= newCards.length;

            if (cardsNeeded > 0) {
                sameGame.reshuffleWhites(function (err) {
                    if (err) {
                        self.warn("Lost " + newCards.length + " card(s).");
                        return self.drop(err);
                    }
                    var m = self.r.multi();
                    sameGame.popWhites(m, cardsNeeded);
                    m.exec(function (err, rs) {
                        if (err) {
                            self.warn("Lost " + newCards.length + " card(s).");
                            return self.drop(err);
                        }
                        newCards = newCards.concat(_.compact(rs));
                        self.storeNewHand(newCards, fresh);
                    });
                });
            }
            else
                self.storeNewHand(newCards, fresh);
        });
    });
};

P.storeNewHand = function (newCards, fresh) {
    if (!fresh && !newCards.length)
        return;
    var key = this.key + ':hand';
    var m = this.r.multi();
    if (fresh)
        m.del(key);
    if (newCards.length)
        m.sadd(key, newCards);
    var self = this;
    m.exec(function (err) {
        if (err) {
            // redis probably failed, not much point trying to recover
            self.warn("Lost " + newCards.length + " card(s).");
            return self.drop(err);
        }
        var cards = cardsFromNames(newCards);
        self.send(fresh ? 'reset' : 'add', {t: 'hand', objs: cards});
    });
};

P.sendHand = function (cb) {
    var self = this;
    this.r.smembers(this.key + ':hand', function (err, hand) {
        if (err)
            return cb(err);
        self.send('reset', {t: 'hand', objs: cardsFromNames(hand)});
        cb(null);
    });
};

P.discardHand = function (destKey, cb) {
    var game = this.game;
    var handKey = this.key + ':hand';
    var self = this;
    this.r.smembers(handKey, function (err, cards) {
        if (err)
            return cb(err);
        var m = self.r.multi();
        cards.forEach(function (white) {
            m.smove(handKey, destKey, white);
        });
        m.exec(cb);
    });
};

P.incrementTotalScore = function (m) {
    m.hincrby(this.key, 'score', 1);
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

            // xxx move this
            if (self.ip != '127.0.0.1' && game.players.some(function (p) { return p.ip == self.ip; }))
                return self.warn('Already playing.');

            self.send('set', {t: 'account', action: 'leave'});
            game.addPlayer(self);
        });
    });
};

P.handle_leave = function (msg) {
    var sameGame = this.game;
    if (!sameGame)
        return this.warn("Not playing yet!");
    var self = this;
    this.r.hdel(this.key, 'game', function (err) {
        if (err)
            return self.drop(err);
        sameGame.dropPlayer(self);
        if (self.client)
            sameGame.addSpec(self.client);
        self.send('set', {t: 'account', action: 'join'});
        self.send('reset', {t: 'hand', objs: []});
    });
};

function cardsFromNames(hand) {
    hand = hand.slice().sort();
    return hand.map(function (name) { return {id: name}; });
}

P.handle_submit = function (msg) {
    var cards = msg.cards;

    if (!this.game || this.game.current != 'nominating')
        return;
    if (this.id == this.game.dealer)
        return;

    if (!cards || !_.isArray(cards) || !cards.length) {
        // Clear selection
        this.set({selection: null});
        this.send('select', {cards: []});
        return;
    }

    if (!cards.every(function (card) { return typeof card == 'string'; }))
        return this.warn("Invalid choices!");
    if (_.uniq(cards).length != cards.length)
        return this.warn("Duplicate choices!");

    this.set({selection: msg.cards});
    this.remindSubmission();
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

P.handOverSubmission = function (m, submission, discards) {
    m.srem(this.key + ':hand', submission.cards);
    m.sadd(discards, submission.cards);
};

P.confirmSubmission = function (mapping) {
    var sub = mapping[this.id];
    if (sub)
        this.send('select', {cards: sub.cards, final: true});
    else
        this.send('set', {status: 'Invalid submission!'});
    this.send('set', {action: null});
    this.set({selection: null});
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
    fs.readdir('sets', function (err, sets) {
        if (err)
            return cb(err);
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
                m.del(['cam:game:1:whiteDiscards', 'cam:game:1:blackDiscards', 'cam:game:1:scores', 'cam:game:1:players']);

                function makeDeck(key, deck) {
                    m.del(key);
                    m.sadd(key, _.uniq(deck));
                }
                makeDeck('cam:game:1:whites', whites);
                makeDeck('cam:game:1:blacks', blacks);

                m.exec(cb);
            });
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

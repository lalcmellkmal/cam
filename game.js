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
var ROUND_POINTS = 5;
var MESSAGE_RATE = 7;
var DEALER_TERM = "judge";

var TIMEOUTS = {
    nomination: 25,
    election: 40,
    intermission: 20,
    abandoned: 30, // clientless
    afk: 10*60, // no actions
};

var GAMES = {};
var PLAYERS = {};

var SHARED_REDIS;
exports.setRedis = function (r) { SHARED_REDIS = r; };

function Game(id) {
    Model.call(this);

    this.r = SHARED_REDIS;
    this.id = id;
    this.key = 'cam:game:' + id;
    this.dealer = null;
    this.players = [];
    this.specs = [];

    var rosterChanged = this.deferral('broadcastRoster');
    this.on('change:players', rosterChanged);
    this.on('change:specs', rosterChanged);

    var changed = this.deferral('broadcastState');
    this.on('change:black', changed);
    this.on('change:dealer', changed);
    this.on('change:submissions', changed);

    this.on('change:dealer', this.dealerChanged.bind(this));

    this.playerClientChangedCb = this.playerClientChanged.bind(this);
    this.playerNameChangedCb = this.playerNameChanged.bind(this);
    this.playerScoreChangedCb = this.playerScoreChanged.bind(this);
    this.playerSelectionChangedCb = this.playerSelectionChanged.bind(this);
    this.specNameChangedCb = this.specNameChanged.bind(this);

    this.on('change:submissions', this.setupElectionTimer.bind(this));
}
util.inherits(Game, Model);
exports.Game = Game;

Game.load = function (id, cb) {
    if (!(id in GAMES))
        GAMES[id] = new Game(id);
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
        {name: 'victoryAwarded', from: 'electing', to: 'awarding'},
        {name: 'nextNominations', from: 'awarding', to: 'nominating'},
        {name: 'lostPlayer', from: 'nominating', to: 'electing'},
        {name: 'notEnoughPlayers', from: ['nominating', 'electing', 'awarding'], to: 'inactive'},
    ],
});

G.addSpec = function (client) {
    if (this.specs.indexOf(client) >= 0)
        return this.warn('Already watching.');
    this.specs.push(client);
    this.setChanged('specs');
    client.on('change:name', this.specNameChangedCb);
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
    client.removeListener('change:name', this.specNameChangedCb);
};

G.addPlayer = function (player) {
    if (this.players.indexOf(player) >= 0) {
        this.warn('Already playing.');
        return false;
    }
    if (player.ip != '127.0.0.1' && this.players.some(function (p) { return p.ip == player.ip; })) {
        this.warn('Already playing.');
        return false;
    }
    if (this.players.length >= MAX_PLAYERS) {
        player.send('set', {t: 'account', action: 'gameFull'});
        return false;
    }

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

        player.on('change:client', self.playerClientChangedCb);
        player.on('change:selection', self.playerSelectionChangedCb);
        player.on('change:score', self.playerScoreChangedCb);
        player.on('change:name', self.playerNameChangedCb);
        player.once('dropped', self.dropPlayer.bind(self, player));

        if (player.client)
            self.removeSpec(player.client);

        self.sendState(player);
        self.newPlayer();
    });
    return true;
};

G.dropPlayer = function (player) {
    var i = this.players.indexOf(player);
    if (i < 0)
        return this.warn("Player not in player list!");
    this.players.splice(i, 1);
    this.setChanged('players');

    if (this.dealer == player.id) {
        var newDealer = null;
        if (this.players[i])
            newDealer = this.players[i];
        else if (this.players[0])
            newDealer = this.players[0];
        this.set({dealer: newDealer && newDealer.id});
        if (newDealer)
            newDealer.set({selection: null});
        this.electRandom(true);
    }

    var self = this;
    player.discardHand(this.key + ':whiteDiscards', function (err) {
        if (err)
            console.error(err);
        self.r.srem(self.key + ':players', player.id, function (err) {
            if (err)
                console.error(err);

            player.set({game: null});
            player.removeListener('change:client', self.playerClientChangedCb);
            player.removeListener('change:name', self.playerNameChangedCb);
            player.removeListener('change:score', self.playerScoreChangedCb);
            player.removeListener('change:selection', self.playerSelectionChangedCb);
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

G.broadcastRoster = function () {
    this.sendAll('reset', {t: 'roster', objs: this.makeRoster()});
};

G.sendRoster = function (dest) {
    dest.send('reset', {t: 'roster', objs: this.makeRoster()});
};

G.specNameChanged = function (name, client) {
    this.sendAll('set', {t: 'roster', id: client.clientId, name: name});
};

G.playerNameChanged = function (name, player, info) {
    this.sendAll('set', {t: 'roster', id: player.id, name: name});

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

G.playerScoreChanged = function (score, player) {
    this.sendAll('set', {t: 'roster', id: player.id, score: score});
};

G.playerClientChanged = function (client, player) {
    this.sendAll('set', {t: 'roster', id: player.id, abandoned: !client});
};

G.dealerChanged = function (newDealer, game, info) {
    var oldDealer = info.previous;
    if (oldDealer)
        this.sendAll('set', {t: 'roster', id: oldDealer, kind: 'player'});
    this.sendAll('set', {t: 'roster', id: newDealer, kind: 'dealer'});
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
            return self.fail("No " + DEALER_TERM + "!");
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
    this.players.forEach(function (player) {
        player.clearAfk();
    });
    var self = this;
    this.r.hmset(this.key, {state: 'inactive', black: ''}, function (err) {
        if (err)
            return self.fail(err);
        self.set({black: null});
        self.broadcastState();
    });
};

G.onleaveinactive = function () {
    this.players.forEach(function (player) {
        player.resetAfk();
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
                info.status = 'You are the ' + DEALER_TERM + '. Waiting for submissions...';
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
                info.status = 'The ' + DEALER_TERM + ' is picking their favorite...';
            info.submissions = this.anonymizedSubmissions();
            break;
        case 'awarding':
            info.status = "Waiting for the next black card...";
            break;
        default:
            console.warn("Unknown state to send: " + this.current);
            info.status = "Unknown state.";
    }

    // Hacky delta: Avoid sending submissions over and over
    if (info.submissions) {
        if (dest.sentSubmissions)
            delete info.submissions;
        else
            dest.sentSubmissions = true;
    }
    else
        dest.sentSubmissions = false;

    dest.send('set', info);
};

G.saveState = function () {
    // todo
};

G.playerSelectionChanged = function (sel, player, info) {
    var ready = null;
    if (sel && !info.previous)
        ready = true;
    else if (!sel && info.previous)
        ready = false;
    if (ready !== null)
        this.sendAll('set', {t: 'roster', id: player.id, ready: ready});

    this.nominate();
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
        var timeout = TIMEOUTS.nomination;
        if (this.black && this.black.blankCount > 1)
            timeout += 5;
        this.nominationTimer = setTimeout(this.nominationTimedOut.bind(this), timeout*1000);
        this.sendAll('countdown', {remaining: timeout - 1});
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
            self.victoryAwarded();
            self.nextDealer();
            self.nextNominations();
            return;
        }
        shuffle(submissions);

        var m = self.r.multi();
        submissions.forEach(function (sub) {
            if (!sub.player)
                return;
            sub.player.handOverSubmission(m, sub, self.key + ':whiteDiscards');
            delete sub.player;
        });
        m.hmset(self.key, {state: 'electing', submissions: JSON.stringify(submissions)});
        m.exec(function (err) {
            if (err)
                return self.fail(err);

            self.players.forEach(function (player) {
                if (player.id != self.dealer)
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
        delay = TIMEOUTS.election * 1000;
        this.sendAll('countdown', {remaining: TIMEOUTS.election - 1});
    }
    var self = this;
    this.electionTimer = setTimeout(function () {
        self.electionTimer = 0;
        self.electRandom(false);
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
        return dealer.warn("You are not the " + DEALER_TERM + ".");

    for (var i = 0; i < this.submissions.length; i++) {
        var sub = this.submissions[i];
        if (_.isEqual(sub.cards, choice)) {
            if (this.acquireElectionLock())
                this.electVictor(sub, dealer, false);
            return;
        }
    }
    dealer.warn("Invalid choice.");
};

G.electVictor = function (winningSub, dealer, keepDealer) {
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

            self.victoryAwarded();
            // Pause for announcement (would be nice to defer this in the client instead)
            setTimeout(function () {
                self.releaseElectionLock(null);
                if (gameScore < ROUND_POINTS) {
                    if (!keepDealer)
                        self.nextDealer();
                    self.nextNominations();
                }
                else
                    self.roundOver(name);
            }, 3000);
        });
    });
};

G.roundOver = function (winner) {
    this.logMeta(['The round was won by ', {white: winner}, '!']);
    this.sendAll('set', {status: 'The round was won by ' + winner + '!'});

    var self = this;
    async.forEach(this.players, function (player, cb) {
        // dealHand overwrites the old cards, so need to discard first
        player.discardHand(self.key + ':whiteDiscards', function (err) {
            if (err)
                return cb(err);
            player.dealHand(true);
            cb(null);
        });
    }, function (err) {
        if (err)
            console.error(err);

        setTimeout(function () {
            self.players.forEach(function (player) {
                player.set({score: 0});
                player.sendHand(function (err) {
                    if (err)
                        return player.drop(err);
                });
            });
            self.r.del(self.key + ':scores', function (err) {
                if (err)
                    return self.fail(err);
                self.nextDealer();
                self.nextNominations();
            });
        }, TIMEOUTS.intermission * 1000);
    });
};

G.electRandom = function (keepDealer) {
    if (this.current != 'electing')
        return;
    if (this.acquireElectionLock()) {
        var i = Math.floor(Math.random() * this.submissions.length);
        this.electVictor(this.submissions[i], null, keepDealer);
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
    text = text.replace(/r[il1'*.]g+[e3'*.]?d/ig, 'shouganai');
    var self = this;
    this.rateLimit(client, function (err, okay) {
        if (err)
            return client.drop(err);
        if (okay)
            self.pushMessage({
                    text: text,
                    name: client.name || 'Anonymous',
                    date: new Date().getTime(),
            });
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
    this.setMaxListeners(0);
    this.id = id;
    this.score = 0;
}
util.inherits(Player, Model);
exports.Player = Player;

var P = Player.prototype;

Player.load = function (id, cb) {
    if (id in PLAYERS)
        return cb(null, PLAYERS[id]);

    var player = new Player(id);
    PLAYERS[id] = player;
    return cb(null, player);
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

    if (this.abandonedTimeout) {
        clearTimeout(this.abandonedTimeout);
        this.abandonedTimeout = 0;
    }
    client.player = this;
    this.key = client.key;
    this.r = client.r;
    this.ip = client.ip;
    this.set({client: client, name: client.name || 'Anonymous'});
    client.once('disconnected', this.abandon.bind(this));

    if (this.isPlaying()) {
        var self = this;
        this.sentSubmissions = false;
        this.sendHand(function (err) {
            if (err)
                self.drop(err);
            self.game.sendState(self);
            self.game.sendMessageHistory(self);
            self.game.sendRoster(self);
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
    this.abandonedTimeout = setTimeout(this.sudoku.bind(this), TIMEOUTS.abandoned*1000);
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
    this.removeAllListeners();
    delete PLAYERS[this.id];
};

P.toJSON = function () {
    var json = this.client ? this.client.toJSON() : {name: this.name};
    json.id = this.id;
    json.kind = 'player';
    json.score = this.score;
    if (this.selection)
        json.ready = true;
    if (!this.client)
        json.abandoned = true;
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
    if (!/^\d+$/.test(msg.game))
        return false;
    var gameId = parseInt(msg.game, 10);
    var self = this;
    Game.load(gameId, function (err, game) {
        if (err)
            return self.drop(err);

        var joined = game.addPlayer(self);
        if (joined) {
            self.send('set', {t: 'account', action: 'leave'});
            if (game.current != 'inactive')
                self.resetAfk();
        }
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
        self.clearAfk();
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
    this.resetAfk();
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
    m.srem.apply(m, [this.key + ':hand'].concat(submission.cards));
    m.sadd(discards, submission.cards);
};

P.confirmSubmission = function (mapping) {
    var sub = mapping[this.id];
    this.send('select', {cards: sub ? sub.cards : [], final: true});
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
    this.resetAfk();
};

P.resetAfk = function () {
    this.clearAfk();
    this.afkTimeout = setTimeout(this.afk.bind(this), TIMEOUTS.afk*1000);
};

P.clearAfk = function () {
    if (this.afkTimeout)
        clearTimeout(this.afkTimeout);
};

P.afk = function () {
    this.afkTimeout = 0;
    if (!this.game)
        return;
    this.game.logMeta(this.name + ' was dropped for being idle.');
    this.handle_leave({});
};

function loadDeck(filename, dest, cb) {
    fs.readFile(filename, 'UTF-8', function (err, file) {
        if (err)
            return cb(err);
        file.split('\n').forEach(function (line) {
            line = line.trim();
            if (line && !/^#/.test(line))
                dest.push(line);
        });
        cb(null);
    });
}

function setupRound(gameId, cb) {
    fs.readdir('sets', function (err, sets) {
        if (err)
            return cb(err);
        var whiteSets = [], blackSets = [];
        sets.forEach(function (set) {
            if (/black/i.test(set))
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
                var key = 'cam:game:' + gameId;
                m.del([key+':whiteDiscards', key+':blackDiscards', key+':scores', key+':players']);

                function makeDeck(k, deck) {
                    m.del(k);
                    m.sadd(k, _.uniq(deck));
                }
                makeDeck(key+':whites', whites);
                makeDeck(key+':blacks', blacks);

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

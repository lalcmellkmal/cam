//(function () {

var Card = Backbone.Model.extend({
	defaults: {
		state: 'normal',
	},
});

var Cards = Backbone.Collection.extend({
	model: Card,

	resetSelections: function (opts) {
		opts = opts || {};
		this.each(function (card) {
			if (card !== opts.except)
				card.set({index: 0, state: 'normal'});
		});
	},
});

var CardView = Backbone.View.extend({
	tagName: 'li',

	events: {
		click: 'select',
	},

	select: function (event) {
		if (!game.get('unlocked'))
			return;
		if (this.model.get('state') == 'selecting')
			hand.resetSelections();
		else
			this.model.set({state: 'selecting'});
	},

	initialize: function () {
		this.$el.append('<span/><a/>');
		this.model.on('change', this.render, this);
		this.model.on('remove', this.fadeAway, this);
	},

	render: function () {
		var attrs = this.model.attributes;
		this.$('a').text(this.model.id);
		this.$('span').text(attrs.index || '').toggle(!!attrs.index);
		this.$el.prop('class', attrs.state);
		return this;
	},

	fadeAway: function () {
		this.$el.animate({opacity: 0, width: 0}, function () {
			$(this).remove();
		});
	},
});

var HandView = Backbone.View.extend({
	tagName: 'ul',

	initialize: function () {
		this.model.on('reset', this.reset, this);
	},

	reset: function (model) {
		this.$el.empty();
		this.model.each(this.addCard, this);
	},

	addCard: function (card) {
		var view = new CardView({model: card});
		this.$el.append(view.render().el);
	},
});

var Game = Backbone.Model.extend({
	defaults: {
		status: 'Loading...',
	},

	initialize: function () {
		hand.on('change:state', this.selectionChanged, this);
	},

	selectionChanged: function (card, newState) {
		if (newState != 'selecting')
			return;
		var black = this.get('black');
		var n = black.blankCount;
		if (n < 2)
			return send('select', {cards: [card.id]});
		// Figure out the next index
		var indices = _.filter(hand.pluck('index'), function (x) { return x; });
		indices.push(0);
		var index = _.max(indices) + 1;

		if (index > n) {
			index = 1;
			hand.resetSelections({except: card});
		}
		card.set({index: index});
		if (index == n) {
			var choices = hand.where({state: 'selecting'});
			choices.sort(function (a, b) {
				return a.get('index') - b.get('index');
			});
			send('select', {cards: _.pluck(choices, 'id')});
		}
	},
});

var GameView = Backbone.View.extend({
	events: {
		'click #join': 'joinGame',
	},

	initialize: function () {
		var handView = new HandView({model: hand, id: 'myHand'});
		var submissions = new HandView({model: this.model, id: 'submissions'});
		var accountView = new AccountView({model: account});

		var black = $('<li class="black"><a/></li>').hide();
		var joinButton = $('<input type=button id=join value=Join>').hide();
		this.$el.prepend(black, accountView.render().el, ' <p id="roster"></p> '
			).append(joinButton, submissions.el, handView.el);

		this.model.on('change:status change:error', this.renderStatus, this);
		this.model.on('change:canJoin', this.renderCanJoin, this);
		this.model.on('change:roster', this.renderRoster, this);
		this.model.on('change:black', this.renderBlack, this);
		this.model.on('change:unlocked', this.renderHandLock, this);
		this.model.on('change:submissions', this.renderSubmissions, this);
	},

	joinGame: function () {
		send('join', {});
		this.model.set({canJoin: false});
	},

	renderStatus: function () {
		var attrs = this.model.attributes;
		this.$('#status').text(attrs.status).prop('class', attrs.error ? 'error' : '');
	},

	renderCanJoin: function () {
		this.$('#join').toggle(!!this.model.get('canJoin'));
	},

	renderRoster: function () {
		var roster = this.model.get('roster');
		var $list = this.$('#roster').empty();
		_.each(roster, function (player) {
			$list.append($('<a/>', {
				text: player.name,
				class: player.kind,
			}), '<br>');
		});
	},

	renderBlack: function () {
		var black = this.model.get('black');
		var $black = this.$('.black:first');
		if (!black) {
			$black.hide();
			return;
		}
		$black.find('a').text(black.text);
		$black.show();
	},

	renderHandLock: function () {
		this.$('#myHand').toggleClass('unlocked', this.model.get('unlocked'));
	},

	// share with handview?
	renderSubmissions: function () {
		var subs = this.model.get('subs');
		var $subs = this.$('#submissions');
		if (!subs || !subs.length)
			return $subs.hide();
		// should animate
		$subs.empty();
	},
});

var Account = Backbone.Model.extend({
});

var AccountView = Backbone.View.extend({
	events: {
		submit: 'changeName',
	},

	initialize: function () {
		this.model.on('change', this.render, this);
		this.$el.append('<form id=account><input id=username> <input type=submit value="Set name"></form>');
	},

	render: function () {
		this.$('#username').val(this.model.get('name') || '');
		return this;
	},

	changeName: function (event) {
		event.preventDefault();
		var name = this.$('#username').val().trim();
		console.log(name);
		if (name)
			send('setName', {name: name});
	},
});

var account = new Account;
var hand = new Cards;
var game = new Game;

window.account = account;
window.hand = hand;
window.game = game;

$(function () {
	var gameView = new GameView({model: game, el: $('#game')[0]});
});

function send(type, msg) {
	msg.a = type;
	msg = JSON.stringify(msg);
	console.log('> ' + msg);
	sock.send(msg);
}

window.sock = new SockJS('http://localhost:8000/sockjs');
sock.onopen = function () {
	var id = localStorage.getItem('camId');
	if (!id) {
		id = randomId();
		localStorage.setItem('camId', id);
	}
	send('login', {id: id});
};

sock.onmessage = function (msg) {
	_.each(JSON.parse(msg.data), function (data) {
		console.log('< ' + JSON.stringify(data));
		dispatch[data.a].call(data);
	});
};

sock.onclose = function () {
	var err = 'Lost connection.';
	if (game.get('error'))
		err = 'Dropped: ' + game.get('status');
	game.set({status: err, error: true});
};

var dispatch = {
	account: function () {
		game.set({account: new Account({name: this.name})});
	},

	set: function () {
		var target = 'game';
		if (this.t) {
			target = this.t;
			delete this.t;
		}
		window[target].set(this);
	},

	black: function () {
		var black = parseBlack(this.black);
		var write = {black: black};
		if (game.get('unlocked')) {
			var n = black.blankCount;
			var word = {1: 'one', 2: 'two', 3: 'three'}[n];
			write.status = 'Pick ' + (word || n) + '.';
		}
		game.set(write);
	},

	hand: function () {
		hand.reset(this.hand);
	},

	select: function () {
		var targets = _.map(this.cards, function (card) {
			return hand.get(card);
		});
		var final = this.final;
		hand.each(function (card) {
			var dest = 'normal';
			if (targets.indexOf(card) >= 0) {
				if (final)
					return;
				dest = 'selected';
			}
			else if (!final && card.get('state') == 'selecting')
				return;
			card.set({state: dest});
		});
		if (final)
			hand.remove(targets);
	},
};

function randomId() {
        return '' + (Math.floor(Math.random() * 1e16) + 1);
}

//})();

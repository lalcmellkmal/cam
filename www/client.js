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
		send('submit', {});
	},
});

var CardView = Backbone.View.extend({
	tagName: 'li',

	events: {
		click: 'select',
	},

	select: function (event) {
		if (game.get('action') != 'nominate')
			return;
		if (this.model.get('state') != 'normal')
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
		var black = this.get('blackInfo');
		var n = black.blankCount;
		if (n < 2)
			return send('submit', {cards: [card.id]});
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
			send('submit', {cards: _.pluck(choices, 'id')});
		}
	},
});

var GameView = Backbone.View.extend({
	events: {
		'click #join': 'joinGame',
		'click .electing a': 'elect',
	},

	initialize: function () {
		var handView = new HandView({model: hand, id: 'myHand'});
		var $roster = $('<p/>', {id: 'roster'});
		var $submissions = $('<div/>', {id: 'submissions'});

		var black = $('<li class="black"><a/></li>').hide();
		var joinButton = $('<input type=button id=join value=Join>').hide();
		this.$el.prepend(black, $roster, $submissions
			).append(joinButton, handView.el);

		this.model.on('change:status change:error', this.renderStatus, this);
		this.model.on('change:canJoin', this.renderCanJoin, this);
		this.model.on('change:roster', this.renderRoster, this);
		this.model.on('change:black', this.renderBlack, this);
		this.model.on('change:action', this.renderAction, this);
		this.model.on('change:submissions change:blackInfo', this.renderSubmissions, this);
	},

	joinGame: function () {
		send('join', {});
		this.model.set({canJoin: false});
	},

	elect: function (event) {
		if (this.model.get('action') != 'elect')
			return;
		var cards = $(event.currentTarget).data('cards');
		if (cards)
			send('elect', {cards: cards});
	},

	renderStatus: function () {
		var attrs = this.model.attributes;
		this.$('#status').text(attrs.status).prop('class', attrs.error ? 'error' : '');
	},

	renderCanJoin: function (model, canJoin) {
		this.$('#join').toggle(!!canJoin);
	},

	renderRoster: function (model, roster) {
		var $list = this.$('#roster').empty();
		_.each(roster, function (player) {
			var $a = $('<a/>', {
				text: player.name,
				class: player.kind,
			});
			if (player.kind == 'dealer')
				$a.prepend('<b>Dealer:</b> ');
			if (player.score)
				$a.append(' ', $('<em/>', {text: '('+player.score+')'}));
			$list.append($a, '<br>');
		});
	},

	renderBlack: function (model, black) {
		var $black = this.$('.black:first');
		if (black) {
			var info = parseBlack(black);
			$black.find('a').text(info.text);
			this.model.set({blackInfo: info});
		}
		else {
			this.model.set({blackInfo: null});
		}
		$black.toggle(!!black);
	},

	renderAction: function (model, action) {
		var electing = action == 'elect';
		this.$('#myHand').toggle(!electing).toggleClass('unlocked', action == 'nominate');
		this.$('#submissions').toggleClass('electing', electing);
	},

	renderSubmissions: function () {
		var $subs = this.$('#submissions');
		var subs = this.model.get('submissions');
		var black = this.model.get('blackInfo');
		if (!subs || !subs.length || !black)
			return $subs.hide();
		$subs.empty();
		var self = this;
		var fadeIns = [];
		_.each(subs, function (sub) {
			var $a = self.renderSubmission(black, sub);
			sub.el = $a[0];
			$a.css({opacity: 0}).appendTo($subs);
			fadeIns.push($a);
		});
		$subs.show();

		function showNext() {
			if (!fadeIns.length)
				return;
			fadeIns.shift().animate({opacity: 1}, {complete: showNext});
		}
		showNext();
	},

	renderSubmission: function (black, sub) {
		var $a = $('<a/>', {data: {cards: sub.cards}});
		_.each(applySubmission(black, sub), function (bit) {
			if (bit.white)
				$a.append($('<b/>', {text: bit.white}));
			else
				$a.append(document.createTextNode(bit));
		});
		return $a;
	},
});

var Account = Backbone.Model.extend({
});

var AccountView = Backbone.View.extend({
	id: 'account',

	events: {
		submit: 'changeName',
	},

	initialize: function () {
		this.model.on('change', this.render, this);
		this.$el.append('<form><input id=username> <input type=submit value="Set name"></form>');
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
	var $game = $('#game');
	var accountView = new AccountView({model: account});
	accountView.render().$el.insertBefore($game);
	var gameView = new GameView({model: game, el: $game[0]});
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

	elect: function () {
		var winner = this.cards;
		_.each(game.get('submissions'), function (sub) {
			console.log('submission', sub);
			if (!sub.el)
				return;
			if (_.isEqual(sub.cards, winner))
				$(sub.el).addClass('winner');
			else
				$(sub.el).animate({opacity: 0});
		});
	},
};

function randomId() {
        return '' + (Math.floor(Math.random() * 1e16) + 1);
}

//})();

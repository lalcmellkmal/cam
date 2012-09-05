//(function () {

var Card = Backbone.Model.extend({
	defaults: {
		state: 'normal',
	},
});

var Cards = Backbone.Collection.extend({
	model: Card,
});

var CardView = Backbone.View.extend({
	tagName: 'li',

	events: {
		click: 'select',
	},

	select: function (event) {
		if (!game.get('unlocked'))
			return;
		send('select', {card: this.model.id});
		this.model.set({state: 'selecting'});
	},

	initialize: function () {
		this.$el.append($('<a/>'));
		this.model.on('change', this.render, this);
		this.model.on('destroy', this.remove, this);
	},

	render: function () {
		this.$('a').text(this.model.id);
		this.$el.prop('class', this.model.get('state'));
		return this;
	},
});

var HandView = Backbone.View.extend({
	tagName: 'ul',

	initialize: function () {
		this.model.on('reset', this.reset, this);
		this.model.on('remove', this.removeCard, this);

	},

	reset: function (model) {
		this.$el.empty();
		hand.each(this.addCard, this);
	},

	addCard: function (card) {
		var view = new CardView({model: card});
		this.$el.append(view.render().el);
	},

	removeCard: function (card, hand, opts) {
		this.$('li').eq(opts.index).animate({
			opacity: 0,
			width: 0,
		}, function () {
			$(this).remove();
		});
	},

});

var Game = Backbone.Model.extend({
	defaults: {
		status: 'Loading...',
	},
});

var GameView = Backbone.View.extend({
	initialize: function () {
		var handView = new HandView({model: hand, id: 'myHand'});
		var submissions = new HandView({model: this.model, id: 'submissions'});
		var black = $('<li class="black"><a/></li>').hide();
		this.$el.append(black, ' <p id="roster"></p> ', submissions.$el.hide(), handView.$el);

		this.model.on('change:status change:error', this.renderStatus, this);
		this.model.on('change:roster', this.renderRoster, this);
		this.model.on('change:black', this.renderBlack, this);
		this.model.on('change:unlocked', this.renderHandLock, this);
		this.model.on('change:submissions', this.renderSubmissions, this);
	},

	renderStatus: function () {
		var attrs = this.model.attributes;
		this.$('#status').text(attrs.status).prop('class', attrs.error ? 'error' : '');
	},

	renderRoster: function () {
		var roster = this.model.get('roster');
		roster = roster.map(function (player) { return player.name; });
		this.$('#roster').text('Players: ' + roster.join(', '));
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

var hand = new Cards;
var game = new Game;

window.hand = hand;
window.game = game;

$(function () {
	var gameView = new GameView({model: game, el: $('#game')[0]});
});

function send(type, msg) {
	msg.a = type;
	sock.send(JSON.stringify(msg));
}

window.sock = new SockJS('http://localhost:8000/sockjs');
sock.onopen = function () {
	send('login', {name: 'anon'});
};

sock.onmessage = function (msg) {
	_.each(JSON.parse(msg.data), function (data) {
		var func = dispatch[data.a];
		if (func)
			func(data);
		else if (window.console)
			console.warn("No such dispatch " + data.a);
	});
};

sock.onclose = function () {
	var err = 'Lost connection.';
	if (game.get('error'))
		err = 'Dropped: ' + game.get('status');
	game.set({status: err, error: true});
};

var dispatch = {};

dispatch.set = function (msg) {
	var target = 'game';
	if (msg.t) {
		target = msg.t;
		delete msg.t;
	}
	window[target].set(msg);
};

dispatch.error = function (msg) {
	game.set({status: msg.reason, error: true});
};

dispatch.status = function (msg) {
	game.set({status: msg.status, error: false});
};

dispatch.black = function (msg) {
	var black = parseBlack(msg.black);
	var write = {black: black};
	if (game.get('unlocked'))
		write.status = 'Pick ' + black.blankCount + '.';
	game.set(write);
};

dispatch.hand = function (msg) {
	hand.reset(msg.hand);
};

dispatch.select = function (msg) {
	var target = hand.get(msg.card);
	hand.each(function (card) {
		var dest = 'normal';
		if (card === target) {
			if (msg.final)
				return hand.remove(target);
			dest = 'selected';
		}
		else if (!msg.final && card.get('state') == 'selecting')
			return;
		card.set({state: dest});
	});
};

/*
Backbone.Sync = function (method, model, opts) {
	console.log('sync', method, model, opts);
	if (method == 'read')
		send(method, model.attributes);
};
*/

//})();

(function () {

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
		this.model.on('add', this.addCard, this);
	},

	reset: function (model) {
		this.$el.empty();
		this.model.each(this.addCard, this);
	},

	addCard: function (card) {
		var view = new CardView({model: card});
		var $card = view.render().$el;
		$card.css({opacity: 0}).animate({opacity: 1});
		this.$el.append($card);
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
		'click .electing a': 'elect',
	},

	initialize: function () {
		var handView = new HandView({model: hand, id: 'myHand'});
		var $roster = $('<p/>', {id: 'roster'});
		var $submissions = $('<div/>', {id: 'submissions'});

		var black = $('<li class="black"><a/></li>').hide();
		this.$el.prepend(black, $roster, $submissions).append(handView.el);

		this.model.on('change:status change:error', this.renderStatus, this);
		this.model.on('change:roster', this.renderRoster, this);
		this.model.on('change:black', this.renderBlack, this);
		this.model.on('change:action', this.renderAction, this);
		this.model.on('change:submissions change:blackInfo', this.renderSubmissions, this);
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
			if (player.score)
				$a.append(' ', $('<em/>', {text: '('+player.score+')'}));
			if (player.ready)
				$a.addClass('ready');
			if (player.idle)
				$a.addClass('idle');
			$list.append($a, '<br>');
		});
	},

	renderBlack: function (model, black) {
		var $black = this.$('.black:first');
		if (black) {
			var info = parseBlack(black);
			$black.find('a').text(info.text).hide().fadeIn();
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
		'click #join': 'joinGame',
		'click #leave': 'leaveGame',
	},

	initialize: function () {
		this.model.on('change', this.render, this);
		var $join = $('<input type=button id=join value="Join game">').hide();
		var $leave = $('<input type=button id=leave value="Leave game">').hide();
		this.$el.append('<form><input id=username maxlength='+USERNAME_LENGTH+'> <input type=submit value="Set name"></form>', $join, $leave);
	},

	render: function () {
		var attrs = this.model.attributes;
		this.$('#username').val(attrs.name || '');
		this.$('#join').toggle(attrs.action == 'join');
		this.$('#leave').toggle(attrs.action == 'leave');
		return this;
	},

	joinGame: function () {
		send('join', {});
		this.model.set({action: null});
	},

	leaveGame: function () {
		if (!confirm("Sure you want to leave? You'll lose your points."))
			return;
		send('leave', {});
		this.model.set({action: null});
	},

	changeName: function (event) {
		event.preventDefault();
		var name = this.$('#username').val().trim();
		if (name)
			send('setName', {name: name});
	},
});

var ChatMessage = Backbone.Model.extend({
});

var Chat = Backbone.Collection.extend({
	model: ChatMessage,
});

var ChatMessageView = Backbone.View.extend({
	tagName: 'p',

	initialize: function () {
		this.model.on('remove', this.remove, this);
	},

	render: function () {
		var attrs = this.model.attributes, $p = this.$el;
		$p.text(attrs.text);
		if (attrs.name)
			$p.prepend($('<b/>', {text: '<' + attrs.name + '>'}), ' ');
		if (attrs.kind)
			$p.addClass(attrs.kind);
		return this;
	},
});

var ChatView = Backbone.View.extend({
	id: 'chat',

	events: {
		submit: 'sendChat',
	},

	initialize: function () {
		var $messages = $('<div id=messages/>');
		var $input = $('<input>', {maxlength: MESSAGE_LENGTH});
		var $form = $('<form/>').append($input);
		this.$el.append($messages, $form);
		setTimeout(function () {
			$input.focus();
		}, 0);

		this.model.on('add', this.addMessage, this);
		this.model.on('reset', this.reset, this);
	},

	reset: function () {
		var $box = this.$('#messages');
		$box.empty();
		for (var i = 0; i < this.model.length; i++) {
			var view = new ChatMessageView({model: this.model.at(i)});
			$box.append(view.render().el);
		}
		$box.scrollTop($box[0].scrollHeight);
	},

	addMessage: function (message) {
		var view = new ChatMessageView({model: message});
		var $box = this.$('#messages');
		var $msg = view.render().$el;
		$msg.hide().fadeIn('fast').appendTo($box);
		this.trim();
		$box.scrollTop($box[0].scrollHeight);
	},

	trim: function () {
		var over = this.model.length - CHAT_HISTORY;
		if (over > 0)
			this.model.remove(this.model.first(over));
	},

	sendChat: function (event) {
		event.preventDefault();
		var $input = this.$('form input');
		var text = $input.val().trim();
		if (!text)
			return;
		send('chat', {text: text});
		$input.val('').focus();
	},
});

window.account = new Account;
window.chat = new Chat;
window.hand = new Cards;
window.game = new Game;

$(function () {
	var $game = $('#game');
	new AccountView({model: account}).render().$el.insertBefore($game);
	new ChatView({model: chat}).render().$el.insertAfter($game);
	var gameView = new GameView({model: game, el: $game[0]});
});

function send(type, msg) {
	msg.a = type;
	msg = JSON.stringify(msg);
	sock.send(msg);
}

window.sock = new SockJS(SOCKJS_URL);
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
	set: function () {
		var target = 'game';
		if (this.t) {
			target = this.t;
			delete this.t;
		}
		window[target].set(this);
	},

	add: function () {
		window[this.t].add(this.objs || this.obj);
	},

	reset: function () {
		window[this.t].reset(this.objs);
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

})();

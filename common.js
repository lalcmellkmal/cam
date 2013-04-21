(function () {

if (typeof exports == 'undefined')
    exports = window;
else
    _ = require('underscore');

_.extend(exports, {
    USERNAME_LENGTH: 15,
    MESSAGE_LENGTH: 120,
    CHAT_HISTORY: 80,
});

exports.parseBlack = function (black) {
    var info = {card: black};
    info.text = black.replace(/_/g, '__________');
    var tokens = black.split(/(_)/g);
    info.blankCount = (tokens.length-1)/2 || 1;
    for (var i = 1; i < tokens.length; i += 2) {
        var blank = {};
        var before = tokens[i-1], after = tokens[i+1];
        if (/\b(?:the|a|an|my|your|yo'|our|his|her|their|more|this)\s+$/i.test(before))
            blank.omitArticle = true;
        if (/\bbeing\s+$/i.test(before))
            blank.omitBeing = true;
        if (after)
            blank.omitPeriod = true;
        if (/^ing/i.test(after))
            blank.omitIng = true;
        tokens[i] = blank;
    }
    info.tokens = tokens;

    var skipQuestion = false;
    if (tokens.length == 1)
        skipQuestion = true;

    info.skipQuestion = skipQuestion;
    return info;
};

var ABBREV = 60;

exports.applySubmission = function (black, sub, abbrev) {
    var bits = [];
    var first = cleanUp(black.tokens[0]);
    if (!abbrev)
        bits.push(first + (black.skipQuestion ? ' ' : ''));
    else if (!black.skipQuestion)
        bits.push(first.length > ABBREV ? '[...] ' : first);

    var whites = sub.cards;
    for (var i = 0; i < whites.length; i++) {
        var white = whites[i];
        var blank = black.tokens[i*2 + 1] || {};
        if (blank.omitBeing) {
            var beingSkip = white.match(/^being\s+(.+)$/i);
            if (beingSkip)
                white = beingSkip[1];
        }
        if (blank.omitArticle) {
            var articleSkip = white.match(/^(?:the|a|an|my|your)\s+(.+)$/i);
            if (articleSkip)
                white = articleSkip[1];
        }
        if (blank.omitPeriod)
            white = white.replace(/[.]$/, '');
        if (blank.omitIng)
            white = white.replace(/ing$/, '');

        bits.push({white: white});

        var next = black.tokens[i*2 + 2];
        if (next)
            bits.push((abbrev && next.length > ABBREV) ? ' [...] ' : cleanUp(next));
    }

    return bits;
};

function cleanUp(text) {
    return text.replace(/\[-\]/g, '');
}

exports.randomId = function () {
        return '' + (Math.floor(Math.random() * 1e16) + 1);
};

})();

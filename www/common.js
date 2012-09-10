(function () {

if (typeof exports == 'undefined')
    exports = window;

exports.parseBlack = function (black) {
    var info = {card: black};
    info.text = black.replace(/_/g, '__________');
    var bits = black.split(/_/g);
    info.blankCount = (bits.length-1) || 1;
    return info;
};

})();

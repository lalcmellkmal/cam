function parseBlack(black) {
    var bits = black.split(/_/g);
    var info = {text: black.replace(/_/g, '__________')};
    info.blankCount = (bits.length-1) || 1;
    return info;
}

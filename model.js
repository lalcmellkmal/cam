var events = require('events'),
    util = require('util');

function Model() {
    events.EventEmitter.call(this);
    this._changed = {};
    this._changeTimeout = 0;
}
util.inherits(Model, events.EventEmitter);
exports.Model = Model;

var M = Model.prototype;
M.set = function (hash) {
    for (var k in hash) {
        if (this[k] !== hash[k]) {
            this[k] = hash[k];
            this.setChanged(k);
        }
    }
};

M.setChanged = function (key) {
    this._changed[key] = true;
    if (!this._changeTimeout)
        this._changeTimeout = setTimeout(this._deferredChange.bind(this), 0);
};

M._deferredChange = function () {
    this._changeTimeout = 0;
    this.change();
};

M.change = function () {
    if (this._changeTimeout) {
        clearTimeout(this._changeTimeout);
        this._changeTimeout = 0;
    }
    for (var k in this._changed) {
        if (this._changed[k])
            this.emit('change:' + k);
    }
    this._changed = {};
};

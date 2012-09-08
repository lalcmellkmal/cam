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
        this[k] = hash[k];
        this.setChanged(k);
    }
};

M.setChanged = function (key) {
    this._changed[key] = true;
    if (!this._changeTimeout) {
        var self = this;
        this._changeTimeout = setTimeout(function () {
            self._changeTimeout = 0;
            self.change();
        }, 0);
    }
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

var events = require('events'),
    util = require('util');

function Model() {
    events.EventEmitter.call(this);
    this._changed = {};
    this._changeTimeout = 0;
    this._defers = {};
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
    this.defer('change');
};

M.change = function () {
    for (var k in this._changed) {
        if (this._changed[k])
            this.emit('change:' + k);
    }
    this.emit('change');
    this._changed = {};
};

M.defer = function (name) {
    if (!this._defers[name])
        this._defers[name] = setTimeout(this.flush.bind(this, name), 0);
};

M.deferral = function (name) {
    return this.defer.bind(this, name);
};

M.flush = function (name) {
    if (this._defers[name]) {
        this._defers[name] = 0;
        this[name].call(this);
    }
};

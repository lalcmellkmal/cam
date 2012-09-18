var events = require('events'),
    util = require('util');

function Model() {
    events.EventEmitter.call(this);
    this._changed = {};
    this._changeTimeout = 0;
    this._previousAttributes = {};
    this._defers = {};
}
util.inherits(Model, events.EventEmitter);
exports.Model = Model;

var M = Model.prototype;
M.set = function (hash) {
    for (var k in hash) {
        if (this[k] !== hash[k]) {
            if (!(k in this._previousAttributes))
                this._previousAttributes[k] = this[k];
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
    var overallInfo = {previous: {}};
    for (var k in this._changed) {
        if (this._changed[k]) {
            var info = {};
            if (k in this._previousAttributes)
                overallInfo.previous[k] = info.previous = this._previousAttributes[k];
            this.emit('change:' + k, this[k], this, info);
        }
    }
    this.emit('change', this, overallInfo);
    this._changed = {};
    this._previousAttributes = {};
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

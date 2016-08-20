"use strict";

const autoClearDefaultOptions = {
    ttl: 1000 * 60 * 60 * 24 /* 24h */,
    interval: 1000 /* 1s */,
};

class Session {
    constructor(options = {}) {
        if (options.autoClear) {
            let { ttl, interval } = options.autoClear;
            if (!ttl || !interval) {
                throw new TypeError("option's autoClear must be set `ttl` and `interval` property");
            }
            this.autoClear(options.autoClear);
        }
        if (typeof options.onBeforeDestroy === "function") {
            this._onBeforeDestroy = options.onBeforeDestroy;
        }
        Object.defineProperty(this, "_super", {
            writable: false,
            value: new Map(),
            configurable: true,
            enumerable: false,
        });
    }
    [Symbol.iterator](...args) {
        return Reflect.apply(this._super[Symbol.iterator], this._super, args);
    }
    _convertToId(id, { port, address, family }) {
        if (family) {
            let str = String(family).toLowerCase();
            if (str.toLowerCase() === "ipv6" || str === "6") {
                family = 6;
            } else {
                family = 4;
            }
        } else {
            family = 4;
        }
        if (!address) {
            if (family === 4) {
                address = "127.0.0.1";
            } else if (family === 6) {
                address = "::1";
            }
        }
        return [port, address, family, id].join(",");
    }
    autoClear({ ttl, interval } = autoClearDefaultOptions) {
        this.stopClear();
        this._intervalId = setInterval(() => {
            const now = Date.now();
            for (const [key, value] of this) {
                if (now - value.__lastVisit__ > ttl) {
                    this._super.delete(key);
                }
            }
        }, interval);
    }
    stopClear() {
        if (this._intervalId) {
            clearInterval(this._intervalId);
            delete this._intervalId;
        }
    }
    _tryDelete(key) {
        if (this._onBeforeDestroy && this._super.has(key)) {
            this._onBeforeDestroy(key, this._super.get(key));
        }
        this._super.delete(key);
    }
}

class SendingSession extends Session {
    has(id, rinfo) {
        const key = this._convertToId(id, rinfo);
        return this._super.has(key);
    }
    get(id, rinfo) {
        const key = this._convertToId(id, rinfo);
        const value = this._super.get(key);
        if (value) {
            value.__lastVisit__ = Date.now();
        }
        return value;
    }
    set(id, rinfo, value) {
        const key = this._convertToId(id, rinfo);
        if (!value || typeof value !== "object") {
            throw new TypeError("value must be an object!");
        }
        this._tryDelete(key);
        value.__lastVisit__ = Date.now();
        return this._super.set(key, value);
    }
    delete(id, rinfo) {
        const key = this._convertToId(id, rinfo);
        return this._tryDelete(key);
    }
    getIdBy(rinfo) {
        if (!this._ids) {
            this._ids = new Map();
        }
        const key = this._convertToId("", rinfo);
        const prevId = this._ids.has(key) ? this._ids.get(key) : -1;
        let id = prevId + 1;
        if (id >= this._maxCounter) {
            id = 0;
        }
        this._ids.set(key, id);
        return id;
    }
    clear() {
        if (this._onBeforeDestroy) {
            for (const [key, val] of this) {
                this._onBeforeDestroy(key, val);
            }
        }
        this._super.clear();
        delete this._ids;
    }
}

class ReceivingSession extends Session {
    has(id, rinfo) {
        const key = this._convertToId(id, rinfo);
        return this._super.has(key);
    }
    get(id, rinfo) {
        const key = this._convertToId(id, rinfo);
        let value = this._super.get(key);
        if (!value || (value._used && Date.now() - value.__lastVisit__ > 30 * 1000 * 60)) {
            this._tryDelete(key);
            value = [];
            this.set(id, rinfo, value);
        }
        value.__lastVisit__ = Date.now();
        return value;
    }
    set(id, rinfo, value) {
        const key = this._convertToId(id, rinfo);
        if (!value || typeof value !== "object") {
            throw new TypeError("value must be an object!");
        }
        this._tryDelete(key);
        value.__lastVisit__ = Date.now();
        return this._super.set(key, value);
    }
    delete(id, rinfo) {
        const key = this._convertToId(id, rinfo);
        return this._tryDelete(key);
    }
    clear() {
        if (this._onBeforeDestroy) {
            for (const [key, val] of this) {
                this._onBeforeDestroy(key, val);
            }
        }
        return this._super.clear();
    }
}

exports.SendingSession = SendingSession;
exports.ReceivingSession = ReceivingSession;

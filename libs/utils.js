"use strict";

const util = require("util");

const asc = (a, b) => Math.sign(a - b);
//const dsc = (a, b) => Math.sign(b - a);
const unique = ary => [...new Set(ary).values()];

const utils = module.exports = {};
utils.checksum = require("./checksum.js");

/**
 * compress continuous sequence number
 * @param {number[]} ary
 * @param {number[]}
 */
utils.zipSequences = function zipSequences(ary) {
    if (!Array.isArray(ary)) {
        throw new TypeError("argument 0 must be an array");
    }
    const sortedAry = unique(ary).sort(asc);
    const FLAGS = 0x8000;
    const zippedAry = [];
    let start, prev;
    for (let i = 0, len = sortedAry.length; i < len; i++) {
        let curr = sortedAry[i];
        if (curr >= FLAGS || curr < 0) {
            throw new Error(`value(${curr}) must be greater than or equal to 0 and less than ${FLAGS}`);
        }
        if (prev !== undefined) {
            if (curr === prev) {
                // ignore
                continue;
            } else if (curr - prev === 1) {
                if (start === undefined) {
                    start = prev;
                }
            } else {
                if (start !== undefined) {
                    zippedAry.push(start | FLAGS, prev | FLAGS);
                    start = undefined;
                } else {
                    zippedAry.push(prev);
                }
            }
        }
        prev = curr;
    }
    if (prev !== undefined) {
        if (start !== undefined) {
            zippedAry.push(start | FLAGS, prev | FLAGS);
        } else {
            zippedAry.push(prev);
        }
    }
    return zippedAry;
};

/**
 * decompress continuous sequence number
 * @param {number[]} ary
 * @return {number[]}
 */
utils.unzipSequences = function unzipSequences(ary) {
    if (!Array.isArray(ary)) {
        throw new TypeError("argument 0 must be an array");
    }
    const sortedAry = unique(ary).sort(asc);
    const MAX_INT16 = 0x7FFF;
    const unzippedAry = [];
    for (let i = 0, len = sortedAry.length; i < len; i++) {
        let curr = sortedAry[i];
        if (curr > MAX_INT16) {
            let start = curr & MAX_INT16;
            i += 1;
            let next = sortedAry[i];

            if (next > MAX_INT16) {
                let end = next & MAX_INT16;
                for (let j = start; j <= end; j++) {
                    unzippedAry.push(j);
                }
            } else {
                unzippedAry.push(start);
                i -= 1;
            }
        } else {
            unzippedAry.push(curr);
        }
    }
    return unique(unzippedAry);
};


/**
 * use the first word from the buffer to xor the buffer
 * @param {Buffer} buffer
 * @return {Buffer}
 */
utils.xor = function xor(buffer) {
    if (!Buffer.isBuffer(buffer)) {
        throw new TypeError("argument 0 must be a Buffer");
    }
    const newBuffer = Buffer.from(buffer); // copied, not shared
    const len = newBuffer.length;
    const UNIT = 4;
    if (len <= UNIT) {
        return newBuffer;
    }
    const remaining = len % UNIT;
    const count = Math.floor(len / UNIT);
    const pw = newBuffer.readInt32BE(0);
    for (let i = 1; i < count; i++) {
        const cursor = i * UNIT;
        const val = newBuffer.readInt32BE(cursor);
        newBuffer.writeInt32BE(val ^ pw, cursor);
    }
    if (remaining) {
        for (let i = count * 4; i < len; i++) {
            const val = newBuffer.readUInt8(i);
            newBuffer.writeUInt8(val ^ (pw >>> 24) & 0xFF, i);
        }
    }
    return newBuffer;
};


/**
 * like util.debuglog
 * @param {string} set
 * @return {Function}
 */
utils.debuglog = function debuglog(set) {
    set = String(set).toUpperCase();
    const noop = Function();
    const NODE_DEBUG = process.env.NODE_DEBUG;
    const pid = process.pid;
    const logger = (...args) => console.error(
        "%s %d: %s",
        set, pid, util.format(...args)
    );
    let log;
    if (new RegExp(String.raw`\b${set}\b`, "i").test(NODE_DEBUG)) {
        log = logger;
    } else {
        log = noop;
    }

    process.on("SIGUSR2", function () {
        if (log === logger) {
            console.error("@SIGUSR2:: debug closed!");
            log = noop;
        } else {
            console.error("@SIGUSR2:: start debug!");
            log = logger;
        }
    });

    return (...args) => log(
        new Date().toISOString().replace(/^[^T]+T([^Z]+)Z$/i, "$1"), ...args
    );
};

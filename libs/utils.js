"use strict";

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
                throw new RangeError(`malformed range: [${curr}, ${next}]`);
            }
        } else {
            unzippedAry.push(curr);
        }
    }
    return unique(unzippedAry);
};

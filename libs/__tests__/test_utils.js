"use strict";

/* eslint-env mocha */

const expect = require("chai").expect;

const utils = require("../utils.js");

describe("test zipSequences function", function () {
    it("returns compressed sequence array", function () {
        const test1 = [0x10, 0x20, 0x30, 0x31, 0x32, 0x33];
        const expected1 = [0x10, 0x20, 0x8030, 0x8033];
        expect(utils.zipSequences(test1)).to.be.eql(expected1);

        const test2 = [0x10, 0x11];
        const expected2 = [0x8010, 0x8011];
        expect(utils.zipSequences(test2)).to.be.eql(expected2);

        const test3 = [0x10, 0x11, 0x13, 0x14, 0x15, 0x16];
        const expected3 = [0x8010, 0x8011, 0x8013, 0x8016];
        expect(utils.zipSequences(test3)).to.be.eql(expected3);

        expect(utils.zipSequences([])).to.be.eql([]);
    });
    it("throws error when argument 0 was not an array", function () {
        const test = {};
        expect(function () {
            utils.zipSequences(test);
        }).to.be.throw(Error);
    });
    it("throws error when array contains invalid integer", function () {
        expect(function () {
            utils.zipSequences([0x8000]);
        }).to.be.throw(Error);
        expect(function () {
            utils.zipSequences([0xf000]);
        }).to.be.throw(Error);
    });
    it("returns sorted and compressed array", function () {
        const test1 = [0x30, 0x21, 0x31, 0x32, 0x22, 0x20];
        const expected1 = [0x8020, 0x8022, 0x8030, 0x8032];
        expect(utils.zipSequences(test1)).to.be.eql(expected1);
    });

    it("returns deduplicated and compressed array", function () {
        const test1 = [0x30, 0x40, 0x30, 0x22, 0x41, 0x42, 0x41];
        const expected1 = [0x22, 0x30, 0x8040, 0x8042];
        expect(utils.zipSequences(test1)).to.be.eql(expected1);
    });
});

describe("test unzippedAry function", function () {
    it("returns decompressed sequence array", function () {
        const test1 = [0x10, 0x20, 0x8030, 0x8033];
        const expected1 = [0x10, 0x20, 0x30, 0x31, 0x32, 0x33];
        expect(utils.unzipSequences(test1)).to.be.eql(expected1);

        const test2 = [0x8010, 0x8011];
        const expected2 = [0x10, 0x11];
        expect(utils.unzipSequences(test2)).to.be.eql(expected2);

        const test3 = [0x8010, 0x8011, 0x8013, 0x8016];
        const expected3 = [0x10, 0x11, 0x13, 0x14, 0x15, 0x16];
        expect(utils.unzipSequences(test3)).to.be.eql(expected3);

        const test4 = [0x8000, 0x8000];
        const expected4 = [0x00];
        expect(utils.unzipSequences(test4)).to.be.eql(expected4);

        expect(utils.unzipSequences([])).to.be.eql([]);
    });
    it("throws error when argument 0 was not an array", function () {
        const test = {};
        expect(function () {
            utils.unzipSequences(test);
        }).to.be.throw(Error);
    });
    it("strips single range integer", function () {
        expect(utils.unzipSequences([0x8000])).to.be.eql([0x00]);
        expect(utils.unzipSequences([0x01, 0x8010])).to.be.eql([0x01, 0x10]);
    });
    it("returns sorted and compressed array", function () {
        const test1 = [0x8020, 0x8030, 0x8022, 0x8032];
        const expected1 = [0x30, 0x21, 0x31, 0x32, 0x22, 0x20].sort();
        expect(utils.unzipSequences(test1)).to.be.eql(expected1);
    });

    it("returns deduplicated and compressed array", function () {
        const test1 = [0x22, 0x30, 0x8040, 0x8042, 0x30, 0x8042, 0x20];
        const expected1 = [0x20, 0x40, 0x30, 0x22, 0x42, 0x41].sort();
        expect(utils.unzipSequences(test1)).to.be.eql(expected1);
    });
});


describe("test xor function", function () {
    function generateRandomBuffer(len) {
        const buffer = Buffer.alloc(len);
        for (let i = 0; i < len; i++) {
            buffer.writeUInt8(Math.floor(Math.random() * 256), i);
        }
        return buffer;
    }
    it("returns same buffer when xor the buffer twice", function () {
        const count = 100;
        const range = [0, 1000];
        for (let i = 0; i < count; i++) {
            let len = Math.floor(Math.random() * (range[1] - range[0])) + range[0];
            let buffer = generateRandomBuffer(len);
            let newBuffer = utils.xor(utils.xor(buffer));
            expect(newBuffer).to.be.not.equal(buffer);
            expect(buffer.equals(newBuffer)).to.be.true;
        }
    });
    it("throws TypeError when argument 0 was not a buffer", function () {
        expect(function () {
            utils.xor([]);
        }).to.be.throw(TypeError);

        expect(function () {
            utils.xor("");
        }).to.be.throw(TypeError);

        expect(function () {
            utils.xor({});
        }).to.be.throw(TypeError);
    });
});


describe("test bisect function", function () {
    it("returns an index of array", function () {
        expect(utils.bisect([], 1)).to.be.equal(0);

        expect(utils.bisect([0], 0)).to.be.equal(0);
        expect(utils.bisect([0], 1)).to.be.equal(1);
        expect(utils.bisect([0], 2)).to.be.equal(1);

        expect(utils.bisect([0, 2], 1)).to.be.equal(1);
        expect(utils.bisect([0, 2], 2)).to.be.equal(1);
        expect(utils.bisect([0, 2], 4)).to.be.equal(2);

        expect(utils.bisect([0, 2, 6], 4)).to.be.equal(2);
        expect(utils.bisect([0, 2, 6], 8)).to.be.equal(3);
    });
});

describe("test insert function", function () {
    it("returns an array that inserted a value", function () {
        expect(utils.insert([], 1)).to.be.eql([1]);

        expect(utils.insert([0], 0)).to.be.eql([0]);
        expect(utils.insert([0], 1)).to.be.eql([0, 1]);
        expect(utils.insert([0], 2)).to.be.eql([0, 2]);

        expect(utils.insert([0, 2], 1)).to.be.eql([0, 1, 2]);
        expect(utils.insert([0, 2], 2)).to.be.eql([0, 2]);
        expect(utils.insert([0, 2], 4)).to.be.eql([0, 2, 4]);

        expect(utils.insert([0, 2, 6], 4)).to.be.eql([0, 2, 4, 6]);
        expect(utils.insert([0, 2, 6], 8)).to.be.eql([0, 2, 6, 8]);
    });
});

describe("test deleteBy function", function () {
    it("returns a boolean that indicate a value delete success from an array", function () {
        expect(utils.deleteBy([], 0)).to.be.false;
        expect(utils.deleteBy([1], 0)).to.be.false;
        expect(utils.deleteBy([1], 1)).to.be.true;
        expect(utils.deleteBy([1, 2, 3], 1)).to.be.true;
        expect(utils.deleteBy([1, 2, 3], 2)).to.be.true;
        expect(utils.deleteBy([1, 2, 3], 3)).to.be.true;
    });
});

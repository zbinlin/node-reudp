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

        expect(utils.unzipSequences([])).to.be.eql([]);
    });
    it("throws error when argument 0 was not an array", function () {
        const test = {};
        expect(function () {
            utils.unzipSequences(test);
        }).to.be.throw(Error);
    });
    it("throws error when array contains single range integer", function () {
        expect(function () {
            utils.unzipSequences([0x8000]);
        }).to.be.throw(Error);
        expect(function () {
            utils.unzipSequences([0xf000]);
        }).to.be.throw(Error);
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

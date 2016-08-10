"use strict";

/* eslint-env mocha */

const expect = require("chai").expect;

const checksum = require("../checksum.js");

describe("test checksum", function () {
    function check(buffer) {
        return checksum.verify(checksum.generate(buffer));
    }
    it("should verify success generated checksum", function () {
        expect(
            check(Buffer.from([]))
        ).to.be.true;

        expect(
            check(Buffer.from([0x10]))
        ).to.be.true;

        expect(
            check(Buffer.from([0x10, 0x20]))
        ).to.be.true;

        expect(
            check(Buffer.from([0xff, 0xff, 0x00]))
        ).to.be.true;
    });
});

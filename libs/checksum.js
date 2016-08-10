"use strict";

function sum(buffer) {
    let checksum = 0x0000;
    let parity = buffer.length % 2;
    for (let i = 0, len = buffer.length - parity; i < len; i += 2) {
        checksum += buffer.readUInt16BE(i);
    }
    if (parity) {
        checksum += buffer.readUInt8(buffer.length - 1) << 8 | 0x00;
    }
    while (checksum > 0xFFFF) {
        let sum = checksum;
        checksum = 0x0000;
        do {
            checksum += sum & 0xFFFF;
            sum = sum >>> 16;
        } while (sum > 0xFFFF);
    }
    return checksum;
}

/**
 * 验证一个包含校验和的 buffer
 * @param {Buffer} buffer
 * @return {boolean}
 */
exports.verify = function verify(buffer) {
    return sum(buffer) === 0xFFFF;
};

/**
 * 根据 buffer 生成校验和，并将其放在前面
 * @param {Buffer} buffer
 * @return {Buffer} - buffer with checksum
 */
exports.generate = function generate(buffer) {
    const checksum = ~sum(buffer) & 0xFFFF;
    const ary = [Buffer.from([checksum >>> 8, checksum & 0xFF]), buffer];
    return Buffer.concat(ary, 2 + buffer.length);
};

"use strict";

const dgram = require("dgram");
const EventEmitter = require("events");
const utils = require("./libs/utils.js");

const { SendingSession, ReceivingSession } = require("./libs/sessions.js");

console.log = function () {};

const MAX_COUNTER = Math.pow(2, 32);
const MAX_PACKAGE_SIZE = 500;
const MAX_BUFFER_SIZE = Math.pow(2, 15) * MAX_PACKAGE_SIZE;
const PARALLEL_COUNT = 16;
const LATENCY = 150; /* ms */

const UDP_PSH = Symbol("reudp-push-data");
const UDP_REQ = Symbol("reudp-request-data");
const UDP_FIN = Symbol("reudp-request-finish");
const UDP_ACK = Symbol("redup-ack");
const UDP_ERR = Symbol("redup-error");
const UDP_PSH_CODE = 0x01;
const UDP_REQ_CODE = 0x02;
const UDP_FIN_CODE = 0x03;
const UDP_ACK_CODE = 0x04;
const UDP_ERR_CODE = 0x05;
const UDP_TYPE_CODES = new Map([
    [UDP_PSH, UDP_PSH_CODE],
    [UDP_REQ, UDP_REQ_CODE],
    [UDP_FIN, UDP_FIN_CODE],
    [UDP_ACK, UDP_ACK_CODE],
    [UDP_ERR, UDP_ERR_CODE],
]);
const UDP_CODE_TYPES = new Map([
    [UDP_PSH_CODE, UDP_PSH],
    [UDP_REQ_CODE, UDP_REQ],
    [UDP_FIN_CODE, UDP_FIN],
    [UDP_ACK_CODE, UDP_ACK],
    [UDP_ERR_CODE, UDP_ERR],
]);
const ERR_NOT_FOUND_ID = 0x00;
const RETRY_NOTIFIY_FIN_COUNT = 10;
const RETRY_REQUEST_COUNT = 10;
let i = 0;
let j = 0;

class ReUDP extends EventEmitter {
    constructor(options = {}) {
        super();
        this._parallelCount = options.parallelCount || PARALLEL_COUNT;
        if (options.remotePort) {
            this._remoteAddress = {
                port: options.remotePort,
                address: options.remoteAddress,
                family: "IPv4",
            };
        }

        const socket = this._getSocketBy(options);
        socket.on("message", (msg, rinfo) => {
            this._receive(msg, rinfo);
        });
        this._socket = socket;
        if (options.port) {
            this.bind(options);
        }

        this._events = {
            [UDP_PSH]: "reudp.psh",
            [UDP_REQ]: "reudp.req",
            [UDP_FIN]: "reudp.fin",
            [UDP_ACK]: "reudp.ack",
            [UDP_ERR]: "redup.err",
        };

        this._handlePshPackage = this._handlePshPackage.bind(this);
        this._handleReqPackage = this._handleReqPackage.bind(this);
        this._handleFinPackage = this._handleFinPackage.bind(this);
        this._handleAckPackage = this._handleAckPackage.bind(this);
        this._handleErrPackage = this._handleErrPackage.bind(this);

        this.addListener(this._events[UDP_PSH], this._handlePshPackage);
        this.addListener(this._events[UDP_REQ], this._handleReqPackage);
        this.addListener(this._events[UDP_FIN], this._handleFinPackage);
        this.addListener(this._events[UDP_ACK], this._handleAckPackage);
        this.addListener(this._events[UDP_ERR], this._handleErrPackage);

        this._finishNotifyQueue = new Set();
        this._sendingSession = new SendingSession({
            maxCounter: MAX_COUNTER,
            autoClear: {
                ttl: 1000 * 60 * 60 /* 1h */,
                interval: 1000 /* 1s */,
            },
            onBeforeDestroy(key, val) {
                if (val._delayTimerId) {
                    clearTimeout(val._delayTimerId);
                }
            },
        });
        this._receivingSession = new ReceivingSession({
            autoClear: {
                ttl: 1000 * 60 * 60 /* 1h */,
                interval: 1000 /* 1s */,
            },
            onBeforeDestroy(key, val) {
                if (val._delayTimerId) {
                    clearTimeout(val._delayTimerId);
                }
            },
        });

        this._fnqId = setInterval(() => {
            for (const item of this._finishNotifyQueue) {
                if (item[4] !== undefined && item[4] > RETRY_NOTIFIY_FIN_COUNT) {
                    this._finishNotifyQueue.delete(item);
                } else {
                    if (item[4] === undefined) {
                        item[4] = 0;
                    } else {
                        item[4] += 1;
                    }
                    this._sendFinPackage(item[0], {
                        port: item[1],
                        address: item[2],
                        family: item[3],
                    });
                }
            }
        }, 1000);
    }
    _getSocketBy(options) {
        if (options.socket) {
            return options.socket;
        }
        return dgram.createSocket(Object.assign({
            type: "udp4",
        }, options));
    }
    bind(...args) {
        return this._socket.bind(...args);
    }

    _checkBuffersFull(buffers, total) {
        if (buffers.length !== total) return false;
        for (let i = 0; i < total; i++) {
            if (!Buffer.isBuffer(buffers[i])) return false;
        }
        return true;
    }

    _getHolesFrom(buffers, singleTotal, total) {
        const ary = [];
        let i = buffers._lastIndex || 0;
        while (i < total && ary.length < singleTotal) {
            if (!Buffer.isBuffer(buffers[i])) {
                ary.push(i);
            }
            i += 1;
        }
        buffers._lastIndex = ary.length > 0 ? ary[0] : total;
        return ary;
    }

    _finish(id, buffers, rinfo) {
        const { port, address, family } = rinfo;
        const buffer = Buffer.concat(buffers);
        buffers._used = true;
        buffers._usedTime = Date.now();
        buffers.length = 0;

        this._sendFinPackage(id, rinfo);
        this._finishNotifyQueue.add([id, port, address, family]);

        this.emit("message", buffer, rinfo, id);
    }

    _notifyReqTimeout(id, rinfo) {
        this._receivingSession.delete(id, rinfo);
    }

    _request(buffers, { id, singleTotal, total }, rinfo) {
        const holes = this._getHolesFrom(buffers, singleTotal, total);
        console.log(`@_request():: id:${id}, singleTotal:${singleTotal}, total:${total}, holes:${holes}`);
        this._sendReqPackage(id, holes, rinfo);
    }

    _delayResponsePshPackage(buffers, info, rinfo) {
        if (buffers._delayTimerId) clearTimeout(buffers._delayTimerId);
        buffers._delayTimerId = setTimeout(() => {
            this._responsePshPackage(buffers, info, rinfo);
            buffers._retryCount += 1;
        }, LATENCY);
    }

    _responsePshPackage(buffers, info, rinfo) {
        const { id, total } = info;
        console.log(`@_responsePshPackage():: id:${id}`);
        if (this._checkBuffersFull(buffers, total)) {
            this._finish(id, buffers, rinfo);
        } else if (buffers._retryCount > RETRY_REQUEST_COUNT) {
            this._notifyReqTimeout(id, rinfo);
        } else {
            this._request(buffers, info, rinfo);
            this._delayResponsePshPackage(buffers, info, rinfo);
        }
    }

    _handlePshPackage({ id, seq, singleTotal, total, data }, rinfo) {
        console.log(`@_handlePshPackage():: id:${id}, seq:${seq}, singleTotal: ${singleTotal}, total:${total}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
        const buffers = this._receivingSession.get(id, rinfo);
        // drop the package
        if (!buffers) {
            console.error(`@_handlePshPackage:: Error: can not get receiving session from id:${id}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
            return;
        }

        buffers._retryCount = 0;

        // duplicate package
        if (Buffer.isBuffer(buffers[seq])) {
            ++i;
            console.error(`duplicate: ${i / total * 100}%, ${seq}`);
            //console.error(`received duplicate seq id:${id}, seq:${seq}, singleTotal:${singleTotal}, total:${total}`);
            return;
        }

        ++j;
        console.error(`progress: ${j / total * 100}%, seq: ${seq}`);
        buffers[seq] = data;

        this._delayResponsePshPackage(buffers, { id, singleTotal, total }, rinfo);
    }

    _handleReqPackage({ id, sequences }, rinfo) {
        console.log(`@_handleReqPackage():: id:${id}, sequences:${sequences}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
        const session = this._sendingSession.get(id, rinfo);
        if (!session) {
            this._sendErrPackage(id, ERR_NOT_FOUND_ID, rinfo);
            return;
        }
        const packagesGenerator = session;
        process.nextTick(() => {
            this._trySend(id, rinfo, packagesGenerator, sequences);
        });
    }

    _handleFinPackage({ id }, rinfo) {
        console.log(`@_handleFinPackage():: id:${id}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
        const session = this._sendingSession.get(id, rinfo);
        if (session) {
            const packagesGenerator = session;
            packagesGenerator.return();
            this.emit("drain", id, rinfo);
            this._sendingSession.delete(id, rinfo);
        }
        this._sendAckPackage(id, UDP_FIN, rinfo);
    }

    _handleAckPackage({ id, ackType }, rinfo) {
        console.log(`@_handleAckPackage():: id:${id}, ackType:${ackType.toString()}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
        switch (ackType) {
            case UDP_FIN:
                {
                    for (const item of this._finishNotifyQueue) {
                        if (item[0] === id &&
                            item[1] === rinfo.port &&
                            item[2] === rinfo.address &&
                            item[3] === rinfo.family) {
                            this._finishNotifyQueue.delete(item);
                            break;
                        }
                    }
                }
                break;
        }
    }

    _handleErrPackage({ id, errType }, rinfo) {
        console.log(`@_handleAckPackage():: id:${id}, errType:${errType.toString()}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
        switch (errType) {
            case ERR_NOT_FOUND_ID:
                this._receivingSession.delete(id, rinfo);
                break;
        }
    }

    _parseHeader(buffer) {
        let cursor = 0;
        const typeCode = buffer.readUInt8(cursor);
        const type = UDP_CODE_TYPES.get(typeCode);
        cursor += 2;
        const id = buffer.readUInt32BE(cursor);
        return ({ type, id });
    }

    _parsePshPackage(buffer, cursor) {
        const seq = buffer.readUInt16BE(cursor);
        cursor += 2;

        const singleTotal = buffer.readUInt16BE(cursor);
        cursor += 2;

        const total = buffer.readUInt16BE(cursor);
        cursor += 2;

        const data = buffer.slice(cursor);

        return ({ seq, singleTotal, total, data });
    }

    _parseReqPackage(buffer, cursor) {
        const sequences = [];
        for (let i = cursor, len = buffer.length; i < len; i += 2) {
            sequences.push(buffer.readUInt16BE(i));
        }
        console.log(sequences);
        return ({ sequences: utils.unzipSequences(sequences) });
    }

    _parseAckPackage(buffer, cursor) {
        const ackTypeCode = buffer.readUInt8(cursor);
        return ({
            ackType: UDP_CODE_TYPES.get(ackTypeCode),
        });
    }

    _parseErrPackage(buffer, cursor) {
        const errTypeCode = buffer.readUInt16BE(cursor);
        return ({
            errType: errTypeCode,
        });
    }

    _parse(buffer) {
        const header = this._parseHeader(buffer);
        let cursor = 6;
        switch (header.type) {
            case UDP_PSH:
                return Object.assign({},
                    this._parsePshPackage(buffer, cursor),
                    header
                );
            case UDP_REQ:
                return Object.assign({},
                    this._parseReqPackage(buffer, cursor),
                    header
                );
            case UDP_FIN:
                return header;
            case UDP_ACK:
                return Object.assign({},
                    this._parseAckPackage(buffer, cursor),
                    header
                );
            case UDP_ERR:
                return Object.assign({},
                    this._parseErrPackage(buffer, cursor),
                    header
                );
            default:
                console.error(`@_parse():: unknow type:${header.type}`);
                return null;
        }
    }

    _receive(buffer, rinfo) {
        if (!utils.checksum.verify(buffer)) {
            console.log(`checksum failure, ${buffer}`);
        }
        const result = this._parse(buffer.slice(2));
        if (result === null) {
            console.log(`unknow buffer: ${buffer.toString("hex")}`);
            return;
        }
        this.emit(this._events[result.type], result, rinfo);
    }

    _sendReqPackage(id, holes, rinfo) {
        let len = 0;
        const header = this._packHeader(UDP_REQ, id);
        len += header.length;

        const zippedHoles = utils.zipSequences(holes);
        const buf = Buffer.alloc(zippedHoles.length * 2);
        console.log(zippedHoles);
        for (let i = 0, len = zippedHoles.length; i < len; i++) {
            buf.writeUInt16BE(zippedHoles[i], i * 2);
        }
        len += buf.length;

        this._send(Buffer.concat([header, buf], len), rinfo);
    }

    _sendAckPackage(id, type, rinfo) {
        let len = 0;
        const header = this._packHeader(UDP_ACK, id);
        len += header.length;

        const ackTypeBuf = Buffer.alloc(1);
        ackTypeBuf.writeUInt8(UDP_TYPE_CODES.get(type));
        len += ackTypeBuf.length;

        this._send(Buffer.concat([header, ackTypeBuf], len), rinfo);
    }

    _sendFinPackage(id, rinfo) {
        const header = this._packHeader(UDP_FIN, id);
        this._send(header, rinfo);
    }

    _sendErrPackage(id, errType, rinfo) {
        let len = 0;
        const header = this._packHeader(UDP_ERR, id);
        len += header.length;

        const errTypeBuf = Buffer.alloc(2);
        errTypeBuf.writeUInt16BE(errType);
        len += errTypeBuf.length;

        this._send(Buffer.concat([header, errTypeBuf], len), rinfo);
    }

    _send(buffer, rinfo) {
        let port, address;
        if (rinfo) {
            ({port, address} = rinfo);
        } else {
            console.error("can not find address to sends buffer");
        }
        const buf = utils.checksum.generate(buffer);
        this._socket.send(buf, 0, buf.length, port, address);
    }

    _packHeader(type, id) {
        let cursor = 0;
        const header = Buffer.alloc(6);
        header.writeUInt8(UDP_TYPE_CODES.get(type), cursor);
        cursor += 2;
        header.writeUInt32BE(id, cursor);
        return header;
    }

    _packData(id, seq, parallelCount, totalCount, buf) {
        console.log(`@_packData():: id:${id}, seq:${seq}, parallelCount:${parallelCount}, totalCount:${totalCount}`);
        let len = buf.length;

        const header = this._packHeader(UDP_PSH, id);
        len += header.length;

        const seqBuf = Buffer.alloc(2);
        seqBuf.writeUInt16BE(seq);
        len += seqBuf.length;

        const parallelCountBuf = Buffer.alloc(2);
        parallelCountBuf.writeUInt16BE(parallelCount);
        len += parallelCountBuf.length;

        const totalCountBuf = Buffer.alloc(2);
        totalCountBuf.writeUInt16BE(totalCount);
        len += totalCountBuf.length;

        return Buffer.concat([
            header, seqBuf, parallelCountBuf, totalCountBuf, buf,
        ], len);
    }

    *_generatePackagesBy(id, buffer, initSequences) {
        const totalCount = Math.ceil(buffer.length / MAX_PACKAGE_SIZE);
        const parallelCount = Math.min(this._parallelCount, totalCount);
        const length = buffer.length;
        console.log(`@_generatePackagesBy():: id:${id}, parallelCount:${parallelCount}, totalCount:${totalCount}`);

        let req = utils.unzipSequences(
            [0x8000, 0x8000 | (parallelCount - 1)]
        );

        while (req && req.length > 0) {
            let parallels = req.map(seq => {
                const start = seq * MAX_PACKAGE_SIZE;
                const end = Math.min(start + MAX_PACKAGE_SIZE, length);
                const buf = buffer.slice(start, end);
                return this._packData(id, seq, parallelCount, totalCount, buf);
            });
            req = yield parallels;
        }
    }

    _diffRequestSequences(a, b) {
        if (!(b instanceof Set)) {
            b = new Set(b);
        }
        return a.filter(seq => !b.has(seq));
    }

    _trySend(id, rinfo, packagesGenerator, requestSequences) {
        console.log(`@_trySend:: id:${id}, requestSequences:${requestSequences}`);
        if (packagesGenerator._delayTimerId) clearTimeout(packagesGenerator._delayTimerId);
        if (requestSequences) {
            if (packagesGenerator._lastRequestSequences && packagesGenerator._lastRequestSequences.length) {
                requestSequences = this._diffRequestSequences(
                    requestSequences,
                    packagesGenerator._lastRequestSequences
                );
            }
            if (requestSequences.length === 0) {
                delete packagesGenerator._lastRequestSequences;
                return;
            }
        }
        const { done, value: packages } = packagesGenerator.next(requestSequences);
        if (done) {
            return;
        }
        for (const pkg of packages) {
            this._send(pkg, rinfo);
        }
        packagesGenerator._lastRequestSequences = requestSequences;
        packagesGenerator._delayTimerId = setTimeout(() => {
            delete packagesGenerator._lastRequestSequences;
        }, LATENCY);
    }

    _sendPshPackage(buffer, id, rinfo) {
        const packagesGenerator = this._generatePackagesBy(id, buffer);
        this._sendingSession.set(id, rinfo, packagesGenerator);
        process.nextTick(() => {
            this._trySend(id, rinfo, packagesGenerator);
        });
    }

    send(buffer, rinfo) {
        if (!rinfo) {
            if (!this._remoteAddress) {
                throw new Error("remote address must be specify!");
            } else {
                rinfo = this._remoteAddress;
            }
        }
        if (this.closed) {
            throw new Error("socket was closed!");
        }
        if (!Buffer.isBuffer(buffer)) {
            throw new TypeError("argument 0 must be a Buffer");
        }
        if (buffer.length === 0) {
            return null;
        }
        if (buffer.length > MAX_BUFFER_SIZE) {
            throw new RangeError(`buffer must be bwtween 0 and ${MAX_BUFFER_SIZE}`);
        }
        const id = this._sendingSession.getIdBy(rinfo);
        this._sendPshPackage(buffer, id, rinfo);
        return id;
    }

    close() {
        this.closed = true;

        clearInterval(this._fnqId);
        delete this._fnqId;

        this.removeListener(this._events[UDP_PSH], this._handlePshPackage);
        this.removeListener(this._events[UDP_REQ], this._handleReqPackage);
        this.removeListener(this._events[UDP_FIN], this._handleFinPackage);
        this.removeListener(this._events[UDP_ACK], this._handleAckPackage);
        this.removeListener(this._events[UDP_ERR], this._handleErrPackage);

        this._sendingSession.clear();
        this._receivingSession.clear();
        this._sendingSession.stopClear();
        this._receivingSession.stopClear();
        this._finishNotifyQueue.clear();

        this._socket.close();
    }
}

module.exports = ReUDP;

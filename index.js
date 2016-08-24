"use strict";

const net = require("net");
const dgram = require("dgram");
const EventEmitter = require("events");
const utils = require("./libs/utils.js");
const debuglog = utils.debuglog("reudp");

const { SendingSession, ReceivingSession } = require("./libs/sessions.js");

const MAX_COUNTER = Math.pow(2, 32);
const MAX_PACKET_SIZE = 1090 - 14;
const MAX_BUFFER_SIZE = Math.pow(2, 15) * MAX_PACKET_SIZE;
const PARALLEL_COUNT = 92;
const LATENCY = 35; /* ms */

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

/**
 * @typedef {Object} Address
 * @property {number} port
 * @property {string} [address="127.0.0.1"]
 * @property {string} [family="IPv4"]
 */

class ReUDP extends EventEmitter {
    /**
     * @param {Object} [options={}]
     * @property {number} [options.parallelCount]
     * @property {number} [options.remotePort]
     * @property {string} [options.remoteAddress]
     * @property {string} [options.remoteFamily]
     * @property {number} [options.port]
     * @property {string} [options.address]
     * @property {string} [options.family]
     * @property {Socket} [options.socket] - udp socket
     */
    constructor(options = {}) {
        super();
        this._parallelCount = options.parallelCount || PARALLEL_COUNT;
        if (options.remotePort) {
            this._remoteAddress = {
                port: options.remotePort,
                address: options.remoteAddress || "127.0.0.1",
                family: options.remoteFamily ||
                        (net.isIPv6(options.remoteAddress) ? "IPv6" : "IPv4"),
            };
        }

        this._events = {
            [UDP_PSH]: "reudp.psh",
            [UDP_REQ]: "reudp.req",
            [UDP_FIN]: "reudp.fin",
            [UDP_ACK]: "reudp.ack",
            [UDP_ERR]: "redup.err",
        };

        this._receive = this._receive.bind(this);
        this._handlePshPacket = this._handlePshPacket.bind(this);
        this._handleReqPacket = this._handleReqPacket.bind(this);
        this._handleFinPacket = this._handleFinPacket.bind(this);
        this._handleAckPacket = this._handleAckPacket.bind(this);
        this._handleErrPacket = this._handleErrPacket.bind(this);

        this.addListener(this._events[UDP_PSH], this._handlePshPacket);
        this.addListener(this._events[UDP_REQ], this._handleReqPacket);
        this.addListener(this._events[UDP_FIN], this._handleFinPacket);
        this.addListener(this._events[UDP_ACK], this._handleAckPacket);
        this.addListener(this._events[UDP_ERR], this._handleErrPacket);

        const socket = this._getSocketBy(options);
        socket.on("message", this._receive);
        this._socket = socket;
        if (options.port) {
            this.bind(options);
        }

        this._finishNotifyQueue = new Set();
        this._sendingSession = new SendingSession({
            maxCounter: MAX_COUNTER,
            autoClear: {
                ttl: 1000 * 60 * 60 /* 1h */,
                interval: 1000 * 30 /* 30s */,
            },
            onBeforeDestroy(key, val) {
                if (val._delayTimerId) {
                    clearTimeout(val._delayTimerId);
                }
                if (val._intervalId) {
                    clearInterval(val._intervalId);
                    val._clearRetrySendingTimer();
                }
            },
        });
        this._receivingSession = new ReceivingSession({
            autoClear: {
                ttl: 1000 * 60 * 60 /* 1h */,
                interval: 1000 * 30 /* 30s */,
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
                    this._sendFinPacket(item[0], {
                        port: item[1],
                        address: item[2],
                        family: item[3],
                    });
                }
            }
        }, 1000);

        this._drains = new WeakMap();
        this._dataQueues = [];
        const bandWidth = (options.bandWidth || 4) * 1024 * 1024 / 8; /* byte, default 4MiB */
        this._RTT = (options.RTT || 200) + LATENCY; /* ms, default 200ms */
        const parallelSize = MAX_PACKET_SIZE * this._parallelCount;
        this._interval = (1000 * parallelSize) / (bandWidth - parallelSize);
        if (this._interval < 0 || isNaN(this._interval)) {
            this._interval = 1000;
        }
        this._frequency = Math.floor(this._RTT / this._interval) || 1;
        debuglog(`@constructor():: interval:${this._interval}, frequency:${this._frequency}`);
    }

    /**
     * @private
     * @param {Object} [options={}]
     * @property {Socket} [options.socket]
     * @property {string} [options.type="udp4"]
     * @property {bool} [options.reuseAddr]
     * @return {Socket} - udp socket
     */
    _getSocketBy(options = {}) {
        if (options.socket) {
            return options.socket;
        }
        return dgram.createSocket(Object.assign({
            type: "udp4",
        }, options));
    }
    /**
     * @public
     * @external https://nodejs.org/api/dgram.html#dgram_socket_bind_port_address_callback
     * @external https://nodejs.org/api/dgram.html#dgram_socket_bind_options_callback
     */
    bind(...args) {
        return this._socket.bind(...args);
    }

    /**
     * @private
     * @param {Buffer[]} buffers
     * @param {number} total
     * @return {bool}
     */
    _checkBuffersFull(buffers, total) {
        if (buffers.length !== total) return false;
        for (let i = 0; i < total; i++) {
            if (!Buffer.isBuffer(buffers[i])) return false;
        }
        return true;
    }

    /**
     * @private
     * @param {Buffer[]} buffers
     * @param {number} singleTotal
     * @param {number} total
     * @return {Buffer[]}
     */
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

    /**
     * @private
     * @param {number} id
     * @param {Buffer[]} buffers
     * @param {Address} rinfo
     */
    _finish(id, buffers, rinfo) {
        const { port, address, family } = rinfo;
        const buffer = Buffer.concat(buffers);
        buffers._used = true;
        buffers._usedTime = Date.now();
        buffers.length = 0;
        debuglog(`duplicate: dest, ${JSON.stringify({
            id,
            rinfo,
            duplicateRate: (buffers.__duplicateCounts__ + buffers.__total__) / buffers.__total__,
        })}`);
        delete buffers.__duplicateCounts__;
        delete buffers.__total__;

        this._sendFinPacket(id, rinfo);
        this._finishNotifyQueue.add([id, port, address, family]);

        process.nextTick(() => {
            this.emit("message", buffer, rinfo, id);
        });
    }

    /**
     * @private
     * @param {number} id
     * @param {Address} rinfo
     */
    _notifyReqTimeout(id, rinfo) {
        this._receivingSession.delete(id, rinfo);
    }

    /**
     * @private
     * @param {Buffer[]} buffers
     * @param {Object} info
     * @property {number} info.id
     * @property {number} info.singleTotal
     * @property {number} info.total
     * @param {Address} rinfo
     */
    _request(buffers, { id, singleTotal, total }, rinfo) {
        const holes = this._getHolesFrom(buffers, singleTotal, total);
        debuglog(`@_request():: id:${id}, singleTotal:${singleTotal}, total:${total}, holes:${holes}`);
        this._sendReqPacket(id, holes, rinfo);
    }

    /**
     * @private
     * @param {Buffer[]} buffers
     * @param {Object} info
     * @param {Address} rinfo
     */
    _delayResponsePshPacket(buffers, info, rinfo, delay) {
        if (buffers._delayTimerId) clearTimeout(buffers._delayTimerId);
        buffers._delayTimerId = setTimeout(() => {
            this._responsePshPacket(buffers, info, rinfo);
            buffers._retryCount += 1;
        }, delay);
    }

    /**
     * @private
     * @param {Buffer[]} buffers
     * @param {Object} info
     * @param {Address} rinfo
     */
    _responsePshPacket(buffers, info, rinfo) {
        const { id, total } = info;
        debuglog(`@_responsePshPacket():: id:${id}`);
        if (this._checkBuffersFull(buffers, total)) {
            this._finish(id, buffers, rinfo);
        } else if (buffers._retryCount > RETRY_REQUEST_COUNT) {
            this._notifyReqTimeout(id, rinfo);
        } else {
            this._request(buffers, info, rinfo);
            this._delayResponsePshPacket(buffers, info, rinfo, this._RTT);
        }
    }

    /**
     * @private
     * @param {Object} info
     * @property {number} info.id
     * @property {number} info.seq
     * @property {number} info.singleTotal
     * @property {number} info.total
     * @property {Buffer} info.data
     * @param {Address} rinfo
     */
    _handlePshPacket({ id, seq, singleTotal, total, data }, rinfo) {
        debuglog(`@_handlePshPacket():: id:${id}, seq:${seq}, singleTotal: ${singleTotal}, total:${total}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
        const buffers = this._receivingSession.get(id, rinfo);
        // drop the packet
        if (!buffers) {
            debuglog(`@_handlePshPacket:: Error: can not get receiving session from id:${id}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
            return;
        }

        buffers._retryCount = 0;

        // duplicate packet
        if (Buffer.isBuffer(buffers[seq])) {
            if (!buffers._used) {
                buffers.__duplicateCounts__ = (buffers.__duplicateCounts__ || 0) + 1;
            }
            return;
        }
        buffers.__total__ = total;

        buffers[seq] = data;

        this._delayResponsePshPacket(buffers, { id, singleTotal, total }, rinfo,  LATENCY);
    }

    /**
     * @private
     * @param {Object} info
     * @property {number} info.id
     * @property {number[]} info.sequences
     * @param {Address} rinfo
     */
    _handleReqPacket({ id, sequences }, rinfo) {
        debuglog(`@_handleReqPacket():: id:${id}, sequences:${sequences}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
        const session = this._sendingSession.get(id, rinfo);
        if (!session) {
            this._sendErrPacket(id, ERR_NOT_FOUND_ID, rinfo);
            return;
        }
        const packetsGenerator = session;
        packetsGenerator._clearRetrySendingTimer(true);
        process.nextTick(() => {
            this._trySend(packetsGenerator, sequences);
        });
    }

    /**
     * @private
     * @param {Object} info
     * @property {number} info.id
     * @param {Address} rinfo
     */
    _handleFinPacket({ id }, rinfo) {
        debuglog(`@_handleFinPacket():: id:${id}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
        const session = this._sendingSession.get(id, rinfo);
        if (session) {
            const packetsGenerator = session;
            packetsGenerator._clearRetrySendingTimer(true);
            const { value: val } = packetsGenerator.next(null); // exit
            if (val) {
                debuglog("source,", JSON.stringify({
                    id,
                    rinfo,
                    repeatRate: val,
                }));
            }
            const onDrain = this._drains.get(packetsGenerator);
            if (onDrain) {
                process.nextTick(() => {
                    onDrain(id, rinfo);
                });
                this._drains.delete(packetsGenerator);
            }
            this.emit("drain", id, rinfo);
            this._sendingSession.delete(id, rinfo);
        }
        this._sendAckPacket(id, UDP_FIN, rinfo);
    }

    /**
     * @private
     * @param {Object} info
     * @property {number} info.id
     * @property {symbol} info.ackType
     * @param {Address} rinfo
     */
    _handleAckPacket({ id, ackType }, rinfo) {
        debuglog(`@_handleAckPacket():: id:${id}, ackType:${ackType.toString()}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
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

    /**
     * @private
     * @param {Object} info
     * @property {number} info.id
     * @property {symbol} info.errType
     * @param {Address} rinfo
     */
    _handleErrPacket({ id, errType }, rinfo) {
        debuglog(`@_handleAckPacket():: id:${id}, errType:${errType.toString()}, port:${rinfo.port}, address:${rinfo.address}, family:${rinfo.family}`);
        switch (errType) {
            case ERR_NOT_FOUND_ID:
                this._receivingSession.delete(id, rinfo);
                break;
        }
    }

    /**
     * @private
     * @param {Buffer} buffer
     * @return {Object} header
     * @property {symbol} header.type
     * @property {number} header.id
     */
    _parseHeader(buffer) {
        let cursor = 0;
        const typeCode = buffer.readUInt8(cursor);
        const type = UDP_CODE_TYPES.get(typeCode);
        cursor += 2;
        const id = buffer.readUInt32BE(cursor);
        return ({ type, id });
    }

    /**
     * @private
     * @param {Buffer} buffer
     * @param {number} cursor
     * @return {Object} info
     * @property {number} info.seq
     * @property {number} info.singleTotal
     * @property {number} info.total
     * @property {buffer} info.data
     */
    _parsePshPacket(buffer, cursor) {
        const seq = buffer.readUInt16BE(cursor);
        cursor += 2;

        const singleTotal = buffer.readUInt16BE(cursor);
        cursor += 2;

        const total = buffer.readUInt16BE(cursor);
        cursor += 2;

        const data = buffer.slice(cursor);

        return ({ seq, singleTotal, total, data });
    }

    /**
     * @private
     * @param {Buffer} buffer
     * @param {number} cursor
     * @return {{sequences: number[]}}
     */
    _parseReqPacket(buffer, cursor) {
        const sequences = [];
        for (let i = cursor, len = buffer.length; i < len; i += 2) {
            sequences.push(buffer.readUInt16BE(i));
        }
        return ({ sequences: utils.unzipSequences(sequences) });
    }

    /**
     * @private
     * @param {Buffer} buffer
     * @param {number} cursor
     * @return {{ackType: symbol}}
     */
    _parseAckPacket(buffer, cursor) {
        const ackTypeCode = buffer.readUInt8(cursor);
        return ({
            ackType: UDP_CODE_TYPES.get(ackTypeCode),
        });
    }

    /**
     * @private
     * @param {Buffer} buffer
     * @param {number} cursor
     * @return {{errType: symbol}}
     */
    _parseErrPacket(buffer, cursor) {
        const errTypeCode = buffer.readUInt16BE(cursor);
        return ({
            errType: errTypeCode,
        });
    }

    /**
     * @private
     * @param {Buffer} buffer
     * @return {?Object}
     */
    _parse(buffer) {
        const header = this._parseHeader(buffer);
        let cursor = 6;
        switch (header.type) {
            case UDP_PSH:
                return Object.assign({},
                    this._parsePshPacket(buffer, cursor),
                    header
                );
            case UDP_REQ:
                return Object.assign({},
                    this._parseReqPacket(buffer, cursor),
                    header
                );
            case UDP_FIN:
                return header;
            case UDP_ACK:
                return Object.assign({},
                    this._parseAckPacket(buffer, cursor),
                    header
                );
            case UDP_ERR:
                return Object.assign({},
                    this._parseErrPacket(buffer, cursor),
                    header
                );
            default:
                console.error(`@_parse():: unknow type:${header.type}`);
                return null;
        }
    }

    /**
     * @private
     * @param {Buffer} msg
     * @param {Address} rinfo
     */
    _receive(msg, rinfo) {
        const buffer = utils.xor(msg);
        if (!utils.checksum.verify(buffer)) {
            console.error(`checksum failure, ${buffer}`);
            return;
        }
        const result = this._parse(buffer.slice(2));
        if (result === null) {
            console.error(`unknow buffer: ${buffer.toString("hex")}`);
            return;
        }
        this.emit(this._events[result.type], result, rinfo);
    }

    /**
     * @private
     * @param {number} id
     * @param {number[]} holes
     * @param {Address} rinfo
     */
    _sendReqPacket(id, holes, rinfo) {
        let len = 0;
        const header = this._packHeader(UDP_REQ, id);
        len += header.length;

        const zippedHoles = utils.zipSequences(holes);
        const buf = Buffer.alloc(zippedHoles.length * 2);
        for (let i = 0, len = zippedHoles.length; i < len; i++) {
            buf.writeUInt16BE(zippedHoles[i], i * 2);
        }
        len += buf.length;

        this._send(Buffer.concat([header, buf], len), rinfo);
    }

    /**
     * @private
     * @param {number} id
     * @param {symbol} type
     * @param {Address} rinfo
     */
    _sendAckPacket(id, type, rinfo) {
        let len = 0;
        const header = this._packHeader(UDP_ACK, id);
        len += header.length;

        const ackTypeBuf = Buffer.alloc(1);
        ackTypeBuf.writeUInt8(UDP_TYPE_CODES.get(type));
        len += ackTypeBuf.length;

        this._send(Buffer.concat([header, ackTypeBuf], len), rinfo);
    }

    /**
     * @private
     * @param {number} id
     * @param {Address} rinfo
     */
    _sendFinPacket(id, rinfo) {
        const header = this._packHeader(UDP_FIN, id);
        this._send(header, rinfo);
    }

    /**
     * @private
     * @param {number} id
     * @param {symbol} errType
     * @param {Address}
     */
    _sendErrPacket(id, errType, rinfo) {
        let len = 0;
        const header = this._packHeader(UDP_ERR, id);
        len += header.length;

        const errTypeBuf = Buffer.alloc(2);
        errTypeBuf.writeUInt16BE(errType);
        len += errTypeBuf.length;

        this._send(Buffer.concat([header, errTypeBuf], len), rinfo);
    }

    /**
     * @private
     * @param {buffer} buffer
     * @param {Address} rinfo
     */
    _send(buffer, rinfo) {
        let port, address;
        if (rinfo) {
            ({port, address} = rinfo);
        } else {
            console.error("can not find address to sends buffer");
        }
        const buf = utils.xor(utils.checksum.generate(buffer));
        this._socket.send(buf, 0, buf.length, port, address);
    }

    /**
     * @private
     * @param {symbol} type
     * @param {number} id
     */
    _packHeader(type, id) {
        let cursor = 0;
        const header = Buffer.alloc(6);
        header.writeUInt8(UDP_TYPE_CODES.get(type), cursor);
        cursor += 2;
        header.writeUInt32BE(id, cursor);
        return header;
    }

    /**
     * @private
     * @param {number} id
     * @param {number} seq
     * @param {number} parallelCount
     * @param {number} totalCount
     * @param {Buffer} buf
     * @return {Buffer}
     */
    _packData(id, seq, parallelCount, totalCount, buf) {
        debuglog(`@_packData():: id:${id}, seq:${seq}, parallelCount:${parallelCount}, totalCount:${totalCount}`);
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

    /**
     * @private
     * @param {number} id
     * @param {Buffer} buffer
     */
    *_generatePacketsBy(id, buffer) {
        const totalCount = Math.ceil(buffer.length / MAX_PACKET_SIZE);
        const parallelCount = Math.min(this._parallelCount, totalCount);
        const length = buffer.length;
        debuglog(`@_generatePacketsBy():: id:${id}, parallelCount:${parallelCount}, totalCount:${totalCount}`);

        const firstParallelCount = Math.min(parallelCount * this._frequency, totalCount);
        let req = utils.unzipSequences(
            [0x8000, 0x8000 | (firstParallelCount - 1)]
        );

        let counts = 0;

        while (req && req.length > 0) {
            let parallels = req.map(seq => {
                counts += 1;
                const start = seq * MAX_PACKET_SIZE;
                const end = Math.min(start + MAX_PACKET_SIZE, length);
                const buf = buffer.slice(start, end);
                return [seq, this._packData(id, seq, parallelCount, totalCount, buf)];
            });
            req = yield parallels;
        }

        return counts / totalCount;
    }

    _sendPshNotResponse(id, rinfo) {
        this._sendingSession.delete(id, rinfo);
        this.emit("timeout", id, rinfo);
    }

    /**
     * @private
     * @param {number} id
     * @param {Address} rinfo
     * @param {Buffer} buffer
     * @return {Generator}
     */
    _createPacketGenerator(id, rinfo, buffer) {
        const gen = this._generatePacketsBy(id, buffer);
        gen._id = id;
        gen._rinfo = Object.assign({}, rinfo);
        const _queues = gen._queues = new Map();
        gen._intervalId = setInterval(() => {
            if (_queues.size === 0) return;
            const maxSize = this._parallelCount;
            let i = 0;
            const retryPackets = [];
            for (const [seq, pkt] of _queues) {
                if (i >= maxSize) break;
                this._send(pkt, gen._rinfo);
                _queues.delete(seq);
                retryPackets.push(pkt);
                i++;
            }
            debuglog(`@interval, remaining:${_queues.size}`);
            // retry first packets
            if (!gen.hasOwnProperty("_clearRetrySendingTimer")) {
                let count = -1;
                let delay = this._RTT + 1000;
                let _ = () => {
                    count += 1;
                    delay *= 1.8;
                    if (count < 3) {
                        debuglog(`@interval, retry:${count + 1}, next time:${delay}ms`);
                        if (_queues.size === 0) {
                            for (const pkt of retryPackets) {
                                this._send(pkt, gen._rinfo);
                            }
                        }
                        gen._retrySendingTimer = setTimeout(_, delay);
                    } else {
                        this._sendPshNotResponse(id, gen._rinfo);
                    }
                };
                gen._retrySendingTimer = setTimeout(_, delay);
                gen._clearRetrySendingTimer = function (received) {
                    debuglog(`@_clearRetrySendingTimer:: ${received ? "packets sended success!" : "packets not response!"}`);
                    gen._clearRetrySendingTimer = Function();
                    if (gen._retrySendingTimer) {
                        clearTimeout(gen._retrySendingTimer);
                        delete gen._retrySendingTimer;
                    }
                };
            } else {
                retryPackets.length = 0;
            }
        }, this._interval);
        return gen;
    }

    /**
     * @private
     * @param {number[]} a
     * @param {number[]|Set<number>} b
     */
    _diffRequestSequences(a, b) {
        if (!(b instanceof Set)) {
            b = new Set(b);
        }
        return a.filter(seq => !b.has(seq));
    }

    /**
     * @private
     * @param {Object<Generator>} packetsGenerator
     * @param {number[]} requestSequences
     */
    _trySend(packetsGenerator, requestSequences) {
        debuglog(`@_trySend:: id:${packetsGenerator._id}, requestSequences:${requestSequences}`);
        if (packetsGenerator._delayTimerId) clearTimeout(packetsGenerator._delayTimerId);
        if (requestSequences) {
            if (packetsGenerator._lastRequestSequences && packetsGenerator._lastRequestSequences.length) {
                requestSequences = this._diffRequestSequences(
                    requestSequences,
                    packetsGenerator._lastRequestSequences
                );
            }
            if (requestSequences.length === 0) {
                delete packetsGenerator._lastRequestSequences;
                return;
            }
        }
        const { done, value: packets } = packetsGenerator.next(requestSequences);
        if (done) {
            if (packets) {
                debuglog("source,", JSON.stringify({
                    id: packetsGenerator._id,
                    rinfo: packetsGenerator._rinfo,
                    repeatRate: packets,
                }));
            }
            return;
        }
        for (const [key, val] of packets) {
            if (!packetsGenerator._queues.has(key)) {
                packetsGenerator._queues.set(key, val);
            }
        }
        packetsGenerator._lastRequestSequences = requestSequences;
        packetsGenerator._delayTimerId = setTimeout(() => {
            delete packetsGenerator._lastRequestSequences;
        }, this._RTT);
    }

    /**
     * @private
     * @param {Buffer} buffer
     * @param {number} id
     * @param {Address} rinfo
     * @param {Function} [onDrain]
     */
    _sendPshPacket(buffer, id, rinfo, onDrain) {
        const packetsGenerator = this._createPacketGenerator(id, rinfo, buffer);
        this._sendingSession.set(id, rinfo, packetsGenerator);

        if (typeof onDrain === "function") {
            this._drains.set(packetsGenerator, onDrain);
        }

        process.nextTick(() => {
            this._trySend(packetsGenerator);
        });
    }

    /**
     * @public
     * @param {Buffer} buffer
     * @param {Address} [rinfo=this._remoteAddress]
     * @param {Function} [onDrain]
     * @return {number}
     */
    send(buffer, rinfo, onDrain) {
        if (!rinfo || typeof rinfo === "function") {
            if (!this._remoteAddress) {
                throw new Error("remote address must be specify!");
            } else {
                if (typeof rinfo === "function") {
                    onDrain = rinfo;
                }
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
        this._sendPshPacket(buffer, id, rinfo, onDrain);
        return id;
    }

    /**
     * @public
     */
    close() {
        if (this.closed) return;

        this.closed = true;

        clearInterval(this._fnqId);
        delete this._fnqId;

        this.removeListener(this._events[UDP_PSH], this._handlePshPacket);
        this.removeListener(this._events[UDP_REQ], this._handleReqPacket);
        this.removeListener(this._events[UDP_FIN], this._handleFinPacket);
        this.removeListener(this._events[UDP_ACK], this._handleAckPacket);
        this.removeListener(this._events[UDP_ERR], this._handleErrPacket);

        this._sendingSession.clear();
        this._receivingSession.clear();
        this._sendingSession.stopClear();
        this._receivingSession.stopClear();
        this._finishNotifyQueue.clear();

        this._socket.removeListener("message", this._receive);
        this._socket.close();
        delete this._socket;
    }
}

module.exports = ReUDP;

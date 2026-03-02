/**
 * Singleton Socket.IO instance.
 *
 * Set once in server/index.js via setIO(io),
 * then read anywhere (e.g. the expense worker) via getIO().
 */

let _io = null;

function setIO(io) {
    _io = io;
}

function getIO() {
    return _io;
}

module.exports = { setIO, getIO };

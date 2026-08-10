/**
 * Registers every socket feature on one io server.
 *
 * Order matters exactly once: `registerSocial` must run first, because it
 * calls `hub.attach(io)` and everything else — including the HTTP
 * controllers that push friend requests and DMs — reaches for the hub's io
 * reference afterwards.
 *
 * Each module adds its own `io.on("connection")` handler rather than sharing
 * one. socket.io supports any number of connection listeners, and the
 * alternative (a single handler that knows about games, presence, chat and
 * voice) is the god-function this structure exists to avoid.
 */

const { registerSocial } = require("./social");
const { registerTicTacToe } = require("./ticTacToe");
const { registerRoomChat } = require("./roomChat");
const { registerVoice } = require("./voice");

function registerRealtime(io) {
  registerSocial(io);   // presence + hub.attach — must be first
  registerTicTacToe(io);
  registerRoomChat(io);
  registerVoice(io);
}

module.exports = { registerRealtime };

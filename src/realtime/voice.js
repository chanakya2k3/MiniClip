/**
 * Voice chat signalling.
 *
 * ---- What this server does, and what it deliberately doesn't ----
 *
 * The audio does NOT pass through here. This module is a postbox: it relays
 * the handshake messages (SDP offers/answers and ICE candidates) that two
 * browsers need in order to find each other, and then gets out of the way.
 * Once the peer connection is up, audio flows browser-to-browser.
 *
 * That's the whole argument for WebRTC in a project like this. Routing audio
 * through Node would mean decoding and re-encoding streams, and bandwidth
 * costs that scale with the number of people talking. Peer-to-peer for 1:1
 * costs a few hundred bytes of signalling and nothing after that.
 *
 * ---- The honest limitation ----
 *
 * Two browsers behind ordinary home routers usually can't address each other
 * directly. STUN (configured client-side, Google's public server) solves the
 * common case: it tells each peer what its public address looks like from
 * outside, and the two punch a hole through.
 *
 * It fails against symmetric NAT — most corporate networks, some mobile
 * carriers — where the router allocates a different external port per
 * destination, so the address STUN reports is not the one the other peer can
 * reach. The fix is a TURN server, which relays the audio when direct
 * connection is impossible. TURN can't be free: it carries every byte of the
 * call. So this implementation is STUN-only, will connect on most home
 * networks, and will fail on some. The UI reports that state rather than
 * hanging, and adding a TURN server later is a config change, not a rewrite.
 *
 * ---- Scope ----
 *
 * 1:1 only, tied to a game room. Group voice needs either a full mesh (N²
 * connections, falls apart past ~4 people) or an SFU, which is a separate
 * piece of infrastructure.
 */

const { userIdOf } = require("./social");
const userModel = require("../models/userModel");

/** roomId -> Map<socketId, {userId, username}> */
const voiceRooms = new Map();

/** socketId -> roomId, so a disconnect knows which room to clean up. */
const socketRoom = new Map();

const MAX_VOICE_PEERS = 2;

function participantsOf(roomId) {
  return voiceRooms.get(roomId) || new Map();
}

function registerVoice(io) {
  io.on("connection", (socket) => {
    /**
     * Join the voice channel for a game room.
     *
     * Voice requires an account. A guest can play, but an anonymous voice
     * connection is unmoderatable — there'd be no identity to attach a
     * report or a block to.
     */
    socket.on("voice:join", ({ roomId } = {}) => {
      const userId = userIdOf(socket);
      if (userId === null) {
        socket.emit("voice:error", {
          code: "auth_required",
          message: "Log in to use voice chat.",
        });
        return;
      }

      const room = String(roomId || "").slice(0, 64);
      if (!room) {
        socket.emit("voice:error", { code: "bad_room", message: "Missing room." });
        return;
      }

      const user = userModel.findById(userId);
      if (!user) return;

      let participants = voiceRooms.get(room);
      if (!participants) {
        participants = new Map();
        voiceRooms.set(room, participants);
      }

      // Already in — treat a repeat join as idempotent rather than an error,
      // because a page that reconnects will fire this again.
      if (!participants.has(socket.id)) {
        if (participants.size >= MAX_VOICE_PEERS) {
          socket.emit("voice:error", {
            code: "full",
            message: "Voice chat is full (2 people max).",
          });
          return;
        }
        participants.set(socket.id, { userId, username: user.username });
        socketRoom.set(socket.id, room);
      }

      // Tell the newcomer who's already here. The client uses this to decide
      // who initiates: the peer that finds someone already present makes the
      // offer. Without a rule like that, both sides offer simultaneously and
      // the negotiation collides ("glare").
      const others = [...participants.entries()]
        .filter(([id]) => id !== socket.id)
        .map(([id, info]) => ({ socketId: id, username: info.username }));

      socket.emit("voice:joined", { roomId: room, peers: others });

      // And tell the incumbents someone arrived.
      for (const [peerId] of participants) {
        if (peerId === socket.id) continue;
        io.to(peerId).emit("voice:peer-joined", {
          socketId: socket.id,
          username: user.username,
        });
      }
    });

    /**
     * Relay one signalling message to one peer.
     *
     * The membership check is the security boundary. Without it this is an
     * unrestricted socket-to-socket relay: any client could push arbitrary
     * JSON at any other connected socket by guessing an id. Both parties
     * must be in the same voice room, and the `from` field is stamped by the
     * server rather than accepted from the sender.
     */
    socket.on("voice:signal", ({ to, data } = {}) => {
      const room = socketRoom.get(socket.id);
      if (!room) return;

      const participants = participantsOf(room);
      if (!participants.has(socket.id)) return;
      if (!to || !participants.has(to)) return;

      io.to(to).emit("voice:signal", { from: socket.id, data });
    });

    socket.on("voice:leave", () => leaveVoice(io, socket));

    socket.on("disconnect", () => leaveVoice(io, socket));
  });
}

function leaveVoice(io, socket) {
  const room = socketRoom.get(socket.id);
  if (!room) return;

  socketRoom.delete(socket.id);

  const participants = voiceRooms.get(room);
  if (!participants) return;

  participants.delete(socket.id);

  for (const [peerId] of participants) {
    io.to(peerId).emit("voice:peer-left", { socketId: socket.id });
  }

  // Don't leave empty rooms lying around in the Map.
  if (participants.size === 0) voiceRooms.delete(room);
}

module.exports = { registerVoice };

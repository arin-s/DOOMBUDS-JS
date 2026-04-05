import { Namespace, Server, Socket } from 'socket.io';
import fs from 'fs';
import { ClientToServerEvents, ServerToClientEvents } from 'common';
import { createVerify } from 'crypto';
import express from 'express';
import { createServer } from "http";
import path, { join } from 'path';

// Load environment variables
try {
  process.loadEnvFile('../../.env');
}
catch (ignore) {
  console.warn('.env file NOT found');
  // doesn't matter whether the env file loads or not
}
let HTTP_PORT = 8080;
if (process.env.HTTP_PORT)
  HTTP_PORT = parseInt(process.env.HTTP_PORT);
let DEFAULT_TURN_DURATION_MS = 10000;
if (process.env.TURN_DURATION)
  DEFAULT_TURN_DURATION_MS = parseInt(process.env.TURN_DURATION) * 1000;

const allowedKeys: number[] = [];
// Arrow keys
allowedKeys.push(37, 38, 39, 40);
// Escape, Enter, Spacebar, Right shift, Tab
allowedKeys.push(27, 13, 32, 16, 9);
// W A S D E Y N
allowedKeys.push(119, 97, 115, 100, 101, 121, 110);
// Number keys
allowedKeys.push(48, 49, 50, 51, 52, 53, 54, 55, 56, 57);

// setup http server
const app = express();
console.log(import.meta.dirname);
app.use((req, res, next) => { res.setHeader('DOOMBUDS-RELAY', 1); next(); })
app.use(express.static(path.join(import.meta.dirname, '../../client/dist')));
const httpServer = createServer(app);

// setup Socket.io server
const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents>(httpServer, {
  cors: {
    // allow any origin
    origin: true,
  },
});

const userNsp: Namespace<ClientToServerEvents, ServerToClientEvents> = io.of('/user');
// swap the event types since we're just relaying them back to the serial server.
const adminNsp: Namespace<ServerToClientEvents, ClientToServerEvents> = io.of('/admin');
let serialServer: Socket<ServerToClientEvents, ClientToServerEvents> = null;
let keys = new Set<number>();
let users = new Map<string, Socket>();

const olog = console.log;
console.log = (...args) => {
  olog(`${new Date().toLocaleString("en-GB", { timeZone: "Australia/Sydney" })}:   `, ...args);
}

// set Socket.io events
userNsp.on('connection', (user) => {
  console.log(`Client ${user.id} connected`);
  // this isn't bulletproof at all but gets rid of low hanging fruit at least
  const uuid = user.handshake.auth.userId;
  if (!uuid) {
    user.disconnect();
    return;
  }
  if (users.has(uuid)) {
    console.log(`Old client instance ${users.get(uuid).id} booted!`);
    users.get(uuid).disconnect();
  }
  users.set(uuid, user);
  // events
  user.on('keyState', (keyStateArray) => {
    // Remove unallowed keys
    keyStateArray = keyStateArray.filter(({ key }) => allowedKeys.includes(key));
    // keep track of pressed keys so we can clear them later
    for (const { key } of keyStateArray) {
      keys.add(key);
    }
    // if we have a player and serial server is connected, forward the keys
    if (currClient && currClient.id === user.id && serialServer) {
      serialServer.emit('keyState', keyStateArray);
    }
  });
  user.on('disconnect', (reason) => {
    console.log(`Client ${user.id} disconnected. Reason: ${reason}`);
    // if current player, end turn
    if (currClient && user.id === currClient.id) {
      endTurn();
    }
    // remove from queue if present
    else {
      queue = queue.filter(socket => socket.id !== user.id);
      emitQueueStatus();
    }
  });
  user.on('joinQueue', (callback) => {
    if (queue.includes(user)) {
      callback('Already in queue!');
      return;
    }
    if (queue.length >= 8000) {
      callback('Queue full!');
      return;
    }
    queue.push(user);
    if (!currTimer && !currClient) {
      startTurn();
      return;
    }
    else {
      callback(null);
    }
    user.once('leaveQueue', () => {
      queue = queue.filter(socket => socket.id !== user.id);
      emitQueueStatus();
    });
    emitQueueStatus();
  });
});

// serialserver middleware
adminNsp.use((admin, next) => {
  if (process.env.PUB_KEY) {
    try {
      const privKey = fs.readFileSync(path.join(import.meta.dirname, process.env.PUB_KEY));
      const verify = createVerify('SHA-256');
      verify.update(admin.handshake.auth.timestamp);
      const timestamp = parseInt(admin.handshake.auth.timestamp);
      const time = Date.now();
      const unixDelta = Math.abs(timestamp - time);
      if (unixDelta > 60 * 5 * 1000) {
        console.log(`Admin ${admin.client.conn.remoteAddress} failed to connect. Reason: Timestamp delta too high!`);
        console.log(`Delta: ${unixDelta} Admin timestamp: ${timestamp} Local timestamp: ${time}`);
        next(new Error(`Timestamp delta too high!`));
        return;
      }
      const valid = verify.verify(privKey, admin.handshake.auth.signedTimestamp, 'hex');
      if (!valid) {
        console.log(`Admin ${admin.client.conn.remoteAddress} failed to connect. Reason: Invalid signature!`);
        next(new Error('Invalid signature!'));
        return;
      }
    }
    catch (err) {
      if (err instanceof Error)
        console.log(`Admin ${admin.client.conn.remoteAddress} failed to connect. ${err.name}: ${err.message}`);
      next(new Error('Unknown signature verification error!'));
      return;
    }
  }
  serialServer = admin;
  console.log(`Admin ${admin.client.conn.remoteAddress} connected`);
  next();
});

// handle serialserver connection event
adminNsp.on('connection', (admin) => {
  admin.on('disconnect', (reason) => {
    if (serialServer === admin) {
      serialServer = null;
    }
    console.log(`Admin ${admin.client.conn.remoteAddress} disconnected. Reason: ${reason}`);
  });
  admin.on('decodedPacket', (packet) => {
    // send to all clients for now
    userNsp.emit('decodedPacket', packet);
  });
});

// start http server
httpServer.listen(HTTP_PORT, () => {
  console.log(`Server running at http://localhost:${HTTP_PORT}/`);
});

// queue stuff
let currClient: Socket<ClientToServerEvents, ServerToClientEvents> | null = null;
let currTimer: NodeJS.Timeout | null = null;
let queue: Socket<ClientToServerEvents, ServerToClientEvents>[] = [];

// pop queue and start a turn
function startTurn() {
  // this should not happen, but just in case
  if (currTimer)
    return;
  // get the player at the front of the queue
  currClient = queue.shift();
  if (currClient === undefined) {
    // no more clients
    return;
  }
  emitQueueStatus();
  currClient.emit('turnStart', Math.round(DEFAULT_TURN_DURATION_MS / 1000));
  currTimer = setTimeout(() => {
    endTurn();
  }, DEFAULT_TURN_DURATION_MS);
}

function endTurn() {
  if (currTimer) {
    clearTimeout(currTimer);
    currTimer = null;
  }
  if (currClient) {
    currClient.emit('turnEnd');
    currClient = null;
  }
  if (serialServer) {
    const keyStateArray: { key: number; value: boolean }[] = [];
    for (const key of keys) {
      keyStateArray.push({ key: key, value: false });
    }
    console.log('Emitting clear');
    serialServer.emit('keyState', keyStateArray);
  }
  startTurn();
}

function emitQueueStatus() {
  let pos = 1;
  for (const socket of queue) {
    console.log(`Emitting for ${socket.conn.remoteAddress}`);
    socket.emit('posStatus', pos);
    pos++;
  }
  userNsp.emit('queueStatus', queue.length);
}
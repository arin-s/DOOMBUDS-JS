import { Namespace, Server, Socket } from 'socket.io';
import fs from 'fs';
import http from 'http';
import mime from 'mime-types';
import { ClientToServerEvents, createKeyPacket, PacketType, processChunk, ServerToClientEvents } from 'common';
import { createVerify } from 'crypto';
import express from 'express';
import { createServer } from "http";
import path from 'path';

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

// set Socket.io events
let users = new Map<String, Socket<ClientToServerEvents, ServerToClientEvents>>();
userNsp.on('connection', (user) => {
  console.log(`Client ${user.id} connected`);
  users.set(user.id, user);
  // events
  user.on('keyState', (keyStateArray) => {
    if (serialServer) {
      serialServer.emit('keyState', keyStateArray);
    }
  });
  user.on('disconnect', (reason) => {
    console.log(`Client ${user.id} disconnected`);
    users.delete(user.id);
  });
});

adminNsp.use((socket, next) => {
  if(process.env.PUB_KEY) {
    const privKey = fs.readFileSync(path.join(import.meta.dirname, process.env.PUB_KEY));
    const verify = createVerify('SHA-256');
    verify.update(socket.handshake.auth.timestamp);
    const timestamp = parseInt(socket.handshake.auth.timestamp);
    const unixDelta = Math.abs(timestamp - Date.now());
    if (unixDelta > 60 * 5)
      next(new Error('Timestamp delta too high!'));
    const valid = verify.verify(privKey, socket.handshake.auth.signedTimestamp, 'hex');
    if (!valid)
      next(new Error('Signature verification failed!'));
  }
  serialServer = socket;
  console.log('Admin connected!');
  next();
});

adminNsp.on('connection', (admin) => {
  admin.on('disconnect', () => {
    serialServer = null;
  });
  admin.on('decodedPacket', (packet) => {
    // send to all clients for now
    for (const user of users.values()) {
      user.emit('decodedPacket', packet);
    }
  });
});

// start http server
httpServer.listen(HTTP_PORT, () => {
  console.log(`Server running at http://localhost:${HTTP_PORT}/`);
});

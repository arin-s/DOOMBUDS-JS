import { Namespace, Server, Socket } from 'socket.io';
import fs from 'fs';
import { ClientToServerEvents, ServerToClientEvents } from 'common';
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
const users = new Map<String, Socket<ClientToServerEvents, ServerToClientEvents>>();
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
    console.log(`Client ${user.id} disconnected. Reason: ${reason}`);
    users.delete(user.id);
  });
});

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
      }
      const valid = verify.verify(privKey, admin.handshake.auth.signedTimestamp, 'hex');
      if (!valid) {
        console.log(`Admin ${admin.client.conn.remoteAddress} failed to connect. Reason: Invalid signature!`);  
        next(new Error('Invalid signature!'));
      }
    }
    catch (err) {
      if (err instanceof Error)
        console.log(`Admin ${admin.client.conn.remoteAddress} failed to connect. ${err.name}: ${err.message}`);
      next(new Error('Unknown signature verification error!'));
    }
  }
  serialServer = admin;
  console.log(`Admin ${admin.client.conn.remoteAddress} connected`);
  next();
});

adminNsp.on('connection', (admin) => {
  admin.on('disconnect', (reason) => {
    serialServer = null;
    console.log(`Admin ${admin.client.conn.remoteAddress} disconnected. Reason: ${reason}`);
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

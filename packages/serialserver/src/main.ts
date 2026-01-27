import fs from 'fs';
import path from 'path';
import prompts from 'prompts';
import { SerialPort } from 'serialport';
import { io, ManagerOptions, Socket, SocketOptions } from 'socket.io-client';
import { ClientToServerEvents, createKeyPacket, PacketType, processChunk, ServerToClientEvents } from 'common';
import { createSign } from 'crypto';

// Load environment variables
try {
  process.loadEnvFile('../../.env');
}
catch (ignore) {
  // doesn't matter whether the env file loads or not
}
let WEBSERVER_URL = process.env.WEBSERVER_URL;
if (!WEBSERVER_URL) {
  console.warn('No webserver URL supplied, defaulting to http://127.0.0.1');
  WEBSERVER_URL = 'http://127.0.0.1';
}
let HTTP_PORT = '8080';
if (process.env.HTTP_PORT)
  HTTP_PORT = process.env.HTTP_PORT;

// global variables
let serialPort: SerialPort;
let webSocket: Socket<ClientToServerEvents, ServerToClientEvents>;
let selectedPortPath: string;
let reconnectInterval: NodeJS.Timeout;
let restarting = false;

// SIGINT handler
process.on('SIGINT', async () => {
  console.log('Ctrl-C was pressed!');
  await closeAll();
  process.exit(0);
});

let firstInit = true;
async function init() {
  try {
    // init serialport
    if (!selectedPortPath) {
      const ports = await SerialPort.list();
      const portChoices = ports.map(port => ({ title: port.path, value: port.path }));
      const portResponse = await prompts({
        type: 'select',
        name: 'port',
        message: 'Select port',
        choices: portChoices,
      });
      selectedPortPath = portResponse.port;
    }
    serialPort = new SerialPort({ path: selectedPortPath, baudRate: 3000000, autoOpen: false });
    await new Promise<void>((resolve, reject) => {
      serialPort.open((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    serialPort.on('data', serialData);
    serialPort.on('error', (err) => {
      console.log(`${err.name}: ${err.message}`);
    });
    serialPort.on('close', () => {
      if (!restarting) {
        restart();
      }
    });
    // init websockets
    let opts: Partial<ManagerOptions & SocketOptions> = {};
    if (process.env.PRIV_KEY) {
      const time = Date.now().toString();
      const privKey = fs.readFileSync(path.join(import.meta.dirname, process.env.PRIV_KEY));
      const sign = createSign('SHA-256');
      sign.update(time);
      const signedTimestamp = sign.sign(privKey, 'hex');
      opts.auth = {
        timestamp: time,
        signedTimestamp: signedTimestamp,
      };
    }
    webSocket = io(`${WEBSERVER_URL}:${HTTP_PORT}/admin`, opts);
    webSocket.on('keyState', (keyStateArray) => {
      try {
        const packet = createKeyPacket(keyStateArray);
        if (serialPort.isOpen)
          serialPort.write(packet);
      }
      catch (err) {
        if (err instanceof Error)
          console.log(`${err.name}: ${err.message}`);
      }
    });
    webSocket.on('connect', () => {
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
      }
      if (webSocket.recovered)
        console.log('Webserver connection recovered');
      else
        console.log('Webserver connection established');
    });
    webSocket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect' && !webSocket.active) {
        console.log(`Webserver disconnected: ${reason}`);
        reconnectInterval = setInterval(() => {
          console.log('Connecting to Webserver...');
          webSocket.connect();
        }, 5000);
      }
    });
    webSocket.on('connect_error', (err) => {
      if (err instanceof Error) {
        console.error(`${err.name}: ${err.message}`);
        if (err.message && err.message.includes('Timestamp delta too high!')) {
          restart();
        }
      }
    });
  }
  catch (err) {
    console.log('init() failed');
    if (err instanceof Error)
      console.log(`${err.name}: ${err.message}`);
    if (firstInit) {
      console.log('Failed on initial setup, aborting');
      await closeAll();
      process.exit(0);
    }
    throw err;
  }
  firstInit = false;
}

async function closeAll() {
  if (serialPort && !serialPort.closed) {
    await new Promise<void>((resolve) => {
      serialPort.close(() => resolve());
    });
    serialPort = null;
    console.log('Serial port closed');
  }
  if (webSocket) {
    webSocket.close();
    while (true) {
      if (!webSocket.connected)
        break;
    }
    console.log('Websocket closed');
  }
}

async function serialData(chunk: Buffer) {
  const packet = processChunk(chunk);
  if (packet === null)
    return;
  if (packet.packetType === PacketType.PACKET_LOG) {
    console.log(`BUDS: ${new TextDecoder().decode(packet.packetData)}`);
  }
  if (packet.packetType === PacketType.PACKET_VIDEO) {
    try {
      if (webSocket && webSocket.connected) {
        webSocket.emit('decodedPacket', packet);
      }
    }
    catch (err) {
      if (err instanceof Error) {
        console.log(`serialData(): ${err.name} ${err.message}`);
        restart();
      }
    }
  }
}

async function restart()
{
  if (restarting)
    return;
  restarting = true;
  while (true) {
    try {
      await closeAll();
      await init();
      break;
    }
    catch (err) {
      console.log('Failed, re-trying in 5 seconds');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  restarting = false;
}

// Entry point
await restart();

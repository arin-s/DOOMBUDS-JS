import { serial as polyfill } from 'web-serial-polyfill';
import { MsgType, SerialMessageEvent } from './serial-worker';
import { processChunk, PacketType, Packet, ClientToServerEvents, ServerToClientEvents, createKeyPacket } from 'serial-mjpeg-common';
import { io, Socket } from 'socket.io-client';

const serialWorker = new Worker(new URL('serial-worker.ts', import.meta.url), { type: 'module' });

let frameBuffer: HTMLImageElement;
let connectButton: HTMLButtonElement;
let polyfillCheckbox: HTMLInputElement;
let connected = false;
let bpsCounter = 0;
let fpsCounter = 0;
let frameSizeLabel: HTMLLabelElement;
let keyLabel;
let keys: Map<number, boolean> = new Map();
let relay: boolean;
let socket: Socket<ServerToClientEvents, ClientToServerEvents>;

document.addEventListener('DOMContentLoaded', async () => {
  // Get elements
  frameBuffer = document.getElementById('frameBuffer') as HTMLImageElement;
  connectButton = document.getElementById('connect') as HTMLButtonElement;
  polyfillCheckbox = document.getElementById('polyfill_checkbox') as HTMLInputElement;
  keyLabel = document.getElementById('keyLabel') as HTMLLabelElement;
  let bpsLabel = document.getElementById('bpsLabel') as HTMLLabelElement;
  let fpsLabel = document.getElementById('fpsLabel') as HTMLLabelElement;
  frameSizeLabel = document.getElementById('frameSizeLabel') as HTMLLabelElement;
  // Setup listeners
  connectButton.addEventListener('click', toggleConnect);
  frameBuffer.addEventListener('keydown', processInput);
  frameBuffer.addEventListener('keyup', processInput);
  // Setup fps/bps tracker
  window.setInterval(() => {
    bpsLabel.innerText = 'Bits/Sec: ' + bpsCounter.toString();
    bpsCounter = 0;
    fpsLabel.innerText = 'FPS: ' + fpsCounter.toString();
    fpsCounter = 0;
  }, 1000);

  // If connecting to a nodejs server 
  const res = await fetch(document.URL, {method: 'HEAD'});
  relay = res.headers.has('DOOMBUDS-RELAY');
  if (relay) {
    connectButton.disabled = true;
    socket = io();
    socket.on('decodedPacket', (packet) => {
      processPacket(packet);
    });
  }
});

async function toggleConnect() {
  if (connected) {
    connectButton.textContent = 'Disconnecting...';
    connectButton.disabled = false;
    serialWorker.postMessage(MsgType.DISCONNECT);
  }
  else {
    const serial = polyfillCheckbox.checked ? polyfill : navigator.serial;
    const ports = await serial.getPorts();
    for (const port of ports)
      await port.forget();
    try {
      await serial.requestPort({});
    }
    catch (e) {
      console.error(e);
      return;
    }
    connectButton.textContent = 'Connecting...';
    connectButton.disabled = true;
    serialWorker.postMessage({ msg: MsgType.CONNECT,
      startParams: { baudRate: 3000000,
        usePolyfill: polyfillCheckbox.checked } });
  }
}

function markDisconnected(): void {
  connected = true;
  connectButton.textContent = 'Connect';
  connectButton.disabled = false;
}

serialWorker.addEventListener('message', async (event: MessageEvent<SerialMessageEvent>) => {
  //console.log(`RECEIVED EVENT: ${event.data.msg}`);
  let packet: null | Packet;
  switch (event.data.msg) {
    case MsgType.CONNECT_FAILED:
      console.log('Stream fail received');
      markDisconnected();
      break;
    case MsgType.DISCONNECTED:
      markDisconnected();
      break;
    case MsgType.CONNECTED:
      connected = true;
      console.log('CONNECTED');
      connectButton.textContent = 'Disconnect';
      connectButton.disabled = false;
      break;
    case MsgType.SERIAL_RX:
      packet = processChunk(event.data.array!);
      processPacket(packet);
      break;
  }
});

function processPacket(packet: Packet | null) {
  if (packet === null)
    return;
  //console.log(`PACKET RECEIVED: ${packet.packetType}`);
  switch (packet.packetType) {
    case PacketType.PACKET_LOG:
      console.log(new TextDecoder().decode(packet.packetData));
      break;
    case PacketType.PACKET_VIDEO:
      paintCanvas(packet.packetData);
      break;
  }

}

async function paintCanvas(frame: ArrayBuffer) {
  const blob = new Blob([frame], { type: 'image/jpeg' });
  bpsCounter += blob.size * 8;
  fpsCounter++;
  frameSizeLabel.innerText = "Frame Size: " + blob.size;
  try {
    createImageBitmap(blob); // errors if invalid image
    const url = URL.createObjectURL(blob);
    frameBuffer.onload = () => { URL.revokeObjectURL(url) };
    frameBuffer.src = url;
  } catch (error) {
    console.error("MALFORMED IMAGE: ", error);
    console.error(`FRAME SIZE: ${frame.byteLength}`);
    return;
  }
}

function processInput(event: KeyboardEvent) {
  event.preventDefault();
  let pressed: boolean = event.type == "keydown";
  let code = event.keyCode;
  if (code >= 'A'.charCodeAt(0) && code <= 'Z'.charCodeAt(0))
    code += 32;
  keys.set(code, pressed);
  const keyStateArray = Array.from(keys, ([key, value]) => ({ key, value }));
  if (relay)
    socket.emit('keyState', keyStateArray);
  else {
    const keyStatePacket = createKeyPacket(keyStateArray);
    serialWorker.postMessage({msg: MsgType.SERIAL_TX, array: keyStatePacket});
  }
}
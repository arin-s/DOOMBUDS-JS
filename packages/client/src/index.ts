import { PacketType, Packet, ClientToServerEvents, ServerToClientEvents } from 'common';
import { io, Socket } from 'socket.io-client';

let frameBuffer: HTMLImageElement;
let bpsCounter = 0;
let fpsCounter = 0;
let frameSizeLabel: HTMLLabelElement;
let keyLabel;
let keys: Map<number, boolean> = new Map();
let socket: Socket<ServerToClientEvents, ClientToServerEvents>;

document.addEventListener('DOMContentLoaded', async () => {
  // Get elements
  frameBuffer = document.getElementById('frameBuffer') as HTMLImageElement;
  keyLabel = document.getElementById('keyLabel') as HTMLLabelElement;
  let bpsLabel = document.getElementById('bpsLabel') as HTMLLabelElement;
  let fpsLabel = document.getElementById('fpsLabel') as HTMLLabelElement;
  frameSizeLabel = document.getElementById('frameSizeLabel') as HTMLLabelElement;
  // Setup listeners
  frameBuffer.addEventListener('keydown', processInput);
  frameBuffer.addEventListener('keyup', processInput);
  // Setup fps/bps tracker
  window.setInterval(() => {
    bpsLabel.innerText = 'Bits/Sec: ' + bpsCounter.toString();
    bpsCounter = 0;
    fpsLabel.innerText = 'FPS: ' + fpsCounter.toString();
    fpsCounter = 0;
  }, 1000);
  socket = io('/user');
  socket.on('decodedPacket', (packet) => {
    processPacket(packet);
  });
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
  socket.emit('keyState', keyStateArray);
}
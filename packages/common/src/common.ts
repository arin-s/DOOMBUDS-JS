export enum PacketType {
  PACKET_LOG,
  PACKET_VIDEO,
  PACKET_SOUND,
  PACKET_NETWORK,
  PACKET_INPUT,
};

export type Packet = { packetType: PacketType; packetData: ArrayBuffer };

export interface ServerToClientEvents {
  decodedPacket: (packet: Packet) => void;
  queueStatus: (playersInQueue: number) => void;
  posStatus: (pos: number) => void;
  turnStart: (duration: number) => void;
  turnEnd: () => void;
}

export interface ClientToServerEvents {
  joinQueue: (callback: (error: string | null) => void) => void;
  leaveQueue: () => void;
  keyState: (keyStateArray: { key: number; value: boolean }[]) => void;
}

// Stores input chunks, average frame size = 13.5kb
const chunkBufferSize = 1024 * 1000;
const chunkBuffer = new Uint8Array(chunkBufferSize); // 1MB
// The amount of bytes in chunkBuffer
let chunkBufferOffset = 0;
// Keep track of reading index
let readIndex = 0;
// To prevent concurrent function calls
let mutex = false;
// Stores result frame
let frame: Uint8Array;

export function processChunk(inputChunk: Uint8Array): null | Packet {
  if (mutex) {
    console.error('inputChunk dropped');
    return;
  }
  mutex = true;
  // clear buffer on overflow
  if (chunkBufferOffset + inputChunk.length >= chunkBufferSize) {
    chunkBufferOffset = 0;
    readIndex = 0;
  }
  // Append inputChunk to chunkBuffer
  try {
    chunkBuffer.set(inputChunk, chunkBufferOffset);
  } catch (error) {
    let msg;
    if (error instanceof Error)
      msg = error.message;
    else
      msg = String(error);
    console.error(`Error: ${msg}`);
    console.error(`Offset: ${chunkBufferOffset}`);
    console.error(`Chunk length: ${inputChunk.byteLength}`);
  }
  // Main loop
  for (let i = readIndex; i < inputChunk.length + chunkBufferOffset; i++) {
    // find end of packet marker
    if (chunkBuffer[i] === 0) {
      frame = chunkBuffer.slice(0, i + 1);
      const remainder = chunkBuffer.slice(i + 1, chunkBufferOffset + inputChunk.length);
      chunkBuffer.set(remainder, 0);
      const decoded = cobsDecode(frame);
      const packetType = decoded[0];
      const packetData = decoded.slice(1, decoded.length + 2);
      // Set variables for next call then return
      chunkBufferOffset = remainder.length;
      readIndex = 0;
      mutex = false;
      const slicedArray = packetData.buffer.slice(packetData.byteOffset, packetData.byteOffset + packetData.byteLength);
      return { packetType, packetData: slicedArray };
    }
  }
  chunkBufferOffset += inputChunk.length;
  readIndex = chunkBufferOffset;
  mutex = false;
  return null;
}

export function cobsEncode(data: Uint8Array): Uint8Array {
  // Largest possible size for result buffer
  let buf = new Uint8Array(1 + Math.ceil(data.length * 255 / 254));
  let dataIndex = 0;
  let bufIndex = 1; // Set to 1 to leave room for the header byte
  let linkIndex = 0; // Keeps track of the last link location
  let linkOffset = 1; // Offset of the next link relative to the previous one
  while (dataIndex < data.length) {
    // Zero byte or max link size reached
    if (data[dataIndex] === 0 || linkOffset === 255) {
      buf[linkIndex] = linkOffset;
      linkIndex = bufIndex;
      linkOffset = 0;
      if (data[dataIndex] === 0)
        dataIndex++;
    }
    // Non-zero data byte
    else if (data[dataIndex] !== 0) {
      buf[bufIndex] = data[dataIndex];
      dataIndex++;
    }
    bufIndex++;
    linkOffset++;
  }
  buf[linkIndex] = linkOffset;
  return buf;
}

export function cobsDecode(data: Uint8Array): Uint8Array {
  let buf = new Uint8Array(data.length);
  let dataIndex = 1;
  let bufIndex = 0;
  let linkOffset = data[0];
  let linkIndex = 0;
  while (dataIndex < data.length) {
    // Link byte
    if (linkIndex + linkOffset === dataIndex) {
      // Reached the end, break
      if (data[dataIndex] === 0)
        break;
      // Encoded zero, write
      if (linkOffset !== 255)
      {
        buf[bufIndex] = 0;
        bufIndex++;
      }
      linkIndex = dataIndex;
      linkOffset = data[dataIndex];
    }
    // Non-link byte
    else {
      buf[bufIndex] = data[dataIndex];
      bufIndex++;
    }
    dataIndex++;
  }
  return buf.subarray(0, bufIndex);
}

export function createKeyPacket(keyStateArray: { key: number; value: boolean }[]): Uint8Array {
  let keyStateString: string = "";
  let mask = 1 << 7;
  for (let keyPair of keyStateArray) {
    let encodedKey = keyPair.key;
    if(keyPair.value)
      encodedKey |= mask;
    else
      encodedKey &= ~mask;
    keyStateString += String.fromCharCode(encodedKey);
  }
  let frame = new Uint8Array(keyStateString.length);
  for (let i = 0; i < frame.length; i++)
    frame[i] = keyStateString.charCodeAt(i);
  return (cobsEncode(frame));
}

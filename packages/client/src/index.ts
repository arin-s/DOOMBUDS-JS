import { PacketType, Packet, ClientToServerEvents, ServerToClientEvents } from 'common';
import { io, Socket } from 'socket.io-client';

let mjpegElement: HTMLImageElement;
let bpsCounter = 0;
let fpsCounter = 0;
let keys: Map<number, boolean> = new Map();
let socket: Socket<ServerToClientEvents, ClientToServerEvents>;
let status: 'watching' | 'inQueue' | 'inGame' = 'watching';
let focusOverlay: HTMLDivElement;
let helpBox: HTMLDivElement;
let helpBoxHeader: HTMLParagraphElement;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let ticker: NodeJS.Timeout;

// mobile detection
let mobile;
if (!matchMedia('(pointer:fine)').matches && navigator.maxTouchPoints > 1)
  mobile = true;
else
  mobile = false;

const DEFAULT_TURN_DURATION = import.meta.env.TURN_DURATION;
  
document.addEventListener('DOMContentLoaded', async () => {
  // Get elements
  let joinButton = document.getElementById('joinButton') as HTMLButtonElement;
  let playersQueuedText = document.getElementById('playersQueuedText') as HTMLParagraphElement;
  let waitTimeText = document.getElementById('waitTimeText') as HTMLParagraphElement;
  let yourPosText = document.getElementById('yourPosText') as HTMLParagraphElement;
  focusOverlay = document.getElementById('focusOverlay') as HTMLDivElement;
  helpBox = document.getElementById('helpBox') as HTMLDivElement;
  helpBoxHeader = document.getElementById('helpBoxHeader') as HTMLParagraphElement;
  canvas = document.getElementById('canvas') as HTMLCanvasElement;
  ctx = canvas.getContext('2d');
  if (mobile) {
    joinButton.disabled = mobile;
    joinButton.classList.replace('doom-border-outset', 'doom-border-inset');
    joinButton.innerText = 'Desktop-only';
  }
  joinButton.addEventListener('click', () => {
    if (status === 'watching') {
      socket.emit('joinQueue', (error) => {
        if (error) {
          window.alert(error);
          return;
        }
        status = 'inQueue';
        // TODO: Add styles here
        joinButton.innerText = 'Leave queue';
      });
    }
    else if (status === 'inQueue') {
      socket.emit('leaveQueue');
      status = 'watching';
      disableHints();
      joinButton.innerText = 'Join queue';
      yourPosText.innerText = '-';
    }
  });
  let uuid = localStorage.getItem('userID');
  if (!uuid) {
    uuid = crypto.randomUUID();
    localStorage.setItem('userID', uuid);
  }
  socket = io('/user', {
    auth: { userId: uuid },
  });
  socket.on('decodedPacket', (packet) => {
    processPacket(packet);
  });
  socket.on('queueStatus', (playersInQueue) => {
    if (status === 'watching') {
      if (playersInQueue === 0) {
        waitTimeText.innerText = '-';
      }
      else {
        const timeSecs = playersInQueue * DEFAULT_TURN_DURATION;
        waitTimeText.innerText = `${Math.floor(timeSecs / 60)}:${String(timeSecs % 60).padStart(2, '0')}`;
      }
    }
    if (playersInQueue >= 8000) {
      joinButton.disabled = true;
      joinButton.classList.add('bg-gray-800');
    }
    if (playersInQueue < 8000) {
      joinButton.disabled = false;
      joinButton.classList.remove('bg-gray-800');
    }
    playersQueuedText.innerText = playersInQueue.toString();
  });
  socket.on('posStatus', (pos) => {
    const timeSecs = pos * DEFAULT_TURN_DURATION;
    waitTimeText.innerText = `${Math.floor(timeSecs / 60)}:${String(timeSecs % 60).padStart(2, '0')}`;
    yourPosText.innerText = `#${pos.toString()}`;
    if (pos <= 5)
      enableHints();
  });
  socket.on('turnEnd', () => {
    console.log('TURN END');
    status = 'watching';
    joinButton.disabled = false;
    joinButton.classList.replace('doom-border-inset', 'doom-border-outset');
    joinButton.innerText = 'Join queue';
    helpBoxHeader.innerText = `It's almost your turn, get ready!`;
    helpBoxHeader.classList.remove('animate-bounce');
    helpBoxHeader.classList.remove('text-red-600');
    document.getElementById('durationDiv')?.remove();
    canvas.onkeydown = null;
    canvas.onkeyup = null;
    disableHints();
    clearInterval(ticker);
    keys.clear();
  });
  socket.on('turnStart', (duration) => {
    console.log('TURN START');
    status = 'inGame';
    waitTimeText.innerText = '-';
    joinButton.disabled = true;
    joinButton.innerText = 'In game';
    yourPosText.innerText = '-';
    joinButton.classList.replace('doom-border-outset', 'doom-border-inset');
    helpBoxHeader.innerText = `It's your turn! RIP AND TEAR!`;
    helpBoxHeader.classList.add('animate-bounce');
    helpBoxHeader.classList.add('text-red-600');
    canvas.onkeydown = processInput;
    canvas.onkeyup = processInput;
    enableHints();
    // progress bar
    const durationDiv = document.createElement('div');
    durationDiv.className = 'relative h-8 md:h-14';
    durationDiv.id = 'durationDiv';
    const label = document.createElement('p');
    label.className = 'absolute -translate-1/2 top-1/2 left-1/2 text-xl md:text-5xl';
    durationDiv.append(label);
    const durationBar = document.createElement('progress');
    durationBar.className = 'w-full h-full';
    durationBar.max = duration;
    durationBar.value = duration;
    label.innerText = duration.toString();
    ticker = setInterval(() => {
      duration--;
      durationBar.value = duration;
      label.innerText = duration.toString();
    }, 1000);
    durationDiv.append(durationBar);
    document.getElementById('stream-container').after(durationDiv);
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
  //frameSizeLabel.innerText = "Frame Size: " + blob.size;
  try {
    const bitmap = await createImageBitmap(blob); // errors if invalid image
    if(ctx)
      ctx.drawImage(bitmap, 0, 0);
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

function disableHints() {
  canvas.onfocus = null;
  canvas.onblur = null;
  focusOverlay.hidden = true;
  helpBox.hidden = true;
}

function enableHints() {
  canvas.onfocus = () => {
    focusOverlay.hidden = true;
  };
  canvas.onblur = () => {
    focusOverlay.hidden = false;
  };
  helpBox.hidden = false;
  canvas.focus();
}

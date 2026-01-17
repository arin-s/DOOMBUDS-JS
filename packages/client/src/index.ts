import { PacketType, Packet, ClientToServerEvents, ServerToClientEvents, processChunk } from 'common';
import { io, Socket } from 'socket.io-client';

type streamType = 'serial' | 'twitch';

let mjpegElement: HTMLImageElement;
let bpsCounter = 0;
let fpsCounter = 0;
let frameSizeLabel: HTMLLabelElement;
let keyLabel;
let keys: Map<number, boolean> = new Map();
let socket: Socket<ServerToClientEvents, ClientToServerEvents>;
let status: 'watching' | 'inQueue' | 'inGame' = 'watching';
let activeStream: streamType;
let focusOverlay: HTMLDivElement;
let helpBox: HTMLDivElement;
let helpBoxHeader: HTMLParagraphElement;

// mobile detection
let mobile;
if (!matchMedia('(pointer:fine)').matches && navigator.maxTouchPoints > 1)
  mobile = true;
else
  mobile = false;

const DEFAULT_TURN_DURATION = import.meta.env.TURN_DURATION ?? 30;
  
document.addEventListener('DOMContentLoaded', async () => {
  // Get elements
  let joinButton = document.getElementById('joinButton') as HTMLButtonElement;
  let playersQueuedText = document.getElementById('playersQueuedText') as HTMLParagraphElement;
  let waitTimeText = document.getElementById('waitTimeText') as HTMLParagraphElement;
  let yourPosText = document.getElementById('yourPosText') as HTMLParagraphElement;
  focusOverlay = document.getElementById('focusOverlay') as HTMLDivElement;
  helpBox = document.getElementById('helpBox') as HTMLDivElement;
  helpBoxHeader = document.getElementById('helpBoxHeader') as HTMLParagraphElement;
  switchStream('twitch');
  //keyLabel = document.getElementById('keyLabel') as HTMLLabelElement;
  //let bpsLabel = document.getElementById('bpsLabel') as HTMLLabelElement;
  //let fpsLabel = document.getElementById('fpsLabel') as HTMLLabelElement;
  //frameSizeLabel = document.getElementById('frameSizeLabel') as HTMLLabelElement;
  // Setup listeners
  // Setup fps/bps tracker
  /*window.setInterval(() => {
    bpsLabel.innerText = 'Bits/Sec: ' + bpsCounter.toString();
    bpsCounter = 0;
    fpsLabel.innerText = 'FPS: ' + fpsCounter.toString();
    fpsCounter = 0;
  }, 1000);*/
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
      switchStream('twitch');
      joinButton.innerText = 'Join queue';
      yourPosText.innerText = '-';
    }
  });
  const uuid = localStorage.getItem('userID');
  if (!uuid) {
    localStorage.setItem('userID', crypto.randomUUID());
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
      switchStream('serial');
    // if someone cuts in front of you >:)
    else if (activeStream === 'serial' && pos > 5)
      switchStream('twitch');
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
    switchStream('twitch');
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
    if (activeStream === 'twitch')
      switchStream('serial');
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
    let ticker = setInterval(() => {
      if (duration === 1)
        clearInterval(ticker);
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
    createImageBitmap(blob); // errors if invalid image
    const url = URL.createObjectURL(blob);
    mjpegElement.onload = () => { URL.revokeObjectURL(url) };
    mjpegElement.src = url;
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

function switchStream(streamType: streamType) {
  activeStream = streamType;
  const container = document.getElementById('stream-container');
  document.getElementById('stream')?.remove();
  document.getElementById('durationDiv')?.remove();
  if (streamType === 'twitch') {
    const child = document.createElement('iframe');
    child.id = 'stream';
    child.className = 'aspect-video';
    child.src = `https://player.twitch.tv/?channel=${import.meta.env.TWITCH_CHANNEL}&parent=localhost&parent=${import.meta.env.WEBSERVER_DOMAIN_NAME}`;
    container.append(child);
    focusOverlay.hidden = true;
    helpBox.hidden = true;
  }
  else {
    const child = document.createElement('img');
    child.id = 'stream';
    child.className = '[image-rendering:pixelated] w-[min(100%,100cqh*320/200)]';
    child.width = 320;
    child.height = 200;
    child.tabIndex = 0;
    container.append(child);
    child.addEventListener('keydown', processInput);
    child.addEventListener('keyup', processInput);
    child.addEventListener('focus', () => {
      focusOverlay.hidden = true;
    });
    child.addEventListener('blur', () => {
      focusOverlay.hidden = false;
    });
    helpBox.hidden = false;
    focusOverlay.hidden = false;
    mjpegElement = child;
    child.focus();
  }
}
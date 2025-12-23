
import {
  serial as polyfill,
  SerialPort as SerialPortPolyfill,
} from 'web-serial-polyfill';

const workerCtx = self;
export const serialBufferSize = 1024; // 1kB

export interface SerialMessageEvent {
  msg: MsgType;
  startParams?: { usePolyfill: boolean; baudRate: number };
  array?: Uint8Array;
}

let serial: Serial | typeof polyfill;
let port: SerialPort | SerialPortPolyfill | null;
let reader: ReadableStreamDefaultReader;
let writer: WritableStreamDefaultWriter;
let usePolyfill: boolean;
let baudRate: number;
let TXData: Uint8Array | null = null;

export enum MsgType {
  CONNECT = 1,
  CONNECTED,
  CONNECT_FAILED,
  DISCONNECT,
  DISCONNECTED,
  SERIAL_RX,
  SERIAL_TX,
}

// ugly, need to redo this using typed events for each MsgType
addEventListener('message', async (event: MessageEvent<SerialMessageEvent>) => {
  if (event.data.msg) {
    switch (event.data.msg) {
      case MsgType.CONNECT:
        console.log(event.data);
        if (!event.data.startParams) {
          console.error('Start parameters not found!');
          sendMessage({ msg: MsgType.CONNECT_FAILED });
          return;
        }
        usePolyfill = event.data.startParams.usePolyfill;
        console.log(`POLYFILL STATUS` + usePolyfill);
        baudRate = event.data.startParams.baudRate;
        connect();
        break;
      case MsgType.DISCONNECT:
        console.log(event.data);
        // TODO: clean up here
        break;
      case MsgType.SERIAL_TX:
        if (!event.data.array) {
          console.error('Array not found!');
          return;
        }
        TXData = event.data.array;
    }
  }
});

async function connect() {
  const options: SerialOptions = {
    baudRate: baudRate,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    flowControl: 'none',
    bufferSize: serialBufferSize,
  };
  serial = usePolyfill ? polyfill : navigator.serial;
  console.log(serial);
  try {
    const ports = await serial.getPorts();
    console.log(ports);
    port = ports[0];
  }
  catch (e) {
    if (e instanceof Error)
      console.error(`ERROR ${e.name}: ${e.message}`);
    sendMessage({ msg: MsgType.CONNECT_FAILED });
    return;
  }
  if (!port) {
    console.warn('A port was not selected');
    return;
  }
  try {
    await port.open(options);
  }
  catch (e) {
    console.error(e);
    if (e instanceof Error)
      console.error(`ERROR: ${e.message}`);
    sendMessage({ msg: MsgType.CONNECT_FAILED });
    return;
  }
  sendMessage({ msg: MsgType.CONNECTED });
  console.log('Port opened, obtaining stream');
  // TX loop
  (async () => {
    let inc: number = 0;
    setInterval(() => {
      //console.log(`inc` + inc);
    }, 1000);
    while (port.writable) {
      try {
        writer = port.writable.getWriter();
        while (true) {
          if (TXData !== null) {
            await writer.ready;
            await writer.write(TXData);
            inc++;
          }
          await new Promise(r => setTimeout(r, 10));
        }
      }
      catch (e) {
        console.error((e as Error).message);
      }
      finally {
        closePort();
      }
    }
  })();
  // RX loop
  (async () => {
    let value: Uint8Array | undefined;
    let done: boolean;
    while (port.readable) {
      try {
        reader = port.readable.getReader();
        while (true) {
          // Read from reader
          ({ value, done } = await reader.read());
          if (done) {
            console.info('Stream cancelled');
            break;
          }
          // Send data to main thread
          if (value) {
            //const text = new TextDecoder().decode(value);
            //console.log(text);
            sendMessage({ msg: MsgType.SERIAL_RX, array: value }, value.buffer);
          }
        }
      }
      catch (e) {
        console.error((e as Error).message);
      }
      finally {
        closePort();
      }
    }
  })();
}

async function closePort() {
  if (!port) {
    return;
  }
  if (reader) {
    await reader.cancel();
    reader.releaseLock();
  }
  if (writer) {
    await writer.close();
    writer.releaseLock();
  }
  await port.close();
  port = null;
  sendMessage({ msg: MsgType.DISCONNECTED });
}

/*
// These events are not supported by the polyfill.
// https://github.com/google/web-serial-polyfill/issues/20
if (!usePolyfill) {
  navigator.serial.addEventListener('connect', (event) => {
    const portOption = addNewPort(event.target as SerialPort);
    if (autoconnectCheckbox.checked) {
      portOption.selected = true;
      connectToPort();
    }
  });
  navigator.serial.addEventListener('disconnect', (event) => {
    const portOption = findPortOption(event.target as SerialPort);
    if (portOption) {
      portOption.remove();
    }
  });
}
*/

function sendMessage(args: SerialMessageEvent, transfer?: Transferable) {
  if (!transfer)
    workerCtx.postMessage(args);
  else
    workerCtx.postMessage(args, [transfer]);
}

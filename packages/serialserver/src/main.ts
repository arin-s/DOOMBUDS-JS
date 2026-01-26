import jpegjs from 'jpeg-js';
import fs from 'fs';
import path from 'path';
import prompts from 'prompts';
import { SerialPort } from 'serialport';
import { io, ManagerOptions, Socket, SocketOptions } from 'socket.io-client';
import { ClientToServerEvents, createKeyPacket, PacketType, processChunk, ServerToClientEvents } from 'common';
import { Muxer, Demuxer, Decoder, Encoder, HardwareContext } from 'node-av/api';
import { Codec, FilterAPI, FilterPreset, Frame, Log, Packet, FFEncoderCodec, AVHWDeviceType,
          AV_LOG_WARNING, AV_PIX_FMT_RGBA, AV_CODEC_ID_H264, AV_PIX_FMT_NV12 } from 'node-av';
import { createSign } from 'crypto';
import * as nodeavconst from 'node-av/constants';


// Load environment variables
try {
  process.loadEnvFile('../../.env');
}
catch (ignore) {
  // doesn't matter whether the env file loads or not
}
if (!process.env.FFMPEG_URL) {
  throw new Error('FFMPEG_URL environment variable not supplied!');
}
let WEBSERVER_URL = process.env.WEBSERVER_URL;
if (!WEBSERVER_URL) {
  console.warn('No webserver URL supplied, defaulting to http://127.0.0.1');
  WEBSERVER_URL = 'http://127.0.0.1';
}
let HTTP_PORT = '8080';
if (process.env.HTTP_PORT)
  HTTP_PORT = process.env.HTTP_PORT;

// Set av-node log level
Log.setLevel(AV_LOG_WARNING);

// global variables
const HW_DEVICE_MAP: Record<string, AVHWDeviceType> = {
  cuda: nodeavconst.AV_HWDEVICE_TYPE_CUDA,
  vdpau: nodeavconst.AV_HWDEVICE_TYPE_VDPAU,
  vaapi: nodeavconst.AV_HWDEVICE_TYPE_VAAPI,
  dxva2: nodeavconst.AV_HWDEVICE_TYPE_DXVA2,
  qsv: nodeavconst.AV_HWDEVICE_TYPE_QSV,
  videotoolbox: nodeavconst.AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
  d3d11va: nodeavconst.AV_HWDEVICE_TYPE_D3D11VA,
  drm: nodeavconst.AV_HWDEVICE_TYPE_DRM,
  opencl: nodeavconst.AV_HWDEVICE_TYPE_OPENCL,
  mediacodec: nodeavconst.AV_HWDEVICE_TYPE_MEDIACODEC,
  vulkan: nodeavconst.AV_HWDEVICE_TYPE_VULKAN,
  d3d12va: nodeavconst.AV_HWDEVICE_TYPE_D3D12VA,
  amf: nodeavconst.AV_HWDEVICE_TYPE_AMF,
  ohcodec: nodeavconst.AV_HWDEVICE_TYPE_OHCODEC,
  rkmpp: nodeavconst.AV_HWDEVICE_TYPE_RKMPP,
  none: nodeavconst.AV_HWDEVICE_TYPE_NONE,
};
const JPEGBuffer = Buffer.alloc(1000 * 1000 * 10); // kinda overkill
let input: Demuxer;
let decoder: Decoder;
let encoder: Encoder;
let output: Muxer;
let selectedDeviceType: AVHWDeviceType;
let selectedEncoderName: FFEncoderCodec;
let swFilter: FilterAPI;
let filter: FilterAPI;
let serialPort: SerialPort;
let startTime: number = 0;
let ffmpegMutex = false;
let videoOutputIndex: number;
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
    console.log('Creating demuxer...');
    input = await Demuxer.open({
      type: 'video',
      input: JPEGBuffer,
      width: 320,
      height: 200,
      pixelFormat: AV_PIX_FMT_RGBA,
      frameRate: { num: 30, den: 1 },
    });
    const videoStream = input.video();
    console.log('Creating decoder...');
    decoder = await Decoder.create(videoStream);
    // Init ffmpeg hw context
    if (!selectedDeviceType) {
      // don't use auto, still needs more time in the oven, select manually for now
      const availableHWContexts = HardwareContext.listAvailable();
      const hwContextChoices = availableHWContexts.map(ctx => ({ title: ctx, value: ctx }));
      const hwContextResponse = await prompts({
        type: 'select',
        name: 'hardwarecontext',
        message: 'Select hardware context',
        choices: hwContextChoices,
      });
      selectedDeviceType = HW_DEVICE_MAP[hwContextResponse.hardwarecontext];
    }
    const hw = HardwareContext.create(selectedDeviceType);
    if (!hw) {
      throw new Error('No hardware acceleration available!');
    }
    console.log(`Using user-selected hw device type: ${hw.deviceTypeName}`);
    // Get hardware codec
    if (!selectedEncoderName) {
      const hwCodecs: Codec[] = [];
      const hwCodecNames = hw.findSupportedCodecs(true) as FFEncoderCodec[];
      for (let hwCodecName of hwCodecNames) {
        let hwCodec = Codec.findEncoderByName(hwCodecName);
        let encoderTestResult = hw.testEncoder(AV_CODEC_ID_H264, hwCodec);
        if (encoderTestResult) {
          hwCodecs.push(hwCodec);
        }
      }
      const codecChoices = hwCodecs.map(codec => ({ title: codec.name, value: codec }));
      const codecResponse = await prompts({
        type: 'select',
        name: 'hardwarecodec',
        message: 'Select hardware codec',
        choices: codecChoices,
      });
      const selectedEncoder = codecResponse.hardwarecodec as Codec;
      selectedEncoderName = selectedEncoder.name as FFEncoderCodec;
    }
    const encoderCodec = Codec.findEncoderByName(selectedEncoderName);
    // Construct filters
    // Add a separate software scale filter since AMD doesn't like scaling
    const swFilterChain = FilterPreset.chain().scale(1280, 720).build();
    swFilter = FilterAPI.create(swFilterChain);
    const filterChain = FilterPreset.chain(hw).format(AV_PIX_FMT_NV12).hwupload().fps(30).build();
    console.log(`Creating filter: ${filterChain}`);
    filter = FilterAPI.create(filterChain, {
      hardware: hw,
    });
    // Create encoder
    console.log('Creating encoder...');
    encoder = await Encoder.create(encoderCodec, {
      bitrate: '3M',
      gopSize: 60,
      filter: filter,
    });
    // create output
    console.log('Creating output');
    output = Muxer.openSync(process.env.FFMPEG_URL, {
      format: 'flv',
    });
    videoOutputIndex = output.addStream(encoder);
    startTime = 0;
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
  if (input) {
    input.closeSync();
    input = null;
    console.log('Demuxer closed');
  }
  if (output) {
    output.closeSync();
    output = null;
    console.log('Muxer closed');
  }
  if (swFilter) {
    swFilter.close();
    swFilter = null;
    console.log('Software filter closed');
  }
  if (filter) {
    filter.close();
    filter = null;
    console.log('Hardware filter closed');
  }
  if (encoder) {
    encoder.close();
    encoder = null;
    console.log('Encoder closed');
  }
  if (decoder) {
    decoder.close();
    decoder = null;
    console.log('Decoder closed');
  }
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
      if(!webSocket.connected)
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
    //console.log(new TextDecoder().decode(packet.packetData));
  }
  if (packet.packetType === PacketType.PACKET_VIDEO) {
    if (ffmpegMutex) return;
    ffmpegMutex = true;
    try {
      //console.log(`Video Packet Size ${packet.packetData.byteLength}`);
      if (webSocket && webSocket.connected) {
        webSocket.emit('decodedPacket', packet);
        //console.log(`Emitting to client ${client.conn.remoteAddress}`);
      }
      let jpeg: jpegjs.BufferRet;
      //FFMPEG STUFF
      try {
        jpeg = jpegjs.decode(packet.packetData, { tolerantDecoding: true });
      } catch (e) {
        if (e instanceof Error)
          console.error(`${e.name}: ${e.message}`);
        return;
      }
      if (startTime === 0)
        startTime = Date.now();
      using frame = Frame.fromVideoBuffer(jpeg.data, {
        format: AV_PIX_FMT_RGBA,
        width: 320,
        height: 200,
        timeBase: { num: 1, den: 1000 },
        pts: BigInt(Date.now() - startTime),
      });
      // console.log(`${encoder.isReady()} ${encoder.isEncoderInitialized}, ${encoder.isEncoderOpen}`);
      // console.log(`${filter.isFilterInitialized} ${filter.isFilterOpen}`);
      await swFilter.process(frame);
      using swFrame = await swFilter.receive();
      if (swFrame) {
        await filter.process(swFrame);
        while (true) {
          using hwFrame = await filter.receive();
          if (!hwFrame) {
            break;
          }
          // console.log(`Encoding frame pts: ${filteredFrame.pts}`);
          await encoder.encode(hwFrame);
          while (true) {
            using encodedPacket = await encoder.receive();
            if (!encodedPacket) {
              break;
            }
            // console.log(`Got packet pts: ${encodedPacket.pts}`);
            if (encodedPacket instanceof Packet)
              await output.writePacket(encodedPacket, videoOutputIndex);
          }
        }
      }
    }
    catch (err) {
      if (err instanceof Error) {
        console.log(`serialData(): ${err.name} ${err.message}`);
        restart();
      }
    }
    finally {
      ffmpegMutex = false;
    }
    /* if (audioStream && (!packet || packet.streamIndex === audioStream.index)) {
      await output.writePacket(packet, outputAudioStreamIndex);
    } */
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

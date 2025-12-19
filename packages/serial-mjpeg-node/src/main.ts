import { Server, Socket } from 'socket.io';
import fs from 'fs';
import http from 'http';
import mime from 'mime-types';
import { SerialPort } from 'serialport';
import { ClientToServerEvents, createKeyPacket, PacketType, processChunk, ServerToClientEvents } from 'serial-mjpeg-common';
import { Muxer, Demuxer, Decoder, Encoder, HardwareContext } from 'node-av/api';
import { Codec, FilterAPI, FilterPreset, Frame, Log, Packet, PixelFormatUtils, FFEncoderCodec, AVHWDeviceType } from 'node-av';
import jpegjs from 'jpeg-js';
import prompts from 'prompts';
import {
  AV_HWDEVICE_TYPE_NONE,
  AV_HWDEVICE_TYPE_VDPAU,
  AV_HWDEVICE_TYPE_CUDA,
  AV_HWDEVICE_TYPE_VAAPI,
  AV_HWDEVICE_TYPE_DXVA2,
  AV_HWDEVICE_TYPE_QSV,
  AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
  AV_HWDEVICE_TYPE_D3D11VA,
  AV_HWDEVICE_TYPE_DRM,
  AV_HWDEVICE_TYPE_OPENCL,
  AV_HWDEVICE_TYPE_MEDIACODEC,
  AV_HWDEVICE_TYPE_VULKAN,
  AV_HWDEVICE_TYPE_D3D12VA,
  AV_HWDEVICE_TYPE_AMF,
  AV_HWDEVICE_TYPE_OHCODEC,
  AV_HWDEVICE_TYPE_RKMPP,
  AV_LOG_WARNING,
  AV_CODEC_ID_H264,
  AV_PIX_FMT_NV12,
  AV_PIX_FMT_RGBA,
} from 'node-av/constants';
try {
  process.loadEnvFile('../../.env');
}
catch (ignore) {
  // doesn't matter whether the env file loads or not
}
if (!process.env.FFMPEG_URL) {
  throw new Error('FFMPEG_URL environment variable not supplied!');
}

const HTTP_PORT = 8080;
let clients = new Map<String, Socket>();

// setup http server
const server = http.createServer((req, res) => {
  if (req.url === '/')
    req.url = '/index.html';
  fs.readFile('../serial-mjpeg-display/dist' + req.url, (err, data) => {
    console.log(req.url);
    if (err == null) {
      const mimeType = mime.lookup(req.url) ? <string>mime.lookup(req.url) : 'text/html';
      res.statusCode = 200;
      res.setHeader('Content-Type', mimeType);
      res.setHeader('DOOMBUDS-RELAY', 0);
      res.write(data);
    } else {
      res.writeHead(404);
    }
    res.end();
  });
});

// setup Socket.io server
const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents>(server, {
  cors: {
    // yeah just let em in
    origin: true,
  },
});

// set Socket.io events
io.on('connection', (client) => {
  console.log(`Client ${client.id} connected`);
  clients.set(client.id, client);
  // events
  client.on('keyState', (keyStateArray) => {
    serialPort.write(createKeyPacket(keyStateArray));
  });
  client.on('disconnect', (reason) => {
    console.log(`Client ${client.id} disconnected`);
    clients.delete(client.id);
  });
});

// start http server
server.listen(HTTP_PORT, 'localhost', () => {
  console.log(`Server running at http://localhost:${HTTP_PORT}/`);
});

Log.setLevel(AV_LOG_WARNING);

// Create mjpeg decoder
let JPEGBuffer: Buffer = Buffer.alloc(1000 * 1000 * 10); // overkill 10 mb buffer
console.log('Opening raw video input...');
let input = await Demuxer.open({
  type: 'video',
  input: JPEGBuffer,
  width: 320,
  height: 200,
  pixelFormat: AV_PIX_FMT_RGBA,
  frameRate: { num: 30, den: 1 },
});
const videoStream = input.video();
console.log('Creating decoder...');
const decoder = await Decoder.create(videoStream);

const HW_DEVICE_MAP: Record<string, AVHWDeviceType> = {
  cuda: AV_HWDEVICE_TYPE_CUDA,
  vdpau: AV_HWDEVICE_TYPE_VDPAU,
  vaapi: AV_HWDEVICE_TYPE_VAAPI,
  dxva2: AV_HWDEVICE_TYPE_DXVA2,
  qsv: AV_HWDEVICE_TYPE_QSV,
  videotoolbox: AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
  d3d11va: AV_HWDEVICE_TYPE_D3D11VA,
  drm: AV_HWDEVICE_TYPE_DRM,
  opencl: AV_HWDEVICE_TYPE_OPENCL,
  mediacodec: AV_HWDEVICE_TYPE_MEDIACODEC,
  vulkan: AV_HWDEVICE_TYPE_VULKAN,
  d3d12va: AV_HWDEVICE_TYPE_D3D12VA,
  amf: AV_HWDEVICE_TYPE_AMF,
  ohcodec: AV_HWDEVICE_TYPE_OHCODEC,
  rkmpp: AV_HWDEVICE_TYPE_RKMPP,
  none: AV_HWDEVICE_TYPE_NONE,
};

// init ffmpeg hw context
const available = HardwareContext.listAvailable();
const choices = available.map(ctx => ({ title: ctx, value: ctx }));

const response = await prompts({
  type: 'select',
  name: 'hardwarecontext',
  message: 'Select hardware context',
  choices: choices,
});

const selectedStr = response.hardwarecontext;
const selectedType = HW_DEVICE_MAP[selectedStr];

const hw = HardwareContext.create(selectedType);
if (!hw) {
  throw new Error('No hardware acceleration available! This example requires hardware acceleration for encoding.');
}
console.log(`SELECTED HW: ${hw.deviceTypeName}`)

// Identify hardware h264 codec
let hwCodecs: Codec[] = [];
let hwCodecNames = hw.findSupportedCodecs(true) as FFEncoderCodec[];
for (let hwCodecName of hwCodecNames) {
  let hwCodec = Codec.findEncoderByName(hwCodecName);
  let encoderWorks = hw.testEncoder(AV_CODEC_ID_H264, hwCodec);
  if (encoderWorks) {
    hwCodecs.push(hwCodec);
  }
}
const codecChoices = hwCodecs.map(codec => ({ title: codec.longName, value: codec }));
const codecResponse = await prompts({
  type: 'select',
  name: 'hardwarecodec',
  message: 'Select hardware codec',
  choices: codecChoices,
});
const encoderCodec = codecResponse.hardwarecodec;

// Construct filters
// Add a separate software scale filter since AMD doesn't like scaling
const swFilterChain = FilterPreset.chain().scale(1280, 720).build();
const swFilter = FilterAPI.create(swFilterChain);
const filterChain = FilterPreset.chain(hw).format(AV_PIX_FMT_NV12).hwupload().fps(30).build();
console.log(`Creating filter: ${filterChain}`);
const filter = FilterAPI.create(filterChain, {
  hardware: hw,
});

// Create encoder
console.log('Creating encoder...');
const encoder = await Encoder.create(encoderCodec, {
  bitrate: '3M',
  gopSize: 60,
  filter: filter,
});
// create output
console.log('Creating output');
let output = Muxer.openSync(process.env.FFMPEG_URL, {
  format: 'flv',
});

const videoOutputIndex = output.addStream(encoder);
// SIGINT handler
process.on('SIGINT', () => {
  console.log('Ctrl-C was pressed!');
  server.unref();
  server.close();
  console.log('HTTP Server closed');
  input.closeSync();
  console.log('Demuxer closed');
  output.closeSync();
  console.log('Muxer closed');
  encoder.close();
  console.log('Encoder closed');
  decoder.close();
  console.log('Decoder closed');
  process.exit(0);
});

// connect to earbud

const ports = await SerialPort.list();
const portChoices = ports.map(port => ({ title: port.path, value: port.path }));
const portResponse = await prompts({
  type: 'select',
  name: 'port',
  message: 'Select port',
  choices: portChoices,
});
const serialPort = new SerialPort({ path: portResponse.port, baudRate: 3000000 });
let startTime = 0;
let ffmpegMutex = false;
serialPort.on('data', async (chunk: Buffer) => {
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
      for (const client of clients.values()) {
        client.emit('decodedPacket', packet);
        //console.log(`Emitting to client ${client.conn.remoteAddress}`);
      }
      let jpeg: jpegjs.BufferRet;
      //FFMPEG STUFF
      try {
        jpeg = jpegjs.decode(packet.packetData);
      } catch (e) {
        if (e instanceof Error)
          console.error(`${e.name}: ${e.message}`);
        return;
      }
      if (startTime === 0) startTime = Date.now();
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
    } finally {
      ffmpegMutex = false;
    }
    /* if (audioStream && (!packet || packet.streamIndex === audioStream.index)) {
      await output.writePacket(packet, outputAudioStreamIndex);
    } */
  }
});
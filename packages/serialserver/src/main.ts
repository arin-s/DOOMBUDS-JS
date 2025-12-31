import jpegjs from 'jpeg-js';
import prompts from 'prompts';
import { SerialPort } from 'serialport';
import { io, Socket } from 'socket.io-client';
import { ClientToServerEvents, createKeyPacket, PacketType, processChunk, ServerToClientEvents } from 'common';
import { Muxer, Demuxer, Decoder, Encoder, HardwareContext } from 'node-av/api';
import { Codec, FilterAPI, FilterPreset, Frame, Log, Packet, PixelFormatUtils, FFEncoderCodec, AVHWDeviceType,
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

// Create decoder
let JPEGBuffer: Buffer = Buffer.alloc(1000 * 1000 * 10); // kinda overkill
console.log('Opening raw video input buffer...');
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

// Init ffmpeg hw context
const availableHWContexts = HardwareContext.listAvailable();
const hwContextChoices = availableHWContexts.map(ctx => ({ title: ctx, value: ctx }));
const hwContextResponse = await prompts({
  type: 'select',
  name: 'hardwarecontext',
  message: 'Select hardware context',
  choices: hwContextChoices,
});
const hwContextResponseStr = hwContextResponse.hardwarecontext;
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
const selectedDeviceType = HW_DEVICE_MAP[hwContextResponseStr];
const hw = HardwareContext.create(selectedDeviceType);
if (!hw) {
  throw new Error('No hardware acceleration available! This example requires hardware acceleration for encoding.');
}
console.log(`User-selected Device Type: ${hw.deviceTypeName}`);

// Get hardware codec
let hwCodecs: Codec[] = [];
let hwCodecNames = hw.findSupportedCodecs(true) as FFEncoderCodec[];
for (let hwCodecName of hwCodecNames) {
  let hwCodec = Codec.findEncoderByName(hwCodecName);
  let encoderTestResult = hw.testEncoder(AV_CODEC_ID_H264, hwCodec);
  if (encoderTestResult) {
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
      if (webServer) {
        webServer.emit('decodedPacket', packet);
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

const webServer: Socket<ClientToServerEvents, ServerToClientEvents> = io(`${WEBSERVER_URL}:${HTTP_PORT}/admin`);
webServer.on('keyState', (keyStateArray) => {
  const packet = createKeyPacket(keyStateArray);
  if (serialPort.isOpen)
    serialPort.write(packet);
});
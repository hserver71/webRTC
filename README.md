# RTP to WebRTC Streaming Server

A simple MVP server that receives RTP streams (from FFmpeg) and forwards them via WebRTC to browser clients.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Build mediasoup-client bundle:**
   ```bash
   npm run build-client
   ```
   This creates `public/mediasoup-client.min.js` for offline browser use.

## Usage

1. **Start the server:**
   ```bash
   npm start
   ```
   Server runs on port 3000.

2. **Stream video as RTP (in another terminal):**
   ```bash
   npm run stream
   ```
   Or for looping:
   ```bash
   npm run stream-loop
   ```

3. **Open browser:**
   - Go to `http://localhost:3000`
   - Click "Connect"
   - Click "Request Stream"
   - Video should appear

## Configuration

- **Server port:** 3000 (change `PORT` in `index.js`)
- **RTP port:** 5004 (change `RTP_PORT` in `index.js`)
- **Video file:** `public/output_live.mp4` (set `VIDEO_FILE` env var)

## Project Structure

- `index.js` - Main server (mediasoup, RTP receiver, WebSocket signaling)
- `public/index.html` - Browser client
- `public/mediasoup-client.min.js` - Bundled mediasoup-client (generated)
- `build-client.js` - Script to bundle mediasoup-client
- `stream-video.sh` - FFmpeg streaming script
- `stream-video-loop.sh` - FFmpeg streaming script (loop mode)

## How It Works

1. FFmpeg streams video as RTP to port 5004
2. Server receives RTP packets via UDP socket
3. mediasoup PlainTransport ingests RTP and creates Producer
4. Browser connects via WebSocket and creates WebRtcTransport
5. Server creates Consumer from Producer
6. Browser receives WebRTC stream and displays in `<video>` element


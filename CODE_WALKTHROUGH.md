# Code Walkthrough: Where Transport, Consumer, Track Appear

This document shows exactly where and how these concepts are used in your codebase.

---

## 1. TRANSPORT in Your Code

### Server-Side: PlainTransport (for RTP input)

**File:** `index.js`, lines 33-36

```javascript
async function createRtpReceiver(roomId, options = {}) {
    const room = await getOrCreateRoom(roomId);
    // 👇 THIS IS A TRANSPORT - receives RTP packets from FFmpeg
    const transport = await room.router.createPlainTransport({ 
        listenIp: { ip: '0.0.0.0' }, 
        rtcpMux: false 
    });
    // transport.tuple gives us the UDP port numbers
    const { localPort: rtpPort } = transport.tuple;
    const { localPort: rtcpPort } = transport.rtcpTuple;
    // ... rest of function
}
```

**What happens:**
- Creates a PlainTransport that listens for RTP packets
- Gets UDP port numbers from `transport.tuple`
- This transport will receive raw RTP from FFmpeg

---

### Server-Side: WebRtcTransport (for browser connections)

**File:** `index.js`, lines 78-82

```javascript
if (data.action === 'join') {
    const room = await getOrCreateRoom(data.roomId || 'default');
    // 👇 THIS IS A TRANSPORT - WebRTC connection to browser
    transport = await room.router.createWebRtcTransport({ 
        listenIps: [{ ip: '0.0.0.0', announcedIp: null }], 
        enableUdp: true, 
        enableTcp: true 
    });
    room.transports.set(transport.id, transport);
    // Send transport info to browser
    ws.send(JSON.stringify({ 
        action: 'transport-created', 
        transportId: transport.id, 
        iceParameters: transport.iceParameters,  // For NAT traversal
        iceCandidates: transport.iceCandidates,  // For NAT traversal
        dtlsParameters: transport.dtlsParameters // For encryption
    }));
}
```

**What happens:**
- Creates a WebRtcTransport when browser connects
- Gets ICE parameters (for NAT traversal) and DTLS parameters (for encryption)
- Sends these to the browser so it can create a matching transport

---

### Browser-Side: WebRtcTransport (matching the server)

**File:** `public/index.html`, lines 47-61

```javascript
if (data.action === 'transport-created') {
    device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: (await getRtpCapabilities()).rtpCapabilities });
    
    // 👇 THIS IS A TRANSPORT - matches the server's WebRtcTransport
    transport = device.createRecvTransport({
        id: data.transportId,              // Must match server
        iceParameters: data.iceParameters, // Must match server
        iceCandidates: data.iceCandidates, // Must match server
        dtlsParameters: data.dtlsParameters // Must match server
    });
    
    // 👇 When transport needs to connect, exchange DTLS parameters
    transport.on('connect', ({ dtlsParameters }, callback) => {
        log('Transport connecting...');
        pendingConnectCallback = callback;
        ws.send(JSON.stringify({ action: 'connect-transport', dtlsParameters }));
    });
    log('Transport ready');
}
```

**What happens:**
- Browser creates a matching WebRtcTransport using server's parameters
- Sets up connection handler to exchange DTLS parameters
- This establishes the encrypted WebRTC connection

---

### Transport Connection (DTLS handshake)

**File:** `index.js`, lines 86-88

```javascript
else if (data.action === 'connect-transport' && transport) {
    // 👇 Connect the transport using browser's DTLS parameters
    await transport.connect({ dtlsParameters: data.dtlsParameters });
    ws.send(JSON.stringify({ action: 'transport-connected' }));
}
```

**File:** `public/index.html`, lines 62-67

```javascript
else if (data.action === 'transport-connected') {
    if (pendingConnectCallback) {
        pendingConnectCallback();  // 👇 Completes the connection
        pendingConnectCallback = null;
        log('Transport connected');
    }
}
```

**What happens:**
- Browser sends its DTLS parameters to server
- Server connects its transport
- Server confirms connection
- Browser completes the connection
- Now the transport is ready to carry media!

---

## 2. PRODUCER in Your Code

**File:** `index.js`, lines 45-56

```javascript
rtpSocket.on('message', async (packet) => {
    packetCount++;
    if (!ssrc && packet.length >= 12) {
        ssrc = packet.readUInt32BE(8);  // Extract SSRC from RTP header
        console.log(`SSRC detected: ${ssrc}`);
        
        const codecParams = codec === 'H264' ? { 
            mimeType: 'video/H264', 
            payloadType, 
            clockRate, 
            parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f' } 
        } : { mimeType: `video/${codec}`, payloadType, clockRate };
        
        // 👇 THIS IS A PRODUCER - represents the RTP stream as a source
        producer = await transport.produce({ 
            kind: 'video', 
            rtpParameters: { 
                codecs: [codecParams], 
                headerExtensions: [], 
                encodings: [{ ssrc }],  // SSRC identifies this stream
                rtcp: { cname: `rtp-${ssrc}` } 
            } 
        });
        
        // Store producer so consumers can find it
        room.producers.set(producer.id, producer);
        room.producers.set(ssrc, producer);
        
        if (producer.paused) await producer.resume();
        console.log(`Producer created: ${producer.id}, SSRC: ${ssrc}`);
    }
    // Forward RTP packets to the transport
    if (producer && rtpPort) rtpForward.send(packet, rtpPort, '127.0.0.1', ...);
});
```

**What happens:**
1. RTP packet arrives from FFmpeg
2. Extract SSRC (stream identifier) from packet header
3. Create Producer with codec info and SSRC
4. Store Producer in room so it can be consumed
5. Producer is now available in the Router

**Key point:** Producer is created ONCE when first RTP packet arrives. It represents the entire stream.

---

## 3. CONSUMER in Your Code

### Server-Side: Creating Consumer

**File:** `index.js`, lines 89-102

```javascript
else if (data.action === 'consume' && transport) {
    const room = await getOrCreateRoom('default');
    
    // Find an available producer (wait up to 5 seconds)
    let producer = null;
    for (let i = 0; i < 50 && !producer; i++) {
        producer = Array.from(room.producers.values())
            .find(p => p.kind === 'video' && !p.closed);
        if (!producer) await new Promise(r => setTimeout(r, 100));
    }
    
    if (!producer) { 
        ws.send(JSON.stringify({ action: 'error', message: 'No producer available' })); 
        return; 
    }
    
    // 👇 THIS IS A CONSUMER - receives media from producer for this browser
    const consumer = await transport.consume({ 
        producerId: producer.id,                    // Which producer to consume
        rtpCapabilities: data.rtpCapabilities      // What browser supports
    });
    
    room.consumers.set(consumer.id, consumer);
    consumer._transportId = transport.id;  // Remember which transport
    
    if (consumer.paused) await consumer.resume();
    
    // Send consumer info to browser
    ws.send(JSON.stringify({ 
        action: 'consumer-created', 
        id: consumer.id, 
        producerId: producer.id, 
        kind: consumer.kind, 
        rtpParameters: consumer.rtpParameters  // Browser needs these
    }));
}
```

**What happens:**
1. Browser requests to consume a stream
2. Server finds an available Producer
3. Server creates Consumer attached to browser's Transport
4. Consumer gets RTP parameters optimized for this browser
5. Server sends consumer info to browser

**Key point:** Each browser gets its own Consumer, even if consuming the same Producer.

---

### Browser-Side: Creating Consumer

**File:** `public/index.html`, lines 68-76

```javascript
else if (data.action === 'consumer-created') {
    try {
        log('Creating consumer...');
        
        // 👇 THIS IS A CONSUMER - receives WebRTC stream from server
        consumer = await transport.consume({
            id: data.id,                    // Must match server
            producerId: data.producerId,    // Which producer
            kind: data.kind,                // 'video' or 'audio'
            rtpParameters: data.rtpParameters  // Must match server
        });
        
        // 👇 Consumer has a track property - this is the actual media!
        if (!consumer.track) {
            log('ERROR: Consumer has no track!');
            return;
        }
```

**What happens:**
1. Browser receives consumer info from server
2. Browser creates matching Consumer on its Transport
3. Consumer automatically gets a Track attached
4. Track contains the actual video/audio data

---

## 4. TRACK in Your Code

**File:** `public/index.html`, lines 77-89

```javascript
// 👇 THIS IS THE TRACK - the actual MediaStreamTrack
log(`Track: ${consumer.track.kind}, enabled: ${consumer.track.enabled}, readyState: ${consumer.track.readyState}`);

// Enable the track
consumer.track.enabled = true;

// Set up track event handlers
consumer.track.onmute = () => log('Track muted');
consumer.track.onunmute = () => log('Track unmuted');
consumer.track.onended = () => log('Track ended');

log(`Consumer: paused=${consumer.paused}, closed=${consumer.closed}`);

// 👇 Create MediaStream from the track
const stream = new MediaStream([consumer.track]);
log(`Stream tracks: ${stream.getTracks().length}`);

// 👇 Attach stream to video element
video.srcObject = stream;
```

**What happens:**
1. Consumer has a `track` property (MediaStreamTrack)
2. Enable the track so it can play
3. Set up event handlers for track state changes
4. Create MediaStream from the track
5. Attach MediaStream to `<video>` element
6. Video element displays the stream!

**Key point:** 
- `consumer` = mediasoup object (manages RTP, pause/resume, etc.)
- `consumer.track` = browser MediaStreamTrack (the actual media data)
- `MediaStream([track])` = wraps track for video element
- `video.srcObject = stream` = displays the video

---

## Complete Flow in Code Order

### 1. Server starts, creates PlainTransport
```javascript
// index.js:36
const transport = await room.router.createPlainTransport({ ... });
```

### 2. RTP packets arrive, Producer created
```javascript
// index.js:51
producer = await transport.produce({ kind: 'video', rtpParameters: { ... } });
```

### 3. Browser connects, WebRtcTransport created (server)
```javascript
// index.js:80
transport = await room.router.createWebRtcTransport({ ... });
```

### 4. Browser creates matching WebRtcTransport
```javascript
// index.html:50
transport = device.createRecvTransport({ ... });
```

### 5. Transport connects (DTLS handshake)
```javascript
// index.js:87
await transport.connect({ dtlsParameters: data.dtlsParameters });
```

### 6. Browser requests stream
```javascript
// index.html:154
ws.send(JSON.stringify({ action: 'consume', rtpCapabilities: device.rtpCapabilities }));
```

### 7. Server creates Consumer
```javascript
// index.js:97
const consumer = await transport.consume({ producerId: producer.id, ... });
```

### 8. Browser creates Consumer
```javascript
// index.html:71
consumer = await transport.consume({ id: data.id, ... });
```

### 9. Browser gets Track and displays it
```javascript
// index.html:87-89
const stream = new MediaStream([consumer.track]);
video.srcObject = stream;
```

---

## Summary Table

| Concept | Location | Purpose | Created When |
|---------|----------|---------|--------------|
| **PlainTransport** | `index.js:36` | Receives RTP from FFmpeg | Server startup |
| **Producer** | `index.js:51` | Represents RTP stream as source | First RTP packet |
| **WebRtcTransport (server)** | `index.js:80` | WebRTC connection to browser | Browser connects |
| **WebRtcTransport (browser)** | `index.html:50` | WebRTC connection to server | After server sends params |
| **Consumer (server)** | `index.js:97` | Routes media to browser | Browser requests stream |
| **Consumer (browser)** | `index.html:71` | Receives media from server | After server creates consumer |
| **Track** | `index.html:77` | Actual media data | Automatically with Consumer |
| **MediaStream** | `index.html:87` | Wraps track for video element | After Consumer created |
| **video.srcObject** | `index.html:89` | Displays the video | After stream created |

---

## Key Code Patterns

### Pattern 1: Transport Creation
```javascript
// Server creates transport
transport = await router.createWebRtcTransport({ ... });

// Server sends params to browser
ws.send({ transportId, iceParameters, iceCandidates, dtlsParameters });

// Browser creates matching transport
transport = device.createRecvTransport({ id, iceParameters, iceCandidates, dtlsParameters });
```

### Pattern 2: Consumer Creation
```javascript
// Server creates consumer
consumer = await transport.consume({ producerId, rtpCapabilities });

// Server sends consumer info to browser
ws.send({ id, producerId, kind, rtpParameters });

// Browser creates matching consumer
consumer = await transport.consume({ id, producerId, kind, rtpParameters });
```

### Pattern 3: Track Usage
```javascript
// Consumer automatically has a track
consumer.track.enabled = true;

// Create stream from track
const stream = new MediaStream([consumer.track]);

// Display in video element
video.srcObject = stream;
```

---

This shows exactly where each concept appears in your code and what it does!


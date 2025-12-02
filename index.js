const express = require('express');
const { createWorker } = require('mediasoup');
const { Server } = require('ws');
const dgram = require('dgram');
const path = require('path');

const PORT = 3000;
const RTP_PORT = 5004;
const app = express();
const wss = new Server({ server: app.listen(PORT, () => console.log(`Server running on port ${PORT}`)) });

let workers = [];
let rooms = new Map();

async function initWorkers() {
	const numWorkers = 1;
	for (let i = 0; i < numWorkers; i++) {
		const worker = await createWorker({ logLevel: 'warn', rtcMinPort: 40000, rtcMaxPort: 49999 });
		workers.push(worker);
	}
	console.log(`Created ${numWorkers} mediasoup workers`);
}

async function getOrCreateRoom(roomId) {
	if (!rooms.has(roomId)) {
		const worker = workers[0];
		const router = await worker.createRouter({ mediaCodecs: [{ kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f' } }] });
		rooms.set(roomId, { router, transports: new Map(), producers: new Map(), consumers: new Map() });
	}
	return rooms.get(roomId);
}

async function createRtpReceiver(roomId, options = {}) {
	const { listenPort = RTP_PORT, kind = 'video', codec = 'H264', payloadType = 96, clockRate = 90000 } = options;
	const room = await getOrCreateRoom(roomId);
	const transport = await room.router.createPlainTransport({ listenIp: { ip: '0.0.0.0' }, rtcpMux: false });
	const { localPort: rtpPort } = transport.tuple;
	const { localPort: rtcpPort } = transport.rtcpTuple;
	const rtpSocket = dgram.createSocket('udp4');
	const rtcpSocket = dgram.createSocket('udp4');
	const rtpForward = dgram.createSocket('udp4');
	const rtcpForward = dgram.createSocket('udp4');
	let producer = null, ssrc = null, packetCount = 0;

	rtpSocket.on('message', async (packet) => {
		packetCount++;
		if (!ssrc && packet.length >= 12) {
			ssrc = packet.readUInt32BE(8);
			console.log(`SSRC detected: ${ssrc}`);
			const codecParams = codec === 'H264' ? { mimeType: 'video/H264', payloadType, clockRate, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f' } } : { mimeType: `video/${codec}`, payloadType, clockRate };
			producer = await transport.produce({ kind, rtpParameters: { codecs: [codecParams], headerExtensions: [], encodings: [{ ssrc }], rtcp: { cname: `rtp-${ssrc}` } } });
			room.producers.set(producer.id, producer);
			room.producers.set(ssrc, producer);
			if (producer.paused) await producer.resume();
			console.log(`Producer created: ${producer.id}, SSRC: ${ssrc}`);
		}
		if (producer && rtpPort) rtpForward.send(packet, rtpPort, '127.0.0.1', (err) => { if (err && packetCount % 100 === 0) console.error(`RTP forward error: ${err.message}`); });
		if (packetCount % 500 === 0) console.log(`RTP: ${packetCount} packets, producer: ${producer ? producer.id : 'none'}`);
	});

	rtcpSocket.on('message', (packet) => { if (rtcpPort) rtcpForward.send(packet, rtcpPort, '127.0.0.1'); });

	await Promise.all([
		new Promise((resolve, reject) => rtpSocket.bind(listenPort, err => err ? reject(err) : resolve())),
		new Promise((resolve, reject) => rtcpSocket.bind(listenPort + 1, err => err ? reject(err) : resolve()))
	]);

	console.log(`RTP receiver listening on port ${listenPort}`);
	return { producer, transport };
}

app.use(express.static('public'));

wss.on('connection', (ws) => {
	let transport = null;
	ws.on('message', async (msg) => {
		const data = JSON.parse(msg);
		if (data.action === 'join') {
			const room = await getOrCreateRoom(data.roomId || 'default');
			transport = await room.router.createWebRtcTransport({ listenIps: [{ ip: '0.0.0.0', announcedIp: null }], enableUdp: true, enableTcp: true });
			room.transports.set(transport.id, transport);
			ws.send(JSON.stringify({ action: 'transport-created', transportId: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters }));
		} else if (data.action === 'get-rtp-capabilities') {
			const room = await getOrCreateRoom('default');
			ws.send(JSON.stringify({ action: 'rtp-capabilities', rtpCapabilities: room.router.rtpCapabilities }));
		} else if (data.action === 'connect-transport' && transport) {
			await transport.connect({ dtlsParameters: data.dtlsParameters });
			ws.send(JSON.stringify({ action: 'transport-connected' }));
		} else if (data.action === 'consume' && transport) {
			const room = await getOrCreateRoom('default');
			let producer = null;
			for (let i = 0; i < 50 && !producer; i++) {
				producer = Array.from(room.producers.values()).find(p => p.kind === 'video' && !p.closed);
				if (!producer) await new Promise(r => setTimeout(r, 100));
			}
			if (!producer) { ws.send(JSON.stringify({ action: 'error', message: 'No producer available' })); return; }
			const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: data.rtpCapabilities });
			room.consumers.set(consumer.id, consumer);
			// Store transport ID with consumer for later lookup
			consumer._transportId = transport.id;
			if (consumer.paused) await consumer.resume();
			ws.send(JSON.stringify({ action: 'consumer-created', id: consumer.id, producerId: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters }));
		} else if (data.action === 'resume-consumer' && transport) {
			const room = await getOrCreateRoom('default');
			const consumer = Array.from(room.consumers.values()).find(c => c._transportId === transport.id);
			if (consumer && consumer.paused) await consumer.resume();
			ws.send(JSON.stringify({ action: 'consumer-resumed' }));
		}
	});
});

(async () => {
	await initWorkers();
	await createRtpReceiver('default');
})();


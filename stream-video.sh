#!/bin/bash

VIDEO_FILE="${VIDEO_FILE:-public/output_live.mp4}"
RTP_HOST="${RTP_HOST:-127.0.0.1}"
RTP_PORT="${RTP_PORT:-5004}"

if [ ! -f "$VIDEO_FILE" ]; then
	echo "Error: Video file not found: $VIDEO_FILE"
	exit 1
fi

echo "Streaming $VIDEO_FILE to RTP://$RTP_HOST:$RTP_PORT"
echo "SDP file will be saved to /tmp/stream.sdp"

ffmpeg -re -i "$VIDEO_FILE" \
	-map 0:v:0 \
	-c:v libx264 \
	-preset ultrafast \
	-tune zerolatency \
	-profile:v baseline \
	-level 3.0 \
	-pix_fmt yuv420p \
	-r 30 \
	-g 30 \
	-b:v 2M \
	-maxrate 2M \
	-bufsize 4M \
	-an \
	-f rtp \
	-sdp_file /tmp/stream.sdp \
	"rtp://$RTP_HOST:$RTP_PORT?rtcpport=$(($RTP_PORT + 1))"


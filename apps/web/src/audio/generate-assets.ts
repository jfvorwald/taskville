// Synthesizes the four ambient loops (see ASSETS.md). Run from the repository root:
//
//   node apps/web/src/audio/generate-assets.ts
//
// Deterministic: a seeded generator and no clock, so re-running writes identical bytes. Each loop
// is mono, 16-bit, 11025 Hz and exactly LOOP_SECONDS long. Every tone has a whole number of
// cycles in the loop, and the filtered noise is made periodic, so the loop point is seamless. Levels are low; the backend plays them under the cues.

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 11025;
const LOOP_SECONDS = 8;
const N = RATE * LOOP_SECONDS;
const PEAK = 0.5;
const TAU = Math.PI * 2;

/** mulberry32: a small seeded generator. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A sine with a whole number of cycles per loop at `cycles / LOOP_SECONDS` Hz. */
const wave = (i: number, cycles: number, phase = 0) => Math.sin((TAU * cycles * i) / N + phase);

/**
 * White noise through a one-pole low-pass. The filter runs over three copies of the noise and the
 * middle one is kept, by which point its state has settled, so the loop's ends meet.
 */
function lowNoise(rand: () => number, cutoffHz: number): Float64Array {
  const raw = new Float64Array(N);
  for (let i = 0; i < N; i += 1) raw[i] = rand() * 2 - 1;
  const k = 1 - Math.exp((-TAU * cutoffHz) / RATE);
  const out = new Float64Array(N);
  let y = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    for (let i = 0; i < N; i += 1) {
      y += k * ((raw[i] ?? 0) - y);
      if (pass === 1) out[i] = y;
    }
  }
  return out;
}

/** Scales a signal so its peak is PEAK, and trims any residual DC offset. */
function normalize(signal: Float64Array): Float64Array {
  let mean = 0;
  for (const v of signal) mean += v;
  mean /= N;
  let max = 0;
  for (let i = 0; i < N; i += 1) {
    signal[i] = (signal[i] ?? 0) - mean;
    max = Math.max(max, Math.abs(signal[i] ?? 0));
  }
  const scale = max === 0 ? 0 : PEAK / max;
  for (let i = 0; i < N; i += 1) signal[i] = (signal[i] ?? 0) * scale;
  return signal;
}

/** Low city hum: a 55 Hz fundamental with two overtones, breathing slowly, over faint rumble. */
function cyberpunk(): Float64Array {
  const rumble = lowNoise(random(101), 180);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    const breath = 0.8 + 0.2 * wave(i, 1);
    out[i] =
      breath * (wave(i, 440) + 0.5 * wave(i, 880, 0.6) + 0.25 * wave(i, 1321, 1.3)) +
      6 * (rumble[i] ?? 0);
  }
  return normalize(out);
}

/** Clock ticks twice a second, alternating tick and tock, over a soft steam bed. */
function steampunk(): Float64Array {
  const bed = lowNoise(random(202), 500);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i += 1) out[i] = 4 * (bed[i] ?? 0);
  const beats = LOOP_SECONDS * 2;
  const tickLength = Math.floor(RATE * 0.05);
  for (let b = 0; b < beats; b += 1) {
    const start = Math.floor((b * N) / beats);
    const pitch = b % 2 === 0 ? 1500 : 1100;
    for (let j = 0; j < tickLength && start + j < N; j += 1) {
      const envelope = Math.exp((-j / tickLength) * 7);
      out[start + j] = (out[start + j] ?? 0) + 0.9 * envelope * Math.sin((TAU * pitch * j) / RATE);
    }
  }
  return normalize(out);
}

/** Wind that swells and falls, with a few birdlike chirps. */
function solarpunk(): Float64Array {
  const rand = random(303);
  const wind = lowNoise(rand, 700);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    const gust = 0.55 + 0.3 * wave(i, 1) + 0.15 * wave(i, 2, 1);
    out[i] = 6 * gust * (wind[i] ?? 0);
  }
  const chirpLength = Math.floor(RATE * 0.16);
  const chirps = 5;
  for (let c = 0; c < chirps; c += 1) {
    const start = Math.floor(((c + 0.2 + rand() * 0.6) * (N - chirpLength)) / chirps);
    const base = 1800 + rand() * 1400;
    for (let j = 0; j < chirpLength; j += 1) {
      const t = j / chirpLength;
      const envelope = Math.sin(Math.PI * t) ** 2;
      const freq = base * (1 + 0.45 * t);
      out[start + j] = (out[start + j] ?? 0) + 0.35 * envelope * Math.sin((TAU * freq * j) / RATE);
    }
  }
  return normalize(out);
}

/** A soft pad: a slightly detuned major chord, each voice swelling on its own slow cycle. */
function aero(): Float64Array {
  // Cycles per loop for 220, 277.5, 330 and 440 Hz, with a second voice a hair sharp.
  const voices = [
    [1760, 0],
    [1761, 0.5],
    [2220, 1.1],
    [2221, 1.9],
    [2640, 2.4],
    [2641, 0.2],
    [3520, 1.5],
  ] as const;
  const out = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    let sum = 0;
    voices.forEach(([cycles, phase], v) => {
      const swell = 0.65 + 0.35 * wave(i, 1 + (v % 2), phase);
      sum += swell * wave(i, cycles, phase);
    });
    out[i] = sum;
  }
  return normalize(out);
}

/** A 16-bit mono PCM WAV file. */
function encodeWav(signal: Float64Array): Buffer {
  const dataBytes = N * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(RATE, 24);
  buffer.writeUInt32LE(RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < N; i += 1) {
    const sample = Math.round(Math.max(-1, Math.min(1, signal[i] ?? 0)) * 32767);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}

const LOOPS: Record<string, () => Float64Array> = { cyberpunk, steampunk, solarpunk, aero };

/** One loop's WAV bytes. Pure: nothing is written, so importing this module is safe. */
export function buildLoopWav(themeId: string): Buffer {
  const make = LOOPS[themeId];
  if (!make) throw new Error(`no ambient loop for theme "${themeId}"`);
  return encodeWav(make());
}

// Write the files only when run as a script, never when imported.
const scriptPath = process.argv[1];
if (scriptPath !== undefined && fileURLToPath(import.meta.url) === resolve(scriptPath)) {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const themeId of Object.keys(LOOPS)) {
    const file = join(dir, `ambient-${themeId}.wav`);
    const bytes = buildLoopWav(themeId);
    writeFileSync(file, bytes);
    console.log(`${file} ${bytes.length} bytes`);
  }
}

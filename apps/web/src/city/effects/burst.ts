import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
} from "three";
import { createParticlePool } from "./pool.ts";

// One pooled particle burst: an instanced mesh whose slots come from a `ParticlePool`. Everything
// is allocated here, once; `emit` and `update` touch only preallocated arrays and one scratch object.

export interface BurstOptions {
  readonly capacity: number;
  readonly lifetimeMs: number;
  /** Launch speed in m/s. */
  readonly speed: number;
  /** Edge of a particle at birth, in meters. */
  readonly size: number;
  /** Downward pull in m/s squared. */
  readonly gravity: number;
  readonly colors: readonly string[];
}

export interface Burst {
  readonly mesh: InstancedMesh;
  /** Starts up to `count` particles at (x, y, z); returns how many got a slot. */
  emit(x: number, y: number, z: number, count: number, nowMs: number): number;
  update(nowMs: number): void;
  dispose(): void;
}

const scratch = new Object3D();
const color = new Color();

export function createBurst(options: BurstOptions): Burst {
  const { capacity, lifetimeMs, speed, size, gravity, colors } = options;
  const pool = createParticlePool({ capacity, lifetimeMs });
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshBasicMaterial({ transparent: true, depthWrite: false });
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.visible = false;
  // Every slot starts hidden and white; `emit` colors a slot when it starts.
  scratch.position.set(0, 0, 0);
  scratch.scale.setScalar(0);
  scratch.updateMatrix();
  for (let i = 0; i < capacity; i += 1) {
    mesh.setMatrixAt(i, scratch.matrix);
    mesh.setColorAt(i, color.set("#ffffff"));
  }

  const origin = new Float32Array(capacity * 3);
  const velocity = new Float32Array(capacity * 3);
  const wasActive = new Uint8Array(capacity);
  let live = false;

  return {
    mesh,
    emit(x, y, z, count, nowMs) {
      for (let i = 0; i < capacity; i += 1) wasActive[i] = pool.isActive(i, nowMs) ? 1 : 0;
      const started = pool.spawn(count, nowMs);
      for (let i = 0; i < capacity; i += 1) {
        if (wasActive[i] === 1 || !pool.isActive(i, nowMs)) continue;
        const angle = Math.random() * Math.PI * 2;
        const spread = Math.random() * speed * 0.7;
        origin[i * 3] = x;
        origin[i * 3 + 1] = y;
        origin[i * 3 + 2] = z;
        velocity[i * 3] = Math.cos(angle) * spread;
        velocity[i * 3 + 1] = speed * (0.6 + Math.random() * 0.6);
        velocity[i * 3 + 2] = Math.sin(angle) * spread;
        mesh.setColorAt(i, color.set(colors[i % colors.length] ?? "#ffffff"));
      }
      if (started > 0 && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (started > 0) live = true;
      return started;
    },
    update(nowMs) {
      if (!live) return;
      let active = 0;
      for (let i = 0; i < capacity; i += 1) {
        if (pool.isActive(i, nowMs)) {
          active += 1;
          const age = (nowMs - pool.startedAt(i)) / 1000;
          const left = 1 - (age * 1000) / lifetimeMs;
          scratch.position.set(
            (origin[i * 3] ?? 0) + (velocity[i * 3] ?? 0) * age,
            (origin[i * 3 + 1] ?? 0) + (velocity[i * 3 + 1] ?? 0) * age - 0.5 * gravity * age * age,
            (origin[i * 3 + 2] ?? 0) + (velocity[i * 3 + 2] ?? 0) * age,
          );
          scratch.rotation.set(age * 7 + i, age * 5, 0);
          scratch.scale.setScalar(size * Math.max(left, 0));
        } else {
          scratch.position.set(0, 0, 0);
          scratch.scale.setScalar(0);
        }
        scratch.updateMatrix();
        mesh.setMatrixAt(i, scratch.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = active > 0;
      if (active === 0) live = false;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}

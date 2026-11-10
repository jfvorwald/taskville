import { useMemo } from "react";
import { BoxGeometry } from "three";
import type { BreakProp, CityLayout } from "../layout/index.ts";
import { Instances, type InstanceTransform } from "./Instances.tsx";
import type { CityMaterials } from "./materials.ts";

const COUNTER_HEIGHT = 1.0;
const STOOL_HEIGHT = 0.6;
const BENCH_HEIGHT = 0.5;
const LAMP_POLE_HEIGHT = 2.0;
const LAMP_HEAD_SIZE = 0.3;

type Kind = BreakProp["kind"];

/** The bar counter and stools, the smoke corner bench and lamp, one instanced mesh per shape. */
export function BreakProps({
  layout,
  materials,
}: {
  layout: CityLayout;
  materials: CityMaterials;
}) {
  const { geometry, items } = useMemo(() => {
    const props = layout.breakSites.flatMap((s) => s.props);
    const ofKind = (kind: Kind) => props.filter((p) => p.kind === kind);
    const box = (kind: Kind, height: number) => {
      const first = ofKind(kind)[0];
      return new BoxGeometry((first?.halfX ?? 0) * 2, height, (first?.halfZ ?? 0) * 2);
    };
    const place = (kind: Kind, height: number): InstanceTransform[] =>
      ofKind(kind).map((p) => ({ x: p.x, y: height / 2, z: p.z }));
    return {
      geometry: {
        counter: box("counter", COUNTER_HEIGHT),
        stool: box("stool", STOOL_HEIGHT),
        bench: box("bench", BENCH_HEIGHT),
        pole: box("lamp", LAMP_POLE_HEIGHT),
        head: new BoxGeometry(LAMP_HEAD_SIZE, LAMP_HEAD_SIZE, LAMP_HEAD_SIZE),
      },
      items: {
        counters: place("counter", COUNTER_HEIGHT),
        stools: place("stool", STOOL_HEIGHT),
        benches: place("bench", BENCH_HEIGHT),
        poles: place("lamp", LAMP_POLE_HEIGHT),
        heads: ofKind("lamp").map((p) => ({
          x: p.x,
          y: LAMP_POLE_HEIGHT + LAMP_HEAD_SIZE / 2,
          z: p.z,
        })),
      },
    };
  }, [layout]);
  return (
    <group name="break-props" matrixAutoUpdate={false}>
      <Instances
        geometry={geometry.counter}
        material={materials.lambert.barCounter}
        items={items.counters}
      />
      <Instances
        geometry={geometry.stool}
        material={materials.lambert.barStool}
        items={items.stools}
      />
      <Instances
        geometry={geometry.bench}
        material={materials.lambert.smokeBench}
        items={items.benches}
      />
      <Instances
        geometry={geometry.pole}
        material={materials.lambert.lampPole}
        items={items.poles}
      />
      <Instances geometry={geometry.head} material={materials.lampGlow} items={items.heads} />
    </group>
  );
}

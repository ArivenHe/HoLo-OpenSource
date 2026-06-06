import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Grid, OrbitControls, Text } from '@react-three/drei';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useGameStore } from '../store/useGameStore';
import type { BoxEntity, CameraSettings, Direction, PlayerEntity, StaticMap, Vec2 } from '../types/game';

const CELL_SIZE = 0.86;

function toWorld(map: StaticMap, position: Vec2, y = 0) {
  return new THREE.Vector3(
    (position.x - (map.width - 1) / 2) * CELL_SIZE,
    y,
    (position.y - (map.height - 1) / 2) * CELL_SIZE,
  );
}

function useKeyboardControls() {
  const sendMove = useGameStore((state) => state.sendMove);

  useEffect(() => {
    if (window.location.pathname === '/spectator') return;

    const keyMap: Record<string, Direction> = {
      ArrowUp: 'up',
      KeyW: 'up',
      w: 'up',
      W: 'up',
      ArrowDown: 'down',
      KeyS: 'down',
      s: 'down',
      S: 'down',
      ArrowLeft: 'left',
      KeyA: 'left',
      a: 'left',
      A: 'left',
      ArrowRight: 'right',
      KeyD: 'right',
      d: 'right',
      D: 'right',
    };
    const pressed = new Set<Direction>();

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typingTarget =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      const visibleTypingTarget = typingTarget && target.offsetParent !== null;
      if (visibleTypingTarget) return;

      const direction = keyMap[event.code] ?? keyMap[event.key];
      if (!direction) return;
      event.preventDefault();
      pressed.add(direction);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const direction = keyMap[event.code] ?? keyMap[event.key];
      if (!direction) return;
      event.preventDefault();
      pressed.delete(direction);
    };

    const clearPressed = () => pressed.clear();
    const timer = window.setInterval(() => {
      const delta = {
        x: Number(pressed.has('right')) - Number(pressed.has('left')),
        y: Number(pressed.has('down')) - Number(pressed.has('up')),
      };

      if (delta.x !== 0 || delta.y !== 0) sendMove(delta);
    }, 115);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', clearPressed);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', clearPressed);
    };
  }, [sendMove]);
}

function InstancedStaticTiles({ map, kind }: { map: StaticMap; kind: 'floor' | 'wall' }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const positions = useMemo(() => {
    const wallSet = new Set(map.walls.map(([x, y]) => `${x}:${y}`));
    const result: Vec2[] = [];

    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const isWall = wallSet.has(`${x}:${y}`);
        if (kind === 'wall' && isWall) result.push({ x, y });
        if (kind === 'floor' && !isWall) result.push({ x, y });
      }
    }

    return result;
  }, [kind, map]);

  useLayoutEffect(() => {
    positions.forEach((position, index) => {
      const world = toWorld(map, position, kind === 'wall' ? 0.45 : -0.06);
      dummy.position.copy(world);
      dummy.scale.set(1, kind === 'wall' ? 0.95 : 0.08, 1);
      dummy.updateMatrix();
      meshRef.current?.setMatrixAt(index, dummy.matrix);
    });

    if (meshRef.current) meshRef.current.instanceMatrix.needsUpdate = true;
  }, [dummy, kind, map, positions]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, positions.length]} castShadow={kind === 'wall'} receiveShadow>
      <boxGeometry args={[CELL_SIZE * 0.95, CELL_SIZE, CELL_SIZE * 0.95]} />
      <meshStandardMaterial
        color={kind === 'wall' ? '#23314b' : '#111827'}
        emissive={kind === 'wall' ? '#0f3c5c' : '#061521'}
        emissiveIntensity={kind === 'wall' ? 0.62 : 0.28}
        metalness={0.45}
        roughness={0.38}
      />
    </instancedMesh>
  );
}

function BaseTiles({ map }: { map: StaticMap }) {
  return (
    <>
      {map.bases.map((base) => (
        <BaseInstanced key={base.id} map={map} cells={base.cells} color={base.color} />
      ))}
    </>
  );
}

function BaseInstanced({ map, cells, color }: { map: StaticMap; cells: Vec2[]; color: string }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useLayoutEffect(() => {
    cells.forEach((position, index) => {
      const world = toWorld(map, position, 0.01);
      dummy.position.copy(world);
      dummy.rotation.x = -Math.PI / 2;
      dummy.updateMatrix();
      meshRef.current?.setMatrixAt(index, dummy.matrix);
    });
    if (meshRef.current) meshRef.current.instanceMatrix.needsUpdate = true;
  }, [cells, dummy, map]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, cells.length]} receiveShadow>
      <planeGeometry args={[CELL_SIZE * 0.86, CELL_SIZE * 0.86]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} transparent opacity={0.42} />
    </instancedMesh>
  );
}

function BoxesInstanced({ map, boxes }: { map: StaticMap; boxes: BoxEntity[] }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colors = useMemo(() => boxes.map((box) => new THREE.Color(box.color)), [boxes]);
  const positionsRef = useRef(new Map<string, THREE.Vector3>());

  useFrame((_, delta) => {
    boxes.forEach((box, index) => {
      const current = positionsRef.current.get(box.id) ?? toWorld(map, box, 0.5);
      const target = toWorld(map, box, 0.5);
      current.lerp(target, Math.min(1, delta * 12));
      positionsRef.current.set(box.id, current);
      dummy.position.copy(current);
      dummy.rotation.y = (index % 4) * 0.03;
      dummy.updateMatrix();
      meshRef.current?.setMatrixAt(index, dummy.matrix);
      meshRef.current?.setColorAt(index, colors[index]);
    });

    if (meshRef.current) {
      meshRef.current.instanceMatrix.needsUpdate = true;
      if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
    }
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, boxes.length]} castShadow receiveShadow>
      <boxGeometry args={[CELL_SIZE * 0.74, CELL_SIZE * 0.74, CELL_SIZE * 0.74]} />
      <meshPhysicalMaterial metalness={0.72} roughness={0.18} clearcoat={0.7} emissiveIntensity={0.6} />
    </instancedMesh>
  );
}

function PlayersInstanced({ map, players, selfId }: { map: StaticMap; players: PlayerEntity[]; selfId: string | null }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colors = useMemo(() => players.map((player) => new THREE.Color(player.color)), [players]);
  const positionsRef = useRef(new Map<string, THREE.Vector3>());

  useFrame((_, delta) => {
    players.forEach((player, index) => {
      const current = positionsRef.current.get(player.id) ?? toWorld(map, player, 0.55);
      const target = toWorld(map, player, 0.55);
      current.lerp(target, Math.min(1, delta * 14));
      positionsRef.current.set(player.id, current);
      dummy.position.copy(current);
      dummy.scale.setScalar(player.id === selfId ? 1.25 : 1);
      dummy.updateMatrix();
      meshRef.current?.setMatrixAt(index, dummy.matrix);
      meshRef.current?.setColorAt(index, colors[index]);
    });

    if (meshRef.current) {
      meshRef.current.instanceMatrix.needsUpdate = true;
      if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
    }
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, players.length]} castShadow>
      <capsuleGeometry args={[0.22, 0.46, 6, 14]} />
      <meshStandardMaterial metalness={0.55} roughness={0.22} emissiveIntensity={0.55} />
    </instancedMesh>
  );
}

function SelfMarker({ map, players, selfId }: { map: StaticMap; players: PlayerEntity[]; selfId: string | null }) {
  const groupRef = useRef<THREE.Group>(null);
  const currentRef = useRef<THREE.Vector3 | null>(null);
  const self = players.find((player) => player.id === selfId);

  useFrame((_, delta) => {
    if (!self || !groupRef.current) return;

    const target = toWorld(map, self, 0.12);
    const current = currentRef.current ?? target.clone();
    current.lerp(target, Math.min(1, delta * 14));
    currentRef.current = current;
    groupRef.current.position.copy(current);
    groupRef.current.rotation.y += delta * 1.6;
  });

  if (!self) return null;

  return (
    <group ref={groupRef}>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.48, 0.035, 8, 48]} />
        <meshBasicMaterial color={self.color} transparent opacity={0.95} />
      </mesh>
      <mesh position={[0, 0.72, 0]}>
        <cylinderGeometry args={[0.12, 0.22, 1.35, 18]} />
        <meshBasicMaterial color={self.color} transparent opacity={0.28} depthWrite={false} />
      </mesh>
    </group>
  );
}

function PlayerNameLabel({
  map,
  player,
  selfId,
}: {
  map: StaticMap;
  player: PlayerEntity;
  selfId: string | null;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const currentRef = useRef<THREE.Vector3 | null>(null);
  const isSelf = player.id === selfId;

  useFrame(({ camera }, delta) => {
    if (!groupRef.current) return;

    const target = toWorld(map, player, isSelf ? 1.72 : 1.5);
    const current = currentRef.current ?? target.clone();
    current.lerp(target, Math.min(1, delta * 14));
    currentRef.current = current;
    groupRef.current.position.copy(current);
    groupRef.current.quaternion.copy(camera.quaternion);
  });

  return (
    <group ref={groupRef}>
      <Text
        fontSize={isSelf ? 0.34 : 0.28}
        color="#f8fafc"
        anchorX="center"
        anchorY="middle"
        outlineColor={player.color}
        outlineWidth={isSelf ? 0.055 : 0.04}
        renderOrder={30}
      >
        {player.name}
      </Text>
    </group>
  );
}

function PlayerNameLabels({ map, players, selfId }: { map: StaticMap; players: PlayerEntity[]; selfId: string | null }) {
  return (
    <>
      {players.map((player) => (
        <PlayerNameLabel key={player.id} map={map} player={player} selfId={selfId} />
      ))}
    </>
  );
}

function Labels({ map }: { map: StaticMap }) {
  const spectator = window.location.pathname === '/spectator';
  if (!spectator) return null;

  return (
    <>
      {map.bases.map((base) => {
        const center = base.cells[Math.floor(base.cells.length / 2)];
        const world = toWorld(map, center, 0.08);
        return (
          <Text
            key={base.id}
            position={[world.x, world.y, world.z]}
            rotation={[-Math.PI / 2, 0, 0]}
            fontSize={0.8}
            color="#ffffff"
            anchorX="center"
            anchorY="middle"
            outlineColor="#020617"
            outlineWidth={0.04}
          >
            {base.name}
          </Text>
        );
      })}
    </>
  );
}

function FollowCamera({
  map,
  players,
  selfId,
  cameraSettings,
}: {
  map: StaticMap;
  players: PlayerEntity[];
  selfId: string | null;
  cameraSettings: CameraSettings;
}) {
  const lookTargetRef = useRef(new THREE.Vector3());

  useFrame(({ camera, clock }, delta) => {
    const player = players.find((item) => item.id === selfId);
    if (!player) return;

    const target = toWorld(map, player, 0.72);
    const desiredPosition = target.clone().add(new THREE.Vector3(0, cameraSettings.height, cameraSettings.distance));
    if (cameraSettings.shake > 0) {
      const elapsed = clock.getElapsedTime();
      const amplitude = cameraSettings.shake * 0.18;
      desiredPosition.x += Math.sin(elapsed * 19) * amplitude;
      desiredPosition.z += Math.cos(elapsed * 17) * amplitude;
    }
    const positionAlpha = Math.min(1, delta * 5.5);
    const targetAlpha = Math.min(1, delta * 9);

    if (camera.position.distanceTo(desiredPosition) > 28) {
      camera.position.copy(desiredPosition);
      lookTargetRef.current.copy(target);
    } else {
      camera.position.lerp(desiredPosition, positionAlpha);
      lookTargetRef.current.lerp(target, targetAlpha);
    }

    camera.lookAt(lookTargetRef.current);
  });

  return null;
}

function Scene() {
  const map = useGameStore((state) => state.map);
  const boxes = useGameStore((state) => state.state.boxes);
  const players = useGameStore((state) => state.state.players);
  const selfId = useGameStore((state) => state.selfId);
  const cameraSettings = useGameStore((state) => state.cameraSettings);
  const spectator = window.location.pathname === '/spectator';

  if (!map) return null;

  return (
    <>
      <ambientLight intensity={0.78} />
      <hemisphereLight args={['#dbeafe', '#0f172a', 1.2]} />
      <directionalLight castShadow color="#dbeafe" intensity={3.2} position={[10, 22, 12]} />
      <pointLight color="#22d3ee" intensity={18} distance={35} position={[0, 8, 0]} />
      <Grid
        args={[map.width * CELL_SIZE, map.height * CELL_SIZE]}
        cellSize={CELL_SIZE}
        cellThickness={0.12}
        cellColor="#334155"
        sectionColor="#64748b"
        sectionThickness={0.36}
        fadeDistance={58}
        fadeStrength={0.35}
        infiniteGrid={false}
        position={[0, -0.015, 0]}
      />
      <InstancedStaticTiles map={map} kind="floor" />
      <InstancedStaticTiles map={map} kind="wall" />
      <BaseTiles map={map} />
      <BoxesInstanced map={map} boxes={boxes} />
      <PlayersInstanced map={map} players={players} selfId={selfId} />
      {!spectator ? <SelfMarker map={map} players={players} selfId={selfId} /> : null}
      <PlayerNameLabels map={map} players={players} selfId={selfId} />
      <Labels map={map} />
      {!spectator ? <FollowCamera map={map} players={players} selfId={selfId} cameraSettings={cameraSettings} /> : null}
      <ContactShadows opacity={0.35} scale={46} blur={2.5} far={8} resolution={1024} />
      {spectator ? (
        <OrbitControls
          enablePan
          enableZoom
          minDistance={28}
          maxDistance={68}
          maxPolarAngle={Math.PI / 2.18}
          minPolarAngle={0.08}
          target={[0, 0, 0]}
        />
      ) : null}
    </>
  );
}

export function GameCanvas() {
  useKeyboardControls();
  const spectator = window.location.pathname === '/spectator';

  return (
    <Canvas
      className="game-canvas"
      camera={{ position: spectator ? [0, 56, 0.1] : [0, 15.5, 6.2], fov: spectator ? 42 : 50 }}
      dpr={[1, 1.6]}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      shadows
    >
      <color attach="background" args={['#050a16']} />
      <fog attach="fog" args={['#050a16', 48, 95]} />
      <Suspense fallback={null}>
        <Scene />
      </Suspense>
    </Canvas>
  );
}

import { Canvas, useFrame } from '@react-three/fiber'
import { Float, OrbitControls, Sparkles, Stars } from '@react-three/drei'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Phase } from '../lib/types'

const R = 2.6 // 드럼 반지름
const BALL = 0.11
const MAX_BALLS = 320

const PHASE_COLOR: Record<Phase, string> = {
  [Phase.Open]: '#4ff0e6',
  [Phase.Drawing]: '#ff9a3c',
  [Phase.Resolved]: '#ffd166',
}

interface SceneProps {
  phase: Phase
  ticketCount: number
  myTickets: number
  celebrate: boolean
}

/** 티켓 = 드럼 안을 떠다니는 공. 추첨 중엔 소용돌이, 확정되면 황금 공이 떠오른다. */
function Balls({ phase, ticketCount, myTickets }: SceneProps) {
  const mesh = useRef<THREE.InstancedMesh>(null!)
  const count = Math.min(ticketCount, MAX_BALLS)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const store = useMemo(() => {
    const pos: THREE.Vector3[] = []
    const vel: THREE.Vector3[] = []
    for (let i = 0; i < MAX_BALLS; i++) {
      pos.push(new THREE.Vector3().randomDirection().multiplyScalar(Math.random() * (R - BALL * 2)))
      vel.push(new THREE.Vector3().randomDirection().multiplyScalar(0.4 + Math.random() * 0.6))
    }
    return { pos, vel }
  }, [])

  // 색: 내 티켓은 금색, 나머지는 시안↔보라 그라데이션
  useEffect(() => {
    if (!mesh.current) return
    const c = new THREE.Color()
    for (let i = 0; i < MAX_BALLS; i++) {
      const mine = i >= count - myTickets && i < count
      if (mine) c.set('#ffd166').multiplyScalar(1.4)
      else c.setHSL(0.5 + ((i * 0.13) % 0.25), 1, 0.62).multiplyScalar(1.25)
      mesh.current.setColorAt(i, c)
    }
    mesh.current.instanceColor!.needsUpdate = true
  }, [count, myTickets])

  useFrame((_, dt) => {
    const m = mesh.current
    if (!m) return
    const speed = phase === Phase.Drawing ? 7 : phase === Phase.Resolved ? 0.6 : 3
    const swirl = phase === Phase.Drawing ? 10 : 2.2
    const turbulence = phase === Phase.Drawing ? 6 : 1.8
    for (let i = 0; i < count; i++) {
      const p = store.pos[i]
      const v = store.vel[i]
      // 난기류 + 중력 + 바닥 송풍구: 공이 드럼 전체를 튀어다니게
      v.x += (Math.random() - 0.5) * turbulence * dt
      v.y += (Math.random() - 0.5) * turbulence * dt
      v.z += (Math.random() - 0.5) * turbulence * dt
      v.y -= 3.2 * dt // 중력
      if (p.y < -R * 0.65) v.y += (phase === Phase.Drawing ? 30 : 20) * dt // 바닥에서 위로 쏘아올림
      const vl = v.length()
      if (vl > 2.4) v.multiplyScalar(2.4 / vl)
      // 소용돌이: y축 회전 성분 추가
      const tangent = new THREE.Vector3(-p.z, 0, p.x).normalize().multiplyScalar(swirl * dt)
      p.addScaledVector(v, dt * speed).add(tangent)
      const len = p.length()
      if (len > R - BALL) {
        p.multiplyScalar((R - BALL) / len)
        v.reflect(p.clone().normalize()).multiplyScalar(0.95)
      }
      dummy.position.copy(p)
      const s = phase === Phase.Drawing ? 1.15 : 1
      dummy.scale.setScalar(s)
      dummy.updateMatrix()
      m.setMatrixAt(i, dummy.matrix)
    }
    m.count = count
    m.instanceMatrix.needsUpdate = true
  })

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, MAX_BALLS]} frustumCulled={false}>
      <sphereGeometry args={[BALL, 16, 16]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}

function Drum({ phase }: { phase: Phase }) {
  const g = useRef<THREE.Group>(null!)
  const color = PHASE_COLOR[phase]
  useFrame((_, dt) => {
    const spin = phase === Phase.Drawing ? 5.5 : 1.3
    g.current.rotation.y += dt * spin
    g.current.rotation.x += dt * spin * 0.6
  })
  return (
    <group>
      <group ref={g}>
        <mesh>
          <icosahedronGeometry args={[R, 4]} />
          <meshPhysicalMaterial color={color} transparent opacity={0.05} roughness={0} metalness={0.1} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
        <lineSegments>
          <wireframeGeometry args={[new THREE.IcosahedronGeometry(R, 1)]} />
          <lineBasicMaterial color={color} transparent opacity={0.45} toneMapped={false} />
        </lineSegments>
      </group>
    </group>
  )
}

/** 중앙 코어: 상금. 추첨 중 빠르게 맥동, 확정 시 황금으로 부풀어오른다 */
function Core({ phase, celebrate }: { phase: Phase; celebrate: boolean }) {
  const m = useRef<THREE.Mesh>(null!)
  const mat = useRef<THREE.MeshStandardMaterial>(null!)
  const target = useMemo(() => new THREE.Color(), [])
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime
    const pulse = phase === Phase.Drawing ? 0.35 + Math.sin(t * 9) * 0.1 : 0.3 + Math.sin(t * 2) * 0.04
    const big = celebrate ? 1.1 : pulse
    m.current.scale.setScalar(THREE.MathUtils.lerp(m.current.scale.x, big, dt * 4))
    target.set(celebrate ? '#ffd166' : PHASE_COLOR[phase])
    mat.current.emissive.lerp(target, dt * 3)
    mat.current.emissiveIntensity = celebrate ? 3.5 : phase === Phase.Drawing ? 2.4 : 1.6
  })
  return (
    <mesh ref={m}>
      <sphereGeometry args={[1, 48, 48]} />
      <meshStandardMaterial ref={mat} color="#111" emissive="#4ff0e6" emissiveIntensity={1.6} roughness={0.3} toneMapped={false} />
    </mesh>
  )
}

function Rig({ phase }: { phase: Phase }) {
  const ctrl = useRef<any>(null)
  useFrame(() => {
    if (ctrl.current) ctrl.current.autoRotateSpeed = phase === Phase.Drawing ? 8 : 1.5
  })
  return <OrbitControls ref={ctrl} enableZoom={false} enablePan={false} autoRotate minPolarAngle={0.9} maxPolarAngle={2.1} />
}

export default function LotteryScene(props: SceneProps) {
  const { phase, celebrate } = props
  return (
    <Canvas dpr={[1, 1.6]} camera={{ position: [0, 1.8, 9.5], fov: 42 }} gl={{ antialias: false, powerPreference: 'high-performance' }}>
      <color attach="background" args={['#05060c']} />
      <fog attach="fog" args={['#05060c', 12, 24]} />
      <ambientLight intensity={0.35} />
      <pointLight position={[6, 6, 6]} intensity={40} color="#4ff0e6" />
      <pointLight position={[-6, -3, -4]} intensity={30} color="#a56bff" />
      <pointLight position={[0, -6, 4]} intensity={20} color="#ff9a3c" />

      <Stars radius={60} depth={30} count={2500} factor={3} saturation={0.6} fade speed={phase === Phase.Drawing ? 3 : 0.6} />

      <Float speed={1.2} rotationIntensity={0.15} floatIntensity={0.6}>
        <Drum phase={phase} />
        <Balls {...props} />
        <Core phase={phase} celebrate={celebrate} />
      </Float>

      <Sparkles count={celebrate ? 400 : 90} scale={celebrate ? 9 : 6} size={celebrate ? 8 : 3} speed={celebrate ? 2 : 0.4} color={celebrate ? '#ffd166' : '#8de8ff'} />

      <EffectComposer>
        <Bloom mipmapBlur intensity={celebrate ? 2.2 : 1.25} luminanceThreshold={0.25} luminanceSmoothing={0.4} />
        <Vignette eskil={false} offset={0.15} darkness={0.85} />
      </EffectComposer>
      <Rig phase={phase} />
    </Canvas>
  )
}

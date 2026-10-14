import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '../../ui/hooks'
import { useApp, isDarkTheme } from '../../store'
import { cx } from '../../ui/primitives'

/**
 * "Field" — the ambient light layer that sits behind every glass surface.
 * Domain-warped fbm (flow) + a pointer lens (the field leans toward the cursor)
 * + a ripple pulse fired on navigation (window event `tickgrove:pulse`).
 */
const FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_t;
uniform vec3 u_a;
uniform vec3 u_b;
uniform vec3 u_bg;
uniform float u_k;
uniform vec2 u_m;
uniform vec3 u_pulse; // xy origin, z age (s)
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.0;float a=0.5;for(int i=0;i<5;i++){v+=a*noise(p);p*=2.03;a*=0.5;}return v;}
void main(){
  vec2 uv=gl_FragCoord.xy/u_res.xy;
  float asp=u_res.x/u_res.y;
  vec2 p=uv*vec2(asp,1.0)*1.35;
  vec2 m=u_m*vec2(asp,1.0)*1.35;
  float d=length(p-m);
  p+= (m-p)*0.18*exp(-d*d*2.2);              // lens toward pointer
  float t=u_t*0.045;
  vec2 q=vec2(fbm(p+t),fbm(p+vec2(5.2,1.3)-t));
  vec2 r=vec2(fbm(p+3.2*q+vec2(1.7,9.2)+t*1.4),fbm(p+3.2*q+vec2(8.3,2.8)-t));
  float f=fbm(p+2.6*r);
  vec3 col=mix(u_bg,u_a,smoothstep(0.38,0.98,f)*u_k);
  col=mix(col,u_b,smoothstep(0.58,1.0,r.x*f*1.7)*u_k*0.85);
  float rib=smoothstep(0.03,0.0,abs(fract(f*5.0+t*0.8)-0.5)-0.46);
  col+=rib*u_b*0.07*u_k;
  col+=u_a*0.10*u_k*exp(-d*d*6.0);           // pointer glow
  vec2 pp=u_pulse.xy*vec2(asp,1.0)*1.35;
  float ring=length(p-pp)-u_pulse.z*1.6;
  col+=u_b*0.22*u_k*exp(-ring*ring*60.0)*exp(-u_pulse.z*1.8);
  gl_FragColor=vec4(col,1.0);
}`
const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}`

function rgb(c: string): [number, number, number] {
  const m = c.trim().replace('#', '')
  const n = parseInt(m.length === 3 ? m.split('').map((x) => x + x).join('') : m.slice(0, 6), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export const pulseField = (x = 0.5, y = 0.5) => window.dispatchEvent(new CustomEvent('tickgrove:pulse', { detail: { x, y } }))

export default function Shader({ className, intensity = 1, interactive = false }: { className?: string; intensity?: number; interactive?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const reduced = useReducedMotion()
  const theme = useApp((s) => s.theme)
  const [noGL, setNoGL] = useState(false)
  useEffect(() => {
    const c = ref.current!
    const gl = c.getContext('webgl', { antialias: false, premultipliedAlpha: false, powerPreference: 'low-power' })
    if (!gl) return setNoGL(true)
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return setNoGL(true)
    gl.useProgram(prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const u = (n: string) => gl.getUniformLocation(prog, n)
    let colorsSet = false
    const setColors = () => {
      // read after <html data-theme> is applied (parent effects run after child effects)
      const css = getComputedStyle(document.documentElement)
      gl.uniform3fv(u('u_a'), rgb(css.getPropertyValue('--aura-1')))
      gl.uniform3fv(u('u_b'), rgb(css.getPropertyValue('--aura-2')))
      gl.uniform3fv(u('u_bg'), rgb(css.getPropertyValue('--bg')))
      gl.uniform1f(u('u_k'), intensity * Number(css.getPropertyValue('--aura-k') || 1) * (isDarkTheme(theme) ? 1 : 0.9))
      colorsSet = true
    }
    const mouse = { x: 0.7, y: 0.6, tx: 0.7, ty: 0.6 }
    const pulse = { x: 0.5, y: 0.5, at: -100 }
    const onMove = (e: PointerEvent) => {
      const r = c.getBoundingClientRect()
      mouse.tx = (e.clientX - r.left) / r.width
      mouse.ty = 1 - (e.clientY - r.top) / r.height
    }
    const onPulse = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {}
      pulse.x = d.x ?? 0.5
      pulse.y = 1 - (d.y ?? 0.5)
      pulse.at = performance.now()
      if (reduced) draw(performance.now())
    }
    if (interactive && !reduced) window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('tickgrove:pulse', onPulse)
    let raf = 0
    let visible = true
    let last = 0
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
    io.observe(c)
    const start = performance.now()
    const draw = (now: number) => {
      if (!colorsSet) setColors()
      const dpr = Math.min(window.devicePixelRatio, 1.5) * 0.5 // soft field: half-res is enough
      const w = Math.max(1, Math.floor(c.clientWidth * dpr))
      const h = Math.max(1, Math.floor(c.clientHeight * dpr))
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
        gl.viewport(0, 0, w, h)
      }
      mouse.x += (mouse.tx - mouse.x) * 0.06 // damped follow
      mouse.y += (mouse.ty - mouse.y) * 0.06
      gl.uniform2f(u('u_res'), w, h)
      gl.uniform1f(u('u_t'), reduced ? 14 : (now - start) / 1000)
      gl.uniform2f(u('u_m'), mouse.x, mouse.y)
      gl.uniform3f(u('u_pulse'), pulse.x, pulse.y, reduced ? 100 : (now - pulse.at) / 1000)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (!visible || document.hidden || now - last < 33) return // ~30fps cap, paused when hidden
      last = now
      draw(now)
    }
    if (reduced) requestAnimationFrame(draw)
    else raf = requestAnimationFrame(frame)
    const onResize = () => reduced && requestAnimationFrame(draw)
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('tickgrove:pulse', onPulse)
      window.removeEventListener('resize', onResize)
    }
  }, [reduced, theme, intensity, interactive])
  if (noGL) return <div className={cx(className, 'field-fallback')} aria-hidden />
  return <canvas ref={ref} className={className} aria-hidden />
}

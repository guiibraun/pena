// Aurora: slow flowing ribbons of light. Fill, animated.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @time */
uniform float u_time;
/** @label Background @color @default #050816 */
uniform vec3 u_bg;
/** @label Color 1 @color @default #22D3EE */
uniform vec3 u_c1;
/** @label Color 2 @color @default #A855F7 */
uniform vec3 u_c2;
/** @label Color 3 @color @default #34D399 */
uniform vec3 u_c3;
/** @label Scale @default 1.4 @range 0.3, 5 */
uniform float u_scale;
/** @label Speed @default 0.5 @range 0, 3 */
uniform float u_speed;
/** @label Grain @default 0.04 @range 0, 0.2 */
uniform float u_grain;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
  return s;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 p = uv * vec2(u_resolution.x / u_resolution.y, 1.0) * u_scale;
  float t = u_time * u_speed * 0.15;
  float a = fbm(p + vec2(t, -0.5 * t));
  float b = fbm(p * 1.3 + 1.7 * a + vec2(-0.7 * t, t));
  float c = fbm(p * 0.7 + b + t);
  vec3 col = u_bg;
  col = mix(col, u_c1, smoothstep(0.35, 0.8, b) * (0.4 + 0.6 * uv.y));
  col = mix(col, u_c2, smoothstep(0.45, 0.9, c) * 0.85);
  col = mix(col, u_c3, smoothstep(0.5, 0.95, a * b * 1.8) * 0.9);
  col += (hash(gl_FragCoord.xy + fract(u_time)) - 0.5) * u_grain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}

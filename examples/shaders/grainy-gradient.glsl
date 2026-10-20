// Grainy gradient: four soft color blobs, warped and grainy. Fill.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @label Color 1 @color @default #FF6B6B */
uniform vec3 u_c1;
/** @label Color 2 @color @default #FFD166 */
uniform vec3 u_c2;
/** @label Color 3 @color @default #4D96FF */
uniform vec3 u_c3;
/** @label Color 4 @color @default #9B5DE5 */
uniform vec3 u_c4;
/** @label Warp @default 0.35 @range 0, 1 */
uniform float u_warp;
/** @label Seed @default 3 @range 0, 100 */
uniform float u_seed;
/** @label Grain @default 0.08 @range 0, 0.3 */
uniform float u_grain;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 w = vec2(noise(uv * 3.0 + u_seed), noise(uv * 3.0 - u_seed)) - 0.5;
  vec2 q = uv + w * u_warp;
  vec3 col = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 c = vec2(hash(vec2(fi, u_seed)), hash(vec2(u_seed, fi + 4.0)));
    float k = 1.0 / (0.02 + pow(distance(q, c), 2.2));
    vec3 tone = i == 0 ? u_c1 : i == 1 ? u_c2 : i == 2 ? u_c3 : u_c4;
    col += tone * k;
    total += k;
  }
  col /= total;
  col += (hash(gl_FragCoord.xy) - 0.5) * u_grain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
